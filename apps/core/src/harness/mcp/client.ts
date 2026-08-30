/**
 * Stateless MCP client for registered servers (#331). Wraps the official v2
 * SDK: one client per operation, no session state. An "http" row negotiates
 * the protocol automatically, so modern (2026-07-28) servers and pre-existing
 * legacy (2025-era initialize) servers both work; a "hosted" row runs the
 * same transport pinned modern — its stateless Lambda handler is our own
 * deploy contract. The era verdict and tool listings are cached in-process
 * per server row (keyed by row version and resolved headers, so an edit is a
 * cache miss), honoring the ttlMs the spec puts on cacheable results.
 */

import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type PriorDiscovery,
  type Tool,
} from "@modelcontextprotocol/client";
import {
  ENV_PLACEHOLDER_PATTERN,
  type McpRecord,
} from "../../shared/domain/mcp.ts";
import { HOSTED_MCP_URL, hostedMcpFetch } from "./hosted.ts";

const MCP_PROTOCOL_VERSION = "2026-07-28";

const CLIENT_INFO = { name: "broods-core", version: "1.0.0" };
const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 256;
const MAX_TTL_MS = 60 * 60_000;

const eraCache = new Map<string, CachedEra>();
const toolListCache = new Map<string, CachedListing>();
let testOverrides: McpTestOverrides | null = null;

/** One server's resolved connection: the row plus the final request headers. */
export interface McpConnection {
  record: McpRecord;
  headers: Record<string, string>;
}

/**
 * A cached negotiation verdict. A modern verdict expires at the discover
 * result's own ttlMs; a legacy one at the default TTL, so a server upgrade
 * is noticed by the next probe instead of never.
 */
interface CachedEra {
  expiresAt: number;
  prior: PriorDiscovery;
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
  options: { abortSignal?: AbortSignal } = {},
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
  options: { abortSignal?: AbortSignal } = {},
): Promise<CallToolResult> {
  if (testOverrides?.callTool) {
    return await testOverrides.callTool(connection, toolName, args);
  }

  return await withClient(connection, (client) =>
    client.callTool(
      { name: toolName, arguments: args },
      options.abortSignal ? { signal: options.abortSignal } : {},
    ),
  );
}

/**
 * List a server's tools, from the per-server cache when fresh. The cache
 * holds the in-flight promise, so concurrent cold runs share one listing;
 * its TTL is the listing's own ttlMs, clamped.
 */
export async function listMcpTools(connection: McpConnection): Promise<Tool[]> {
  if (testOverrides?.listTools) {
    return await testOverrides.listTools(connection);
  }
  const key = cacheKeyFor(connection);
  const cached = toolListCache.get(key);
  if (cached) {
    if (cached.expiresAt > Date.now()) return await cached.tools;
    toolListCache.delete(key);
  }
  const pending = withClient(connection, (client) => client.listTools()).then(
    (result) => {
      const entry = toolListCache.get(key);
      if (entry) {
        entry.expiresAt = Date.now() + clampTtlMs(result.ttlMs);
      }

      return result.tools;
    },
  );
  pending.catch(() => toolListCache.delete(key));
  pruneCache(toolListCache);
  toolListCache.set(key, {
    tools: pending,
    expiresAt: Date.now() + DEFAULT_TTL_MS,
  });

  return await pending;
}

/**
 * Build the connection for a server row: row headers overlaid with the agent
 * config's headers (those resolved their ${NAME} refs at sync). A value still
 * carrying a placeholder never reaches the wire.
 */
export function mcpConnection(
  record: McpRecord,
  configHeaders: Record<string, string> | undefined,
): McpConnection {
  const headers: Record<string, string> = {
    ...record.headers,
    ...configHeaders,
  };
  for (const [name, value] of Object.entries(headers)) {
    if (ENV_PLACEHOLDER_PATTERN.test(value)) {
      throw new Error(
        `config.mcpServers.${record.serverId} header ${name} still carries a \${NAME} ref; set it in the agent config so it resolves at sync`,
      );
    }
  }

  return { record: record, headers: headers };
}

/** Tests only: stub the network edge, and drop any cached state. */
export function setMcpForTests(overrides: McpTestOverrides | null): void {
  testOverrides = overrides;
  eraCache.clear();
  toolListCache.clear();
}

/**
 * One cache identity per server row version and resolved header set, so a
 * row edit or a header change is a miss instead of stale data for a TTL.
 */
function cacheKeyFor(connection: McpConnection): string {
  const headers = Object.entries(connection.headers).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );

  return `${connection.record.serverId}:${connection.record.updatedAt}:${JSON.stringify(headers)}`;
}

/** A cacheable result's ttlMs (typed unknown by the SDK), defaulted and clamped. */
function clampTtlMs(ttlMs: unknown): number {
  return Math.min(
    typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS,
    MAX_TTL_MS,
  );
}

/**
 * Connect a fresh client, adopting the cached era verdict when one is fresh
 * (zero extra round trips); a stale adoption falls back to one fresh
 * negotiation.
 */
async function connectClient(
  connection: McpConnection,
  key: string,
): Promise<Client> {
  // A hosted row has no external endpoint: the same stateless transport runs,
  // but every request routes through the Lambda host instead of the network.
  const hosted = connection.record.transport === "hosted";
  if (!hosted && !connection.record.url) {
    throw new Error(
      `MCP server ${connection.record.name} has no url to connect to`,
    );
  }
  const makeClient = async (
    prior: PriorDiscovery | undefined,
  ): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(
      new URL(hosted ? HOSTED_MCP_URL : connection.record.url!),
      {
        requestInit: { headers: connection.headers },
        ...(hosted ? { fetch: hostedMcpFetch(connection.record) } : {}),
      },
    );
    // Hosted bundles are our own deploy contract (stateless modern handlers),
    // so they stay pinned; an external url may be any pre-existing server, so
    // auto mode probes and falls back to the legacy initialize handshake.
    const client = new Client(CLIENT_INFO, {
      versionNegotiation: {
        mode: hosted ? { pin: MCP_PROTOCOL_VERSION } : "auto",
      },
    });
    await client.connect(transport, prior ? { prior: prior } : {});

    return client;
  };
  const cached = eraCache.get(key);
  if (cached && cached.expiresAt <= Date.now()) eraCache.delete(key);
  const prior =
    cached && cached.expiresAt > Date.now() ? cached.prior : undefined;
  let client: Client;
  try {
    client = await makeClient(prior);
  } catch (error) {
    if (!prior) throw error;
    eraCache.delete(key);
    client = await makeClient(undefined);
  }
  if (!eraCache.has(key)) {
    const discover = client.getDiscoverResult();
    pruneCache(eraCache);
    eraCache.set(
      key,
      discover
        ? {
            prior: { kind: "modern", discover: discover },
            expiresAt: Date.now() + clampTtlMs(discover.ttlMs),
          }
        : {
            prior: { kind: "legacy" },
            expiresAt: Date.now() + DEFAULT_TTL_MS,
          },
    );
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

async function withClient<T>(
  connection: McpConnection,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await connectClient(connection, cacheKeyFor(connection));
  try {
    return await operation(client);
  } finally {
    await client.close().catch(() => {});
  }
}
