/**
 * Stateless MCP client for connected servers (issue #331 phase 1). Wraps the
 * official v2 SDK pinned to spec 2026-07-28: one client per operation, no
 * session state. The version probe and tool listings are cached in-process
 * per server row (keyed by row version and resolved headers, so an edit is a
 * cache miss), honoring the ttlMs the spec requires on tools/list results.
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
  type McpRecord,
} from "../../shared/domain/mcp.ts";

const MCP_PROTOCOL_VERSION = "2026-07-28";

const CLIENT_INFO = { name: "broods-core", version: "1.0.0" };
const DEFAULT_LIST_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 256;
const MAX_LIST_TTL_MS = 60 * 60_000;

/** One server's resolved connection: the row plus the final request headers. */
export interface McpConnection {
  record: McpRecord;
  headers: Record<string, string>;
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

const discoverCache = new Map<string, DiscoverResult>();
const toolListCache = new Map<string, CachedListing>();
let testOverrides: McpTestOverrides | null = null;

/**
 * Call one remote tool. Stateless: a fresh client and POST per call. An
 * isError result surfaces as a thrown Error so the harness records a tool
 * failure instead of feeding the model an error payload as data.
 */
export async function callMcpTool(
  connection: McpConnection,
  toolName: string,
  args: Record<string, unknown>,
  options: { abortSignal?: AbortSignal } = {},
): Promise<unknown> {
  const result = testOverrides?.callTool
    ? await testOverrides.callTool(connection, toolName, args)
    : await withClient(connection, (client) =>
        client.callTool(
          { name: toolName, arguments: args },
          options.abortSignal ? { signal: options.abortSignal } : {},
        ),
      );
  if (result.isError) {
    throw new Error(
      `MCP tool ${connection.record.name}.${toolName} failed: ${textOfContent(result.content)}`,
    );
  }

  return result.structuredContent ?? textOfContent(result.content);
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
        const ttlMs = Math.min(
          typeof result.ttlMs === "number" && result.ttlMs > 0
            ? result.ttlMs
            : DEFAULT_LIST_TTL_MS,
          MAX_LIST_TTL_MS,
        );
        entry.expiresAt = Date.now() + ttlMs;
      }

      return result.tools;
    },
  );
  pending.catch(() => toolListCache.delete(key));
  pruneCache(toolListCache);
  toolListCache.set(key, {
    tools: pending,
    expiresAt: Date.now() + DEFAULT_LIST_TTL_MS,
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
  discoverCache.clear();
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

/**
 * Connect a fresh pinned client, adopting the cached version probe when one
 * exists (zero extra round trips); a stale adoption falls back to one fresh
 * negotiation.
 */
async function connectClient(
  connection: McpConnection,
  key: string,
): Promise<Client> {
  const makeClient = async (discover: DiscoverResult | undefined) => {
    const transport = new StreamableHTTPClientTransport(
      new URL(connection.record.url),
      { requestInit: { headers: connection.headers } },
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
  const prior = discoverCache.get(key);
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
    discoverCache.set(key, discover);
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

function textOfContent(content: CallToolResult["content"]): string {
  return content
    .filter(
      (block): block is Extract<typeof block, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
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
