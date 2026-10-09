/**
 * Stateless MCP client for registered servers (#331). Wraps the official v2
 * SDK pinned to spec 2026-07-28. The issue's scope is that revision only, no
 * older versions, so a 2025-era server is refused at negotiation. One client
 * per operation, no session state. An "http" row dials its url; a "hosted"
 * row runs the same transport with every request routed through the Lambda
 * host (hosted.ts). A "machine" row never dials: the daemon on the user's
 * computer runs the MCP client for its stdio server, and core relays the
 * listing and each call over the machine socket; on a lambda sandbox the VM
 * runs it and core relays each request over HTTP (sandbox.ts). The version
 * probe and tool listings are cached in-process per server row (keyed by row version, resolved headers,
 * oauth config and a lambda row's sandbox, so an edit is a cache miss), honoring the ttlMs the spec
 * puts on cacheable results. A row with oauth mints a bearer token (oauth.ts)
 * at connect time.
 */

import {
  Client,
  isCallToolResult,
  isSpecType,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type DiscoverResult,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/client";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { cacheDigest } from "../../shared/cache-digest.ts";
import type { AgentMcpEntry } from "../../shared/domain/agent-config.ts";
import {
  delegatedChain,
  type Principal,
  type PrincipalLink,
} from "../../shared/domain/principal.ts";
import {
  authorizationHeaderName,
  ENV_PLACEHOLDER_PATTERN,
  type McpOauth,
  type McpRecord,
} from "../../shared/domain/mcp.ts";
import {
  runMachineMcpCall,
  runMachineMcpList,
} from "../sandbox/machine-executor.ts";
import { mergeSandboxEnv } from "../sandbox/utils.ts";
import { publicHostFetch } from "../../shared/http.ts";
import { logInfo } from "../../shared/log.ts";
import { withImageLimits } from "../tools/utils.ts";
import { HOSTED_MCP_URL, hostedMcpFetch } from "./hosted.ts";
import {
  clearMcpOauthTokens,
  DEFAULT_OAUTH_TOKEN_URL,
  mcpAccessToken,
  type ResolvedMcpOauth,
} from "./oauth.ts";
import { sandboxMcpRequest, type SandboxMcpTarget } from "./sandbox.ts";

const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_AGENT_ID_HEADER = "X-Broods-Agent-Id";
export const MCP_PRINCIPAL_HEADER = "X-Broods-Principal";
// Core alone names the caller. Header names are case-insensitive on the wire,
// where a tenant's own copy would be joined with the real one.
const PRINCIPAL_HEADER_NAMES: ReadonlySet<string> = new Set([
  MCP_AGENT_ID_HEADER.toLowerCase(),
  MCP_PRINCIPAL_HEADER.toLowerCase(),
]);

const CLIENT_INFO = { name: "broods-core", version: "1.0.0" };
const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 256;
const MAX_TTL_MS = 60 * 60_000;

// A rate-limited tool call waits out the window and tries again before the
// model hears about it: a step's parallel calls to one server trip a per-minute
// cap together, and the model's retry would only trip it again. The wait is the
// one the server's message names, like Firecrawl's "please retry after 47s",
// else a growing pause.
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_PATTERN = /\b429\b|rate limit/i;
const RATE_LIMIT_WAIT_PATTERN =
  /(?:retry after|try again in) (\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)\b/i;
const RATE_LIMIT_BACKOFF_MS = 2_000;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

const discoverCache = new Map<string, CachedDiscover>();
const toolListCache = new Map<string, CachedListing>();
let testOverrides: McpTestOverrides | null = null;

/** One server's resolved connection: the row plus the final request headers. */
export interface McpConnection {
  record: McpRecord;
  headers: Record<string, string>;
  /** Who is calling, on every request; not part of the listing cache key. */
  principalHeaders?: Record<string, string>;
  /** The agent whose run calls; a hosted row runs as `accountId:agentId`. Unset on an account-surface probe. */
  agentId?: string;
  /** Set when the row carries oauth; the Authorization header is minted from it. */
  oauth?: ResolvedMcpOauth;
  /** A one-shot probe: skips the listing and version caches so it never evicts a saved row's entries. */
  uncached?: boolean;
  /** Set when a "machine" row names a lambda sandbox: its VM runs the server, not a daemon. */
  sandbox?: SandboxMcpTarget;
}

/** Per-call options. onCpuUsec fires only for hosted rows, off the Lambda's
 * terminal frame, so the harness can meter the run's compute. */
export interface McpCallOptions {
  abortSignal?: AbortSignal;
  onCpuUsec?: (cpuUsec: number) => void;
}

interface CachedDiscover {
  discover: DiscoverResult;
  expiresAt: number;
}

interface CachedListing {
  tools: Promise<Tool[]>;
  expiresAt: number;
}

type McpTestOverrides = {
  listTools?: (connection: McpConnection) => Promise<Tool[]>;
  callTool?: (
    connection: McpConnection,
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<CallToolResult>;
};

/**
 * Call one remote tool for the agent loop. An isError result surfaces as a
 * thrown Error so the harness records a tool failure and feeds the message
 * back to the model, instead of handing it an error payload as data.
 */
export async function callMcpTool(
  connection: McpConnection,
  toolName: string,
  args: Record<string, unknown>,
  options: McpCallOptions = {},
): Promise<unknown> {
  let result = await callMcpToolResult(connection, toolName, args, options);
  for (
    let attempt = 1;
    result.isError && attempt <= RATE_LIMIT_RETRIES;
    attempt += 1
  ) {
    const waitMs = rateLimitWaitMs(renderContent(result.content), attempt);
    if (waitMs === null) break;
    logInfo("MCP tool rate limited, retrying", {
      server: connection.record.name,
      tool: toolName,
      attempt: attempt,
      waitMs: waitMs,
    });
    await sleep(waitMs, options.abortSignal);
    if (options.abortSignal?.aborted) break;
    result = await callMcpToolResult(connection, toolName, args, options);
  }
  if (result.isError) {
    throw new Error(
      `MCP tool ${connection.record.name}.${toolName} failed: ${renderContent(result.content)}`,
    );
  }

  // An image is something the model can look at, so a result carrying one goes
  // through as content parts instead of being flattened to text.
  if (result.content.some((block): boolean => block.type === "image")) {
    return imageContentOutput(result.content, result.structuredContent);
  }

  return result.structuredContent ?? renderContent(result.content);
}

/**
 * Call one remote tool and return the raw result, isError included. Stateless:
 * a fresh client and POST per call.
 */
export async function callMcpToolResult(
  connection: McpConnection,
  toolName: string,
  args: Record<string, unknown>,
  options: McpCallOptions = {},
): Promise<CallToolResult> {
  if (testOverrides?.callTool) {
    return await testOverrides.callTool(connection, toolName, args);
  }
  if (connection.record.transport === "machine") {
    // The daemon's or VM's own SDK client produced this, but it crossed a
    // socket and the relay only checks the envelope, so the payload is checked here.
    const relayed = connection.sandbox
      ? await sandboxMcpRequest(
          connection.sandbox,
          connection.record.name,
          {
            method: "tools/call",
            params: { name: toolName, arguments: args },
          },
          options.abortSignal,
        )
      : await runMachineMcpCall(connection.record, toolName, args);
    if (!isCallToolResult(relayed)) {
      throw new Error(
        `MCP tool ${connection.record.name}.${toolName} answered with a result this SDK does not accept`,
      );
    }

    return relayed;
  }

  return await withClient(
    connection,
    (client) =>
      client.callTool(
        { name: toolName, arguments: args },
        options.abortSignal ? { signal: options.abortSignal } : {},
      ),
    options.onCpuUsec,
  );
}

/**
 * List a server's tools, from the per-server cache when fresh. The cache
 * holds the in-flight promise, so concurrent cold runs share one listing;
 * its TTL is the listing's own ttlMs, clamped. A hosted server boots its
 * bundle for a cold listing, so onCpuUsec meters that too.
 */
export async function listMcpTools(
  connection: McpConnection,
  onCpuUsec?: (cpuUsec: number) => void,
): Promise<Tool[]> {
  if (testOverrides?.listTools) {
    return await testOverrides.listTools(connection);
  }
  // Uncached: the daemon answers from the live server process. A lambda
  // sandbox row is cached like a remote one, so a run does not wake its VM
  // just to learn a listing that changes only with the row.
  if (connection.record.transport === "machine" && !connection.sandbox) {
    const tools = await runMachineMcpList(connection.record);
    if (!tools.every((tool) => isSpecType.Tool(tool))) {
      throw new Error(
        `MCP server ${connection.record.name} listed a tool this SDK does not accept`,
      );
    }

    return tools;
  }
  const fetchListing = async (): Promise<ListToolsResult> => {
    if (!connection.sandbox) {
      return await withClient(
        connection,
        (client) => client.listTools(),
        onCpuUsec,
      );
    }
    const listing = await sandboxMcpRequest(
      connection.sandbox,
      connection.record.name,
      { method: "tools/list", params: {} },
    );
    if (!isSpecType.ListToolsResult(listing)) {
      throw new Error(
        `MCP server ${connection.record.name} answered tools/list with a result this SDK does not accept`,
      );
    }

    return listing;
  };
  if (connection.uncached) {
    return (await fetchListing()).tools;
  }
  const key = cacheKeyFor(connection);
  const cached = toolListCache.get(key);
  if (cached) {
    if (cached.expiresAt > Date.now()) return await cached.tools;
    toolListCache.delete(key);
  }
  const pending = fetchListing().then((result) => {
    const entry = toolListCache.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + clampTtlMs(result.ttlMs);
    }

    return result.tools;
  });
  pending.catch(() => toolListCache.delete(key));
  pruneCache(toolListCache);
  toolListCache.set(key, {
    tools: pending,
    expiresAt: Date.now() + DEFAULT_TTL_MS,
  });

  return await pending;
}

/**
 * Build the connection for a server row: row headers and oauth overlaid with
 * the agent config's (those resolved their ${NAME} refs at sync). A value
 * still carrying a placeholder never reaches the wire, and neither does a
 * header claiming one of the principal names. The principal names the agent
 * whose run calls, unset on an account-surface probe.
 */
export function mcpConnection(
  record: McpRecord,
  configHeaders: Record<string, string> | undefined,
  configOauth?: AgentMcpEntry["oauth"],
  principal?: Principal,
): McpConnection {
  // Header names are case-insensitive: the agent's spelling replaces the row's.
  const overridden = new Set(
    Object.keys(configHeaders ?? {}).map((name) => name.toLowerCase()),
  );
  const rowHeaders = Object.entries(record.headers ?? {}).filter(
    ([name]) => !overridden.has(name.toLowerCase()),
  );
  const headers: Record<string, string> = Object.fromEntries(
    [...rowHeaders, ...Object.entries(configHeaders ?? {})].filter(
      ([name]) => !PRINCIPAL_HEADER_NAMES.has(name.toLowerCase()),
    ),
  );
  for (const [name, value] of Object.entries(headers)) {
    if (ENV_PLACEHOLDER_PATTERN.test(value)) {
      throw new Error(
        `config.mcp.${record.serverId} header ${name} still carries a \${NAME} ref; set it in the agent config so it resolves at sync`,
      );
    }
  }
  const oauth = resolveOauth(record, configOauth);
  if (oauth) {
    const authorization = authorizationHeaderName(headers);
    if (authorization !== undefined) {
      throw new Error(
        `config.mcp.${record.serverId} sets both an ${authorization} header and oauth; oauth mints that header itself`,
      );
    }
  }

  return {
    record: record,
    headers: headers,
    agentId: principal?.agentId,
    ...(oauth !== undefined ? { oauth: oauth } : {}),
    ...(principal ? { principalHeaders: principalHeaders(principal) } : {}),
  };
}

/** Every header one request carries: row and config headers, the principal, then a minted bearer. */
export async function mcpRequestHeaders(
  connection: McpConnection,
): Promise<Record<string, string>> {
  // Minted (or served from the token cache) per connect: clients are
  // per-operation, so every request carries a token outside its refresh
  // margin instead of a static header that expires mid-conversation.
  return {
    ...connection.headers,
    ...connection.principalHeaders,
    ...(connection.oauth
      ? {
          Authorization: `Bearer ${await mcpAccessToken(connection.record.name, connection.oauth)}`,
        }
      : {}),
  };
}

/** Tests only: stub the network edge, and drop any cached state. */
export function setMcpForTests(overrides: McpTestOverrides | null): void {
  testOverrides = overrides;
  discoverCache.clear();
  toolListCache.clear();
  clearMcpOauthTokens();
}

/**
 * One cache identity per server row version, resolved header set, oauth
 * config and, for a lambda row, what its sandbox boots (image or snapshot),
 * installs and starts the server with, so a row, credential or sandbox edit is
 * a miss instead of stale data for a TTL. These ride the key only as a
 * process-keyed digest: a Map key lives process-wide for up to an hour and
 * must not hold secrets in clear. A hosted row adds the agent: its answers
 * come from that agent's own child. A lambda row's listing does not depend on
 * which VM answered, so every conversation shares it.
 */
export function cacheKeyFor(connection: McpConnection): string {
  const headers = Object.entries(connection.headers).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  const sandbox = connection.sandbox?.config;
  const server = sandbox
    ? [
        sandbox.image ?? null,
        sandbox.snapshot ?? null,
        sandbox.onCreate ?? null,
        sandbox.onResume ?? null,
        mergeSandboxEnv(sandbox.envVars, undefined),
      ]
    : null;
  const identity = cacheDigest(
    JSON.stringify([headers, connection.oauth ?? null, server]),
  );
  const agent =
    connection.record.transport === "hosted" ? (connection.agentId ?? "") : "";

  return `${connection.record.serverId}:${connection.record.updatedAt}:${identity}:${agent}`;
}

/** The chain as a remote server sees it: ids and kinds, never a display name. The ledger and the OPA input keep the name. */
function chainWithoutNames(chain: PrincipalLink[]): PrincipalLink[] {
  return chain.map((link): PrincipalLink => {
    if (link.kind !== "user") return link;
    const { name: _name, ...rest } = link;

    return rest;
  });
}

/** A cacheable result's ttlMs (typed unknown by the SDK), defaulted and clamped. */
function clampTtlMs(ttlMs: unknown): number {
  return Math.min(
    typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS,
    MAX_TTL_MS,
  );
}

/**
 * Connect a fresh pinned client, adopting the cached version probe when one
 * is fresh (zero extra round trips); a stale adoption falls back to one fresh
 * negotiation.
 */
async function connectClient(
  connection: McpConnection,
  key: string,
  onCpuUsec?: (cpuUsec: number) => void,
): Promise<Client> {
  const hosted = connection.record.transport === "hosted";
  if (!hosted && !connection.record.url) {
    throw new Error(
      `MCP server ${connection.record.name} has no url to connect to`,
    );
  }
  const makeClient = async (
    discover: DiscoverResult | undefined,
  ): Promise<Client> => {
    const headers = await mcpRequestHeaders(connection);
    const transport = new StreamableHTTPClientTransport(
      new URL(hosted ? HOSTED_MCP_URL : connection.record.url!),
      {
        requestInit: { headers: headers },
        // A tenant url is dialed from inside the cluster, so it gets the same
        // resolve, refuse-private and pin treatment as a model endpoint.
        fetch: hosted ? hostedMcpFetch(connection, onCpuUsec) : publicHostFetch,
      },
    );
    const client = new Client(CLIENT_INFO, {
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    });
    await client.connect(
      transport,
      discover ? { prior: { kind: "modern", discover: discover } } : {},
    );

    return client;
  };
  if (connection.uncached) return await makeClient(undefined);
  const cached = discoverCache.get(key);
  const fresh = cached !== undefined && cached.expiresAt > Date.now();
  if (cached && !fresh) discoverCache.delete(key);
  const prior = fresh ? cached.discover : undefined;
  let client: Client;
  try {
    client = await makeClient(prior);
  } catch (error) {
    if (!prior) throw error;
    discoverCache.delete(key);
    client = await makeClient(undefined);
  }
  const discover = client.getDiscoverResult();
  if (discover && !discoverCache.has(key)) {
    pruneCache(discoverCache);
    discoverCache.set(key, {
      discover: discover,
      expiresAt: Date.now() + clampTtlMs(discover.ttlMs),
    });
  }

  return client;
}

/**
 * A result's content as model content parts: images as image data, within the
 * limits on what one result may show, the rest as text, and any
 * structuredContent as one more JSON text part.
 */
function imageContentOutput(
  content: CallToolResult["content"],
  structured: CallToolResult["structuredContent"],
): ToolResultOutput {
  return {
    type: "content",
    value: withImageLimits([
      ...content.map((block) =>
        block.type === "image"
          ? {
              type: "image-data" as const,
              data: block.data,
              mediaType: block.mimeType,
            }
          : { type: "text" as const, text: renderContent([block]) },
      ),
      ...(structured
        ? [{ type: "text" as const, text: JSON.stringify(structured) }]
        : []),
    ]),
  };
}

/** The agent id, and its chain when known (base64url JSON, ids and kinds only), so a server can authorize per agent. */
function principalHeaders(principal: Principal): Record<string, string> {
  const chain = delegatedChain(principal);

  return {
    [MCP_AGENT_ID_HEADER]: principal.agentId,
    ...(chain
      ? {
          [MCP_PRINCIPAL_HEADER]: Buffer.from(
            JSON.stringify(chainWithoutNames(chain)),
          ).toString("base64url"),
        }
      : {}),
  };
}

/** Drop oldest entries so a long-lived core process stays bounded. */
function pruneCache(cache: Map<string, unknown>): void {
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** How long a rate-limited call waits before its retry; null when the failure is something else. */
function rateLimitWaitMs(message: string, attempt: number): number | null {
  if (!RATE_LIMIT_PATTERN.test(message)) return null;
  const [, amount, unit] = RATE_LIMIT_WAIT_PATTERN.exec(message) ?? [];
  const askedMs =
    amount && unit
      ? Number(amount) * (unit.toLowerCase().startsWith("m") ? 1 : 1000)
      : RATE_LIMIT_BACKOFF_MS * 2 ** (attempt - 1);

  return Math.min(Math.ceil(askedMs), MAX_RATE_LIMIT_WAIT_MS);
}

/**
 * Text view of a result's content. Non-text blocks are named instead of
 * silently dropped, so an image-only result never reads as an empty success.
 */
function renderContent(content: CallToolResult["content"]): string {
  return content
    .map((block): string => {
      switch (block.type) {
        case "text":
          return block.text;
        case "image":
        case "audio":
          return `[${block.type} content (${block.mimeType}) omitted]`;
        case "resource_link":
          return `[resource link: ${block.uri}]`;
        case "resource":
          return `[embedded resource: ${block.resource.uri}]`;
        default:
          return `[unsupported ${(block as { type: string }).type} content omitted]`;
      }
    })
    .join("\n");
}

/**
 * Merge the row's oauth credentials with the agent config's overrides (config
 * wins per field) and refuse values still carrying ${NAME} refs, mirroring
 * the header rule: secrets resolve into the agent config at sync, never on
 * the row. tokenUrl comes from the row alone: registration is the one place
 * that checked it is https, and the agent config is only a string record.
 */
function resolveOauth(
  record: McpRecord,
  configOauth: AgentMcpEntry["oauth"],
): ResolvedMcpOauth | undefined {
  if (record.oauth === undefined && configOauth === undefined) return undefined;
  const merged: Partial<McpOauth> = { ...record.oauth, ...configOauth };
  const resolved = (
    field: "clientId" | "clientSecret" | "refreshToken",
  ): string => {
    const value = merged[field];
    if (value === undefined || value === "") {
      throw new Error(
        `config.mcp.${record.serverId} oauth is missing ${field}`,
      );
    }
    if (ENV_PLACEHOLDER_PATTERN.test(value)) {
      throw new Error(
        `config.mcp.${record.serverId} oauth ${field} still carries a \${NAME} ref; set it in the agent config so it resolves at sync`,
      );
    }

    return value;
  };

  return {
    clientId: resolved("clientId"),
    clientSecret: resolved("clientSecret"),
    refreshToken: resolved("refreshToken"),
    tokenUrl: record.oauth?.tokenUrl ?? DEFAULT_OAUTH_TOKEN_URL,
  };
}

/** Waits `ms`, or less when the signal aborts first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function withClient<T>(
  connection: McpConnection,
  operation: (client: Client) => Promise<T>,
  onCpuUsec?: (cpuUsec: number) => void,
): Promise<T> {
  const client = await connectClient(
    connection,
    cacheKeyFor(connection),
    onCpuUsec,
  );
  try {
    return await operation(client);
  } finally {
    await client.close().catch(() => {});
  }
}
