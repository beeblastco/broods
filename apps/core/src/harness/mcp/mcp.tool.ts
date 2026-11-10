import type { Tool as McpTool } from "@modelcontextprotocol/client";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import type { McpRecord } from "../../shared/domain/mcp.ts";
import { toErrorMessage } from "../../shared/errors.ts";
import type { SandboxCpuSample } from "../sandbox/types.ts";
import { normalizeToolResultOutput } from "../tools/utils.ts";
import { callMcpTool, type McpConnection } from "./client.ts";
import { mcpSignInLink } from "./connection.ts";

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
/**
 * Stands in for a remote server that needs a sign-in. The account's own caller gets the link
 * to hand to the user; anyone else could bind their own account to it, so they get none.
 */
export function mcpSignInTool(
  record: McpRecord,
  owner: boolean,
): ToolSet[string] {
  return tool({
    description: `${record.name} is not signed in yet, so its tools are missing. Call this when the user needs ${record.name}.`,
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: async function (): Promise<string> {
      if (!owner) {
        return `${record.name} is not connected yet. Tell the user it is unavailable for now: the owner of this agent has to connect it.`;
      }
      try {
        const link = await mcpSignInLink(record);

        return `Give the user this link to sign in to ${record.name}: ${link}\nThe link works for 10 minutes. Once they say they have signed in, ${record.name}'s tools are available on your next turn.`;
      } catch (error) {
        return `${record.name} could not start a sign-in: ${toErrorMessage(error)}`;
      }
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
