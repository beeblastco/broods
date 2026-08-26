/**
 * Validate-before-connect calls for connectors (tickets 04/06 discipline,
 * executed by 19): a GitHub token proves itself with one real GET /user, and
 * an MCP server proves itself with a real `initialize` handshake +
 * `tools/list` — "URL reachable" is not connected. Fetch is injectable so
 * tests can drive every path without a network.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GithubValidation {
  login: string;
}

/** One real authenticated call; throws with GitHub's own error on failure. */
export async function validateGithubToken(
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<GithubValidation> {
  const response = await fetchImpl("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "broods-connector-validation",
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // keep raw body
    }
    throw new Error(
      `GitHub rejected the token (HTTP ${response.status}${detail ? `: ${detail}` : ""})`,
    );
  }
  const user = (await response.json()) as { login?: string };
  if (typeof user.login !== "string") {
    throw new Error("GitHub returned no login for this token");
  }

  return { login: user.login };
}

export interface McpValidation {
  serverName?: string;
  toolNames: string[];
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** Parse a streamable-HTTP MCP response body: plain JSON or an SSE stream. */
async function parseMcpResponse(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (contentType.includes("text/event-stream")) {
    // Take the last data: line carrying a JSON-RPC response.
    let last: JsonRpcResponse | null = null;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
        if (parsed && (parsed.result !== undefined || parsed.error)) {
          last = parsed;
        }
      } catch {
        // ignore non-JSON data lines
      }
    }
    if (!last) throw new Error("MCP server sent no JSON-RPC response");

    return last;
  }

  return JSON.parse(text) as JsonRpcResponse;
}

/**
 * Real MCP streamable-HTTP handshake: initialize → notifications/initialized
 * → tools/list. Returns the advertised tool names; throws with the server's
 * actual error when any step fails.
 */
export async function validateMcpServer(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike = fetch,
): Promise<McpValidation> {
  const baseHeaders = {
    ...headers,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  const initResponse = await fetchImpl(url, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "broods-connector-validation", version: "1.0.0" },
      },
    }),
  });
  if (!initResponse.ok) {
    throw new Error(
      `MCP initialize failed (HTTP ${initResponse.status} ${initResponse.statusText})`,
    );
  }
  const sessionId = initResponse.headers.get("mcp-session-id");
  const init = await parseMcpResponse(initResponse);
  if (init.error) {
    throw new Error(
      `MCP initialize failed: ${init.error.message ?? "unknown error"}`,
    );
  }
  const serverInfo = (
    init.result as { serverInfo?: { name?: string } } | undefined
  )?.serverInfo;

  const sessionHeaders = {
    ...baseHeaders,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };

  // The spec requires the initialized notification before further requests.
  await fetchImpl(url, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  }).catch(() => undefined);

  const toolsResponse = await fetchImpl(url, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });
  if (!toolsResponse.ok) {
    throw new Error(
      `MCP tools/list failed (HTTP ${toolsResponse.status} ${toolsResponse.statusText})`,
    );
  }
  const tools = await parseMcpResponse(toolsResponse);
  if (tools.error) {
    throw new Error(
      `MCP tools/list failed: ${tools.error.message ?? "unknown error"}`,
    );
  }
  const toolList = (
    tools.result as { tools?: Array<{ name?: string }> } | undefined
  )?.tools;

  return {
    ...(serverInfo?.name ? { serverName: serverInfo.name } : {}),
    toolNames: (toolList ?? [])
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string"),
  };
}
