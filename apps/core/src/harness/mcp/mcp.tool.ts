/**
 * AI SDK adapter for connected MCP tools (issue #331 phase 1). One tool() per
 * remote tool, named `server__tool`. Request/response only: MCP tools/call
 * has no streaming analog, so execute is a plain async function and
 * notifications/progress are not mapped onto chunk frames.
 */

import type { Tool as McpTool } from "@modelcontextprotocol/client";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import type { SandboxCpuSample } from "../sandbox/types.ts";
import { normalizeToolResultOutput } from "../tools/utils.ts";
import { callMcpTool, type McpConnection } from "./client.ts";

export function mcpTools(
  connection: McpConnection,
  remoteTools: McpTool[],
  onSandboxCpu?: (sample: SandboxCpuSample) => void,
): ToolSet {
  const tools: ToolSet = {};
  for (const remote of remoteTools) {
    const name = mcpToolName(connection.record.name, remote.name);
    tools[name] = tool({
      description: remote.description ?? "",
      inputSchema: jsonSchema(remote.inputSchema as JSONSchema7),
      toModelOutput: ({ output }): ToolResultOutput =>
        normalizeToolResultOutput(output),
      execute: async function (input, options): Promise<unknown> {
        return await callMcpTool(
          connection,
          remote.name,
          (input ?? {}) as Record<string, unknown>,
          {
            abortSignal: options.abortSignal,
            // Only a hosted row's Lambda reports CPU; metered under the
            // dedicated tool-compute type so it never files as the agent's
            // own sandbox.
            ...(onSandboxCpu
              ? {
                  onCpuUsec: (cpuUsec: number): void =>
                    onSandboxCpu({
                      type: "mcp-sandbox",
                      role: "tool",
                      toolName: name,
                      toolCallId: options.toolCallId,
                      cpuUsec: cpuUsec,
                    }),
                }
              : {}),
          },
        );
      },
    });
  }

  return tools;
}

/**
 * Model-facing name of one remote tool: the server's namespace plus its own.
 * Pre-2026 spec revisions put no charset on tool names, and providers reject
 * names outside [A-Za-z0-9_-], so anything else maps to '_'; a collision this
 * produces is caught by the registration conflict check.
 */
export function mcpToolName(serverName: string, remoteName: string): string {
  return `${serverName}__${remoteName.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
