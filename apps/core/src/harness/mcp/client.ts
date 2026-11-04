// One stateless client per operation, pinned to MCP spec 2026-07-28: older servers are refused.
// A "machine" row never dials: the user's daemon or a lambda VM runs the client and core relays.

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
import { MAX_IMAGE_BYTES } from "../../shared/media-types.ts";
import { guardedFetch } from "../isolate/runner/pinned-fetch.mjs";
import {
  MAX_RESULT_IMAGES,
  withImageLimits,
  type ToolContentPart,
} from "../tools/utils.ts";
import { HOSTED_MCP_URL, hostedMcpFetch } from "./hosted.ts";
import {
  clearMcpOauthTokens,
  DEFAULT_OAUTH_TOKEN_URL,
  mcpAccessToken,
  type ResolvedMcpOauth,
} from "./oauth.ts";
import { MCP_PROTOCOL_VERSION } from "../../shared/mcp-protocol.ts";
import { sandboxMcpRequest, type SandboxMcpTarget } from "./sandbox.ts";

export const MCP_AGENT_ID_HEADER = "X-Broods-Agent-Id";
export const MCP_PRINCIPAL_HEADER = "X-Broods-Principal";
// Core alone names the caller; a tenant's copy in any letter case would join the real one.
const PRINCIPAL_HEADER_NAMES: ReadonlySet<string> = new Set([
  MCP_AGENT_ID_HEADER.toLowerCase(),
  MCP_PRINCIPAL_HEADER.toLowerCase(),
]);

const CLIENT_INFO = { name: "broods-core", version: "1.0.0" };
const DEFAULT_TTL_MS = 5 * 60_000;
const LINKED_IMAGE_TIMEOUT_MS = 30_000;
const MAX_CACHE_ENTRIES = 256;
const MAX_TTL_MS = 60 * 60_000;

// A step's parallel calls trip a per-minute cap together and a model retry would trip it again,
// so core waits what the message names ("retry after 47s"), else backs off, and retries itself.
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_PATTERN = /\b429\b|rate limit/i;
const RATE_LIMIT_WAIT_PATTERN =
  /(?:retry after|try again in) (\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)\b/i;
const RATE_LIMIT_BACKOFF_MS = 2_000;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

const discoverCache = new Map<string, CachedDiscover>();
const toolListCache = new Map<string, CachedListing>();
let testOverrides: McpTestOverrides | null = null;

export interface McpConnection {
  record: McpRecord;
  headers: Record<string, string>;
  principalHeaders?: Record<string, string>;
  agentId?: string;
  oauth?: ResolvedMcpOauth;
  uncached?: boolean;
  sandbox?: SandboxMcpTarget;
}

export interface McpCallOptions {
  abortSignal?: AbortSignal;
  onCpuUsec?: (cpuUsec: number) => void;
  onRetry?: (waitMs: number) => void;
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
    options.onRetry?.(waitMs);
    result = await callMcpToolResult(connection, toolName, args, options);
  }
  if (result.isError) {
    throw new Error(
      `MCP tool ${connection.record.name}.${toolName} failed: ${renderContent(result.content)}`,
    );
  }

  if (
    result.content.some(
      (block): boolean => block.type === "image" || isImageLink(block),
    )
  ) {
    return await imageContentOutput(result.content, result.structuredContent);
  }

  return result.structuredContent ?? renderContent(result.content);
}

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
    // The relay checks only the envelope, so the payload is validated here.
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

