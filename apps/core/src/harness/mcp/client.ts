/**
 * Stateless MCP client for registered servers (#331). Wraps the official v2
 * SDK pinned to spec 2026-07-28 — the issue's scope is that revision only, no
 * older versions, so a 2025-era server is refused at negotiation. One client
 * per operation, no session state. An "http" row dials its url; a "hosted"
 * row runs the same transport with every request routed through the Lambda
 * host (hosted.ts). The version probe and tool listings are cached in-process
 * per server row (keyed by row version, resolved headers and oauth config, so
 * an edit is a cache miss), honoring the ttlMs the spec puts on cacheable
 * results. A row with oauth mints a bearer token (oauth.ts) at connect time.
 */

import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type DiscoverResult,
  type Tool,
} from "@modelcontextprotocol/client";
import {
  ENV_PLACEHOLDER_PATTERN,
  type McpOauth,
  type McpRecord,
} from "../../shared/domain/mcp.ts";
import { HOSTED_MCP_URL, hostedMcpFetch } from "./hosted.ts";
import {
  clearMcpOauthTokens,
  DEFAULT_OAUTH_TOKEN_URL,
  mcpAccessToken,
  type ResolvedMcpOauth,
} from "./oauth.ts";

const MCP_PROTOCOL_VERSION = "2026-07-28";

const CLIENT_INFO = { name: "broods-core", version: "1.0.0" };
const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 256;
const MAX_TTL_MS = 60 * 60_000;

const discoverCache = new Map<string, CachedDiscover>();
const toolListCache = new Map<string, CachedListing>();
let testOverrides: McpTestOverrides | null = null;

/** One server's resolved connection: the row plus the final request headers. */
export interface McpConnection {
  record: McpRecord;
  headers: Record<string, string>;
  /** Set when the row carries oauth; the Authorization header is minted from it. */
  oauth?: ResolvedMcpOauth;
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
  const result = await callMcpToolResult(connection, toolName, args, options);
  if (result.isError) {
    throw new Error(
      `MCP tool ${connection.record.name}.${toolName} failed: ${renderContent(result.content)}`,
    );
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
  const key = cacheKeyFor(connection);
  const cached = toolListCache.get(key);
  if (cached) {
    if (cached.expiresAt > Date.now()) return await cached.tools;
    toolListCache.delete(key);
  }
  const pending = withClient(
    connection,
    (client) => client.listTools(),
    onCpuUsec,
  ).then((result) => {
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
 * still carrying a placeholder never reaches the wire.
 */
export function mcpConnection(
  record: McpRecord,
  configHeaders: Record<string, string> | undefined,
  configOauth?: Partial<McpOauth>,
): McpConnection {
  const headers: Record<string, string> = {
    ...record.headers,
    ...configHeaders,
  };
  for (const [name, value] of Object.entries(headers)) {
    if (ENV_PLACEHOLDER_PATTERN.test(value)) {
      throw new Error(
        `config.mcp.${record.serverId} header ${name} still carries a \${NAME} ref; set it in the agent config so it resolves at sync`,
      );
    }
  }
  const oauth = resolveOauth(record, configOauth);
  if (oauth) {
    const authorization = Object.keys(headers).find(
      (name) => name.toLowerCase() === "authorization",
    );
    if (authorization !== undefined) {
      throw new Error(
        `config.mcp.${record.serverId} sets both an ${authorization} header and oauth; oauth mints that header itself`,
      );
    }
  }

  return {
    record: record,
    headers: headers,
    ...(oauth !== undefined ? { oauth: oauth } : {}),
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
 * One cache identity per server row version, resolved header set and oauth
 * config, so a row edit or a credential change is a miss instead of stale
 * data for a TTL.
 */
function cacheKeyFor(connection: McpConnection): string {
  const headers = Object.entries(connection.headers).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );

  return `${connection.record.serverId}:${connection.record.updatedAt}:${JSON.stringify(headers)}:${JSON.stringify(connection.oauth ?? null)}`;
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
    // Minted (or served from the token cache) per connect: clients are
    // per-operation, so every request carries a token outside its refresh
    // margin instead of a static header that expires mid-conversation.
    const headers = connection.oauth
      ? {
          ...connection.headers,
          Authorization: `Bearer ${await mcpAccessToken(connection.record.name, connection.oauth)}`,
        }
      : connection.headers;
    const transport = new StreamableHTTPClientTransport(
      new URL(hosted ? HOSTED_MCP_URL : connection.record.url!),
      {
        requestInit: { headers: headers },
        ...(hosted
          ? { fetch: hostedMcpFetch(connection.record, onCpuUsec) }
          : {}),
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

/** Drop oldest entries so a long-lived core process stays bounded. */
function pruneCache(cache: Map<string, unknown>): void {
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
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
 * Merge the row's oauth with the agent config's overrides (config wins per
 * field) and refuse values still carrying ${NAME} refs, mirroring the header
 * rule: secrets resolve into the agent config at sync, never on the row.
 */
function resolveOauth(
  record: McpRecord,
  configOauth: Partial<McpOauth> | undefined,
): ResolvedMcpOauth | undefined {
  if (record.oauth === undefined && configOauth === undefined) return undefined;
  const merged: Partial<McpOauth> = { ...record.oauth, ...configOauth };
  for (const field of ["clientId", "clientSecret", "refreshToken"] as const) {
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
  }

  return {
    clientId: merged.clientId!,
    clientSecret: merged.clientSecret!,
    refreshToken: merged.refreshToken!,
    tokenUrl: merged.tokenUrl ?? DEFAULT_OAUTH_TOKEN_URL,
  };
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
