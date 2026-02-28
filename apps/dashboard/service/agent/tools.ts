import type { JSONSchema7 } from "@ai-sdk/provider";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { tavilySearch } from "@tavily/ai-sdk";
import type { ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import { z } from "zod";
import type { Id } from "../../convex/_generated/dataModel";
import { createMemoryTool } from "./memory";
import { createSubAgentTool, type SubAgentSummary } from "./subagent";
import { getSandboxSecret, getSandboxUrl, toErrorMessage } from "./utils";

export type { SubAgentSummary } from "./subagent";

/** Summary of a custom tool service record from the database. */
export type CustomToolSummary = {
  _id: string;
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  language: "javascript" | "python";
  sourceCode: string;
};

type SandboxExecuteResponse =
  | { success: true; output: ToolResultOutput }
  | { success: false; error?: string };

/**
 * Creates an AI SDK tool that delegates execution to the sandbox service.
 * @param toolSummary Custom tool metadata and source code
 * @returns AI SDK tool instance
 */
function createCustomTool(toolSummary: CustomToolSummary) {
  const sandboxUrl = getSandboxUrl();
  const sandboxSecret = getSandboxSecret();

  const inputSchema = toolSummary.parameters
    ? jsonSchema(toolSummary.parameters as JSONSchema7)
    : z.record(z.string(), z.unknown());

  return tool({
    description: toolSummary.description ?? toolSummary.name,
    inputSchema: inputSchema,
    execute: async (input): Promise<ToolResultOutput> => {
      try {
        const response = await fetch(
          `${sandboxUrl}/sandbox/execute`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Sandbox-Secret": sandboxSecret,
            },
            body: JSON.stringify({
              language: toolSummary.language,
              sourceCode: toolSummary.sourceCode,
              input: input,
            }),
          },
        );

        if (!response.ok) {
          const body = await response.text();

          return { type: "error-text", value: `Sandbox error (${response.status}): ${body}` };
        }

        const result = (await response.json()) as SandboxExecuteResponse;

        if (!result.success) {
          return { type: "error-text", value: result.error ?? "Tool execution failed" };
        }

        return result.output;
      } catch (err) {
        return { type: "error-text", value: toErrorMessage(err) };
      }
    },
  });
}

/**
 * Assembles the tool set for an agent based on its config.
 * Built-in tools (memory, subAgent, search) are conditionally included based on config flags.
 * Custom tools are only added if listed in allowedTools.
 */
export function buildToolsForAgent(options: {
  authId: string;
  sessionId: Id<"sessions">;
  subAgents: SubAgentSummary[];
  customTools?: CustomToolSummary[];
  allowedTools?: string[];
  memoryToolEnabled?: boolean;
  searchToolEnabled?: boolean;
  searchToolConfig?: {
    searchDepth?: string;
    topic?: string;
    maxResults?: number;
  };
  abortSignal?: AbortSignal;
}): ToolSet {
  const {
    authId,
    sessionId,
    subAgents,
    customTools,
    allowedTools,
    memoryToolEnabled,
    searchToolEnabled,
    searchToolConfig,
    abortSignal,
  } = options;

  const allTools: ToolSet = {};
  const allowed = new Set(allowedTools ?? []);

  // SubAgent tool included when subagents are connected
  if (subAgents.length > 0) {
    allTools.subAgent = createSubAgentTool({
      authId: authId,
      parentSessionId: sessionId,
      subAgents: subAgents,
      abortSignal: abortSignal,
    });
  }

  // Memory tool (enabled by default, can be disabled via config)
  if (memoryToolEnabled !== false) {
    allTools.memory = createMemoryTool(authId);
  }

  // Web search tool via Tavily (disabled by default, opt-in via config)
  if (searchToolEnabled === true) {
    allTools.tavilySearch = tavilySearch({
      searchDepth: (searchToolConfig?.searchDepth as "basic" | "advanced" | undefined) ?? "advanced",
      includeAnswer: true,
      maxResults: searchToolConfig?.maxResults ?? 5,
      topic: (searchToolConfig?.topic as "general" | "news" | undefined) ?? "general",
    });
  }

  // Custom tools are only added if listed in allowedTools
  if (customTools && customTools.length > 0) {
    for (const toolSummary of customTools) {
      if (allowed.has(toolSummary.name)) {
        allTools[toolSummary.name] = createCustomTool(toolSummary);
      }
    }
  }

  return allTools;
}
