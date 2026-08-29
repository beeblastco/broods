/**
 * Stateless MCP client for connected servers (issue #331 phase 1). Wraps the
 * official v2 SDK pinned to spec 2026-07-28: one client per operation, no
 * session state, one POST per request. Tool listings are cached in-process
 * per server, honoring the ttlMs the spec requires on tools/list results.
 */

import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/client";
import {
  ENV_PLACEHOLDER_PATTERN,
  type McpRecord,
} from "../../shared/domain/mcp.ts";

export const MCP_PROTOCOL_VERSION = "2026-07-28";

const CLIENT_INFO = { name: "broods-core", version: "1.0.0" };
const DEFAULT_LIST_TTL_MS = 5 * 60_000;
const MAX_LIST_TTL_MS = 60 * 60_000;

/** One server's resolved connection: the row plus the final request headers. */
export interface McpConnection {
  record: McpRecord;
  headers: Record<string, string>;
}

interface CachedListing {
  tools: Tool[];
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
 * List a server's tools, from the per-server cache when fresh. The cache TTL
 * is the listing's own ttlMs, clamped, so registration does not pay a
 * discovery round-trip on every run.
 */
export async function listMcpTools(connection: McpConnection): Promise<Tool[]> {
  const cached = toolListCache.get(connection.record.serverId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tools;
  }

  const result = testOverrides?.listTools
    ? { tools: await testOverrides.listTools(connection), ttlMs: 0 }
    : await withClient(connection, (client) => client.listTools());
  const ttlMs = Math.min(
    typeof result.ttlMs === "number" && result.ttlMs > 0
      ? result.ttlMs
      : DEFAULT_LIST_TTL_MS,
    MAX_LIST_TTL_MS,
  );
  toolListCache.set(connection.record.serverId, {
    tools: result.tools,
    expiresAt: Date.now() + ttlMs,
  });

  return result.tools;
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

/** Tests only: stub the network edge, and drop any cached listings. */
export function setMcpForTests(overrides: McpTestOverrides | null): void {
  testOverrides = overrides;
  toolListCache.clear();
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
  const transport = new StreamableHTTPClientTransport(
    new URL(connection.record.url),
    { requestInit: { headers: connection.headers } },
  );
  const client = new Client(CLIENT_INFO, {
    versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
  });
  await client.connect(transport);
  try {
    return await operation(client);
  } finally {
    await client.close().catch(() => {});
  }
}
