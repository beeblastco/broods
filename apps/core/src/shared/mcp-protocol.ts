/**
 * The one MCP revision Broods speaks, as client and as server: core's remote
 * client, the `broods machine --mcp` host and the `broods mcp` server all pin
 * it, with no 2025-era `initialize` fallback. The CLI bundles this file.
 */
export const MCP_PROTOCOL_VERSION = "2026-07-28";
