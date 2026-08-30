/**
 * AI SDK adapter for connected MCP tools (issue #331 phase 1). One tool() per
 * remote tool, named `server__tool`. Request/response only: MCP tools/call
 * has no streaming analog, so execute is a plain async function and
 * notifications/progress are not mapped onto chunk frames.
 */

import type { Tool as McpTool } from "@modelcontextprotocol/client";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import { normalizeToolResultOutput } from "../tools/utils.ts";
import { callMcpTool, type McpConnection } from "./client.ts";

export function mcpServerTools(
  connection: McpConnection,
  remoteTools: McpTool[],
): ToolSet {
  const tools: ToolSet = {};
  for (const remote of remoteTools) {
    tools[mcpToolName(connection.record.name, remote.name)] = tool({
      description: remote.description ?? "",
      inputSchema: jsonSchema(remote.inputSchema as JSONSchema7),
      toModelOutput: ({ output }): ToolResultOutput =>
        normalizeToolResultOutput(output),
      execute: async function (input, options): Promise<unknown> {
        return await callMcpTool(
          connection,
          remote.name,
          (input ?? {}) as Record<string, unknown>,
          { abortSignal: options.abortSignal },
        );
      },
    });
  }

  return tools;
}

/** Model-facing name of one remote tool: the server's namespace plus its own. */
export function mcpToolName(serverName: string, remoteName: string): string {
  return `${serverName}__${remoteName}`;
}
