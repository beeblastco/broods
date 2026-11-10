import type { Tool as McpTool } from "@modelcontextprotocol/client";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import type { McpRecord } from "../../shared/domain/mcp.ts";
import type { SandboxCpuSample } from "../sandbox/types.ts";
import { normalizeToolResultOutput } from "../tools/utils.ts";
import { callMcpTool, type McpConnection } from "./client.ts";

const MAX_TOOL_NAME_LENGTH = 64;

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

// Stands in for a server that refused the run, so the model can say why instead of guessing.
export function mcpSignInTool(record: McpRecord): ToolSet[string] {
  const message = `${record.name} needs a person to sign in before its tools work. With the account key: POST /v1/mcp-connections/${record.serverId} returns a link for them to open.`;

  return tool({
    description: `${record.name} is not signed in, so its tools are missing. Call this for how to fix it.`,
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: async function (): Promise<string> {
      return message;
    },
  });
}

// Providers reject names outside [A-Za-z0-9_-] or past 64; a collision fails registration.
export function mcpToolName(serverName: string, remoteName: string): string {
  return `${serverName}__${remoteName.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(
    0,
    MAX_TOOL_NAME_LENGTH,
  );
}