export async function listMcpTools(
  connection: McpConnection,
  onCpuUsec?: (cpuUsec: number) => void,
): Promise<Tool[]> {
  if (testOverrides?.listTools) {
    return await testOverrides.listTools(connection);
  }
  // A daemon answers live, uncached; a lambda VM's listing is cached so a run never wakes it.
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

export function mcpConnection(
  record: McpRecord,
  configHeaders: Record<string, string> | undefined,
  configOauth?: AgentMcpEntry["oauth"],
  principal?: Principal,
): McpConnection {
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

export async function mcpRequestHeaders(
  connection: McpConnection,
): Promise<Record<string, string>> {
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

export function setMcpForTests(overrides: McpTestOverrides | null): void {
  testOverrides = overrides;
  discoverCache.clear();
  toolListCache.clear();
  clearMcpOauthTokens();
}

// Digested: a key lives up to an hour and must not hold secrets in clear. A hosted row adds the
// agent, since its answers come from that agent's own child.
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

function chainWithoutNames(chain: PrincipalLink[]): PrincipalLink[] {
  return chain.map((link): PrincipalLink => {
    if (link.kind !== "user") return link;
    const { name: _name, ...rest } = link;

    return rest;
  });
}

function clampTtlMs(ttlMs: unknown): number {
  return Math.min(
    typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS,
    MAX_TTL_MS,
  );
}

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
        // Dialed from inside the cluster: resolve, refuse private addresses, pin.
        fetch: hosted ? hostedMcpFetch(connection, onCpuUsec) : publicHostFetch,
      },
    );
    // supportedProtocolVersions also pins the cached `prior` path, which ignores the `pin` mode.
    const client = new Client(CLIENT_INFO, {
      supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
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

async function imageContentOutput(
  content: CallToolResult["content"],
  structured: CallToolResult["structuredContent"],
): Promise<ToolResultOutput> {
  const links = new Set(
    content.filter(isImageLink).slice(0, MAX_RESULT_IMAGES),
  );
  const parts = await Promise.all(
    content.map(async (block): Promise<ToolContentPart[]> => {
      if (block.type === "image") {
        return [
          { type: "image-data", data: block.data, mediaType: block.mimeType },
        ];
      }
      const text: ToolContentPart = {
        type: "text",
        text: renderContent([block]),
      };
      const linked =
        isImageLink(block) && links.has(block)
          ? await linkedImage(block.uri, block.mimeType)
          : undefined;

      return linked ? [text, linked] : [text];
    }),
  );

  return {
    type: "content",
    value: withImageLimits([
      ...parts.flat(),
      ...(structured
        ? [{ type: "text" as const, text: JSON.stringify(structured) }]
        : []),
    ]),
  };
}

function isImageLink(
  block: CallToolResult["content"][number],
): block is Extract<
  CallToolResult["content"][number],
  { type: "resource_link" }
> & { mimeType: string } {
  return (
    block.type === "resource_link" &&
    block.mimeType?.startsWith("image/") === true &&
    /^https?:\/\//i.test(block.uri)
  );
}

async function linkedImage(
  uri: string,
  mediaType: string,
): Promise<ToolContentPart | undefined> {
  try {
    const response = await guardedFetch(uri, undefined, {
      binary: true,
      bodyLimitBytes: MAX_IMAGE_BYTES,
      timeoutMs: LINKED_IMAGE_TIMEOUT_MS,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`answered ${response.status}`);
    }

    const bytes = response.bodyBytes;

    return {
      type: "image-data",
      data: Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).toString("base64"),
      mediaType: mediaType,
    };
  } catch (err) {
    // The host only: a signed link carries its token in the path or query.
    logInfo("MCP image link could not be read", {
      host: URL.canParse(uri) ? new URL(uri).host : undefined,
      error: err instanceof Error ? err.message : String(err),
    });

    return undefined;
  }
}

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

function pruneCache(cache: Map<string, unknown>): void {
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function rateLimitWaitMs(message: string, attempt: number): number | null {
  if (!RATE_LIMIT_PATTERN.test(message)) return null;
  const [, amount, unit] = RATE_LIMIT_WAIT_PATTERN.exec(message) ?? [];
  const askedMs =
    amount && unit
      ? Number(amount) * (unit.toLowerCase().startsWith("m") ? 1 : 1000)
      : RATE_LIMIT_BACKOFF_MS * 2 ** (attempt - 1);

  return Math.min(Math.ceil(askedMs), MAX_RATE_LIMIT_WAIT_MS);
}

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
    // From the row alone: registration is the one place that checked it is https.
    tokenUrl: record.oauth?.tokenUrl ?? DEFAULT_OAUTH_TOKEN_URL,
  };
}

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
