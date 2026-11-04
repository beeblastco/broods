// `broods mcp`: the shared tools over stdio, with the credential from the environment.

import { McpServer } from "@modelcontextprotocol/server";
import {
  type ServeStdioOptions,
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { BroodsAccountClient, resolveEnvCredential } from "./account.ts";
import {
  type McpScopeDefaults,
  registerBroodsTools,
  registerCliScope,
  registerDestructive,
} from "./mcp-tools.ts";
import type { BroodsSyncClient } from "./sync.ts";

export interface BroodsMcpServerOptions {
  allowDestructive?: boolean;
  cli?: BroodsSyncClient | null;
  scope?: McpScopeDefaults;
}

// The credential is read from the environment at startup, never from a tool argument.
export function createBroodsMcpServer(
  options: BroodsMcpServerOptions = {},
): McpServer {
  const client = resolveEnvCredential() ? new BroodsAccountClient({}) : null;
  if (!client && !options.cli) {
    throw new Error(
      "broods mcp needs a credential: set BROODS_SESSION_TOKEN or BROODS_ACCOUNT_SECRET, or run `broods login`.",
    );
  }
  const server = new McpServer(
    { name: "broods", version: "1" },
    { capabilities: { tools: {} } },
  );

  if (client) registerBroodsTools(server, client, options.scope ?? {});
  if (options.cli) registerCliScope(server, options.cli);
  if (options.allowDestructive) {
    registerDestructive(server, client, options.cli ?? null);
  }

  return server;
}

export function serveBroodsMcp(
  server: McpServer,
  transport?: ServeStdioOptions["transport"],
): StdioServerHandle {
  return serveStdio((): McpServer => server, {
    legacy: "reject",
    ...(transport ? { transport: transport } : {}),
  });
}
