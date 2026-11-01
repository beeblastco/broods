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
  onToolRetry?: (toolCallId: string, waitMs: number) => void,
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
            onRetry: (waitMs: number): void =>
              onToolRetry?.(options.toolCallId, waitMs),
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

// Providers reject names outside [A-Za-z0-9_-]; a collision this makes fails registration.
export function mcpToolName(serverName: string, remoteName: string): string {
  return `${serverName}__${remoteName.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
