import { generateText, tool } from "ai";
import { z } from "zod";
import type { Id } from "../../convex/_generated/dataModel";
import { callGateway, resolveModel, toErrorMessage } from "./utils";

/** Summary of a subagent config used to build the delegation tool. */
export type SubAgentSummary = {
  configId: Id<"agentConfigs">;
  name: string;
  description?: string;
  modelId: string;
  systemPrompt?: string;
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
  permissionMode: "default" | "bypassPermissions";
};

/**
 * Creates a subAgent tool that spawns subagents synchronously.
 * The LLM decides when delegation is useful (not a pre-planner).
 */
export function createSubAgentTool(options: {
  authId: string;
  parentSessionId: Id<"sessions">;
  subAgents: SubAgentSummary[];
  abortSignal?: AbortSignal;
}) {
  const { authId, parentSessionId, subAgents, abortSignal } = options;
  const validNames = subAgents.map((s) => s.name);

  const agentDescriptions = subAgents.map((s) => {
    const desc = s.description ?? "No description";

    return `- ${s.name}: ${desc}`;
  });

  return tool({
    description: [
      "Spawn a specialized subagent to handle a task.",
      "The subagent processes the request and returns the result.",
      "",
      "Available subagents:",
      ...agentDescriptions,
    ].join("\n"),
    inputSchema: z.object({
      agentName: z
        .enum(validNames as [string, ...string[]])
        .describe("Name of the subagent to invoke"),
      content: z
        .string()
        .describe("Instructions for the subagent to execute"),
    }),
    execute: async ({ agentName, content }) => {
      const subAgent = subAgents.find((s) => s.name === agentName);
      if (!subAgent) {
        return `Agent '${agentName}' not found.`;
      }

      // Create subagent session via HTTP gateway
      const created = await callGateway<{ sessionId: Id<"sessions">; taskId: Id<"tasks"> }>(
        "/api/gateway/sessions/create",
        {
          authId: authId,
          configId: subAgent.configId,
          parentSessionId: parentSessionId,
          isSubagent: true,
          userMessage: [{ type: "text", text: content }],
        },
      );

      await callGateway("/api/gateway/tasks/update", {
        taskId: created.taskId,
        status: "running",
      });

      try {
        // Run subagent synchronously
        const subResult = await generateText({
          model: resolveModel(subAgent.modelId),
          prompt: content,
          ...(subAgent.systemPrompt ? { system: subAgent.systemPrompt } : {}),
          ...(subAgent.temperature !== undefined
            ? { temperature: subAgent.temperature }
            : {}),
          ...(subAgent.maxTokens !== undefined
            ? { maxOutputTokens: subAgent.maxTokens }
            : {}),
          abortSignal: abortSignal,
        });

        const output =
          subResult.text.trim().length > 0
            ? subResult.text.trim()
            : `Subagent ${agentName} completed without output.`;

        // Save subagent response to its own session
        await callGateway("/api/gateway/messages/create", {
          sessionId: created.sessionId,
          message: {
            role: "assistant",
            content: [{ type: "text", text: output }],
          },
          metadata: {
            finishReason: String(subResult.finishReason ?? "unknown"),
            delegatedBySessionId: parentSessionId,
          },
        });

        // Complete subagent task
        await callGateway("/api/gateway/tasks/update", {
          taskId: created.taskId,
          status: "completed",
          result: [{ type: "text", text: output }],
        });

        return output;
      } catch (error) {
        const errorMessage = toErrorMessage(error);

        await callGateway("/api/gateway/tasks/update", {
          taskId: created.taskId,
          status: "failed",
          error: errorMessage,
        });

        return `Subagent ${agentName} failed: ${errorMessage}`;
      }
    },
  });
}
