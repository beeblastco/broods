/**
 * Example: connect an external MCP server (#331). The server's tools register
 * on the agent as `<server>__<tool>` — here `search__query` etc. Set
 * MCP_SERVER_URL (and SEARCH_TOKEN when the server needs auth) with
 * `broods env set` before deploying.
 */

import { defineAgent, defineMcpServer, env } from "broods";

export const search = defineMcpServer({
  name: "search",
  description: "External MCP server the assistant may query.",
  url: "https://mcp.example.com/mcp",
  headers: { Authorization: `Bearer ${env("SEARCH_TOKEN")}` },
});

export const assistant = defineAgent({
  name: "assistant",
  provider: {
    custom: {
      apiKey: env("AI_API_KEY"),
      base_url: env("AI_BASE_URL"),
    },
  },
  model: {
    provider: "custom",
    modelId: "Qwen3.6-27B",
  },
  agent: {
    system:
      "You are a helpful assistant. Use the search server's tools when the question needs external data.",
  },
  mcpServers: { [search.name]: { enabled: true } },
  publicAccess: true,
});
