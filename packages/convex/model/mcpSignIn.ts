// The token claim that holds the org an MCP client picked at sign-in: the dashboard's
// `/mcp-auth/start` page asks WorkOS to put it there, core's `/mcp` reads it.
export const MCP_ORG_CLAIM = "urn:broods:org";
