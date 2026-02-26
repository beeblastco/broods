import type { AssistantContent, ModelMessage, ToolContent, ToolResultOutput } from "@ai-sdk/provider-utils";
import { stepCountIs, streamText } from "ai";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { buildToolsForAgent, type SubAgentSummary } from "./tools";
import {
  createConvexClient,
  getGatewaySecret,
  hashApiKey,
  normalizeError,
  resolveModel,
  timingSafeEqual,
  toErrorMessage,
} from "./utils";


export type ExecuteCompletedResult = {
  status: "completed";
  output: string;
  sessionId: Id<"sessions">;
  taskId: Id<"tasks">;
};

export type ExecuteDeploymentResult = ExecuteCompletedResult;

export type EventEmitter = (event: string, data: Record<string, unknown>) => void;

export type DeploymentExecutionOptions = {
  endpointId: string;
  apiKey: string;
  message?: string;
  sessionId?: string;
  emit?: EventEmitter;
  abortSignal?: AbortSignal;
};


/**
 * Converts Convex messages to AI SDK CoreMessage format.
 * Maps field name differences: input→args, output→result.
 * Filters out approval-related content parts.
 */
export function convertToAiSdkMessages(
  rawMessages: Array<{ role: string; content: unknown; providerOptions?: unknown }>,
): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const msg of rawMessages) {
    const { role, content } = msg;

    // Handle string content
    if (typeof content === "string") {
      if (role === "system") {
        result.push({ role: "system", content: content });
      } else if (role === "assistant") {
        result.push({ role: "assistant", content: content });
      } else {
        result.push({ role: "user", content: content });
      }
      continue;
    }

    // Handle array content
    if (!Array.isArray(content)) {
      continue;
    }

    // Filter out approval-related parts
    const parts = content.filter(
      (p: { type?: string }) =>
        p.type !== "tool-approval-request" &&
        p.type !== "tool-approval-response",
    );

    if (parts.length === 0) {
      continue;
    }

    if (role === "tool") {
      // Tool messages contain tool-result parts
      const toolParts: ToolContent = parts.map((p: Record<string, unknown>) => {
        if (p.type === "tool-result") {
          return {
            type: "tool-result" as const,
            toolCallId: p.toolCallId as string,
            toolName: p.toolName as string,
            output: p.output ?? p.result, // DB may store as "output" or legacy "result"
          } as ToolContent[number];
        }

        // Fallback: treat as text tool result
        return {
          type: "tool-result" as const,
          toolCallId: (p.toolCallId as string) ?? "unknown",
          toolName: (p.toolName as string) ?? "unknown",
          output: p.text ?? JSON.stringify(p),
        } as ToolContent[number];
      });

      result.push({ role: "tool", content: toolParts });
    } else if (role === "assistant") {
      // Assistant messages can contain text, reasoning, and tool-call parts
      const assistantParts = parts.map((p: Record<string, unknown>) => {
        if (p.type === "tool-call") {
          return {
            type: "tool-call" as const,
            toolCallId: p.toolCallId as string,
            toolName: p.toolName as string,
            input: (p.input ?? p.args ?? {}) as Record<string, unknown>, // DB may store as "input" or legacy "args"
          };
        }

        // text, reasoning, etc. pass through directly
        return p;
      });

      result.push({
        role: "assistant",
        content: assistantParts as AssistantContent,
      });
    } else if (role === "system") {
      // System messages with array content: extract text
      const text = parts
        .filter((p: { type?: string }) => p.type === "text")
        .map((p: { text?: string }) => p.text ?? "")
        .join("\n");
      if (text.trim()) {
        result.push({ role: "system", content: text });
      }
    } else {
      // User messages pass through
      result.push({ role: "user", content: parts });
    }
  }

  return result;
}


/** Prepends current date to the base system prompt. */
export function composeSystemPrompt(baseSystemPrompt?: string): string | undefined {
  const dateLine = `Current date: ${new Date().toISOString().split("T")[0]}`;

  if (!baseSystemPrompt || baseSystemPrompt.trim().length === 0) {
    return dateLine;
  }

  return `${dateLine}\n\n${baseSystemPrompt.trim()}`;
}


/**
 * Executes a deployed agent with AI SDK tool loop.
 * Mirrors my-app-2's fullStream pattern: LLM decides when to use tools,
 * messages persisted at each finish-step.
 */
export async function executeDeployment(
  options: DeploymentExecutionOptions,
): Promise<ExecuteDeploymentResult> {
  const {
    endpointId,
    apiKey,
    message,
    sessionId,
    emit,
    abortSignal,
  } = options;

  if (!message && !sessionId) {
    throw new Error("Provide message or sessionId");
  }

  const client = createConvexClient();
  const gatewaySecret = getGatewaySecret();

  // Validate deployment and API key
  const resolved = await client.query(api.agentDeployments.getByEndpointIdForGateway, {
    endpointId: endpointId,
    gatewaySecret: gatewaySecret,
  });
  if (!resolved) {
    throw new Error("Not found");
  }

  if (resolved.deployment.status !== "active") {
    throw new Error("Revoked");
  }

  const incomingHash = await hashApiKey(apiKey);
  if (!timingSafeEqual(incomingHash, resolved.deployment.apiKeyHash)) {
    throw new Error("Unauthorized");
  }

  let createdTaskId: Id<"tasks"> | null = null;
  let createdSessionId: Id<"sessions"> | null = null;

  try {
    // Create or continue session with user message
    const created = await client.mutation(api.sessions.createForGateway, {
      gatewaySecret: gatewaySecret,
      authId: resolved.deployment.authId,
      sessionId: sessionId as Id<"sessions"> | undefined,
      configId: resolved.deployment.agentConfigId,
      userMessage: message
        ? [{ type: "text", text: message }]
        : undefined,
    });

    createdTaskId = created.taskId;
    createdSessionId = created.sessionId;

    await client.mutation(api.tasks.updateForGateway, {
      gatewaySecret: gatewaySecret,
      taskId: created.taskId,
      status: "running",
    });

    emit?.("execution.started", {
      sessionId: created.sessionId,
      taskId: created.taskId,
      configId: resolved.deployment.agentConfigId,
    });

    // Fetch conversation history and subagent configs in parallel
    const [rawMessages, rawSubAgents] = await Promise.all([
      client.query(api.messages.listForGateway, {
        gatewaySecret: gatewaySecret,
        sessionId: created.sessionId,
      }),
      client.query(api.agentConfig.getSubAgentsForGateway, {
        gatewaySecret: gatewaySecret,
        parentConfigId: resolved.deployment.agentConfigId,
      }),
    ]);

    const messages = convertToAiSdkMessages(rawMessages);

    // Map Convex config records to SubAgentSummary (Convex uses _id, service uses configId)
    const subAgents: SubAgentSummary[] = rawSubAgents.map((config) => ({
      configId: config._id,
      name: config.name,
      description: config.description,
      modelId: config.modelId,
      systemPrompt: config.systemPrompt,
      maxTurns: config.maxTurns,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      permissionMode: config.permissionMode,
    }));

    // Build tools based on agent config
    const tools = buildToolsForAgent({
      client: client,
      gatewaySecret: gatewaySecret,
      authId: resolved.deployment.authId,
      sessionId: created.sessionId,
      subAgents: subAgents,
      allowedTools: resolved.agentConfig.allowedTools,
      disallowedTools: resolved.agentConfig.disallowedTools,
      emit: emit,
    });

    // Build system prompt with current date
    const systemPrompt = composeSystemPrompt(resolved.agentConfig.systemPrompt);

    emit?.("llm.start", {
      modelId: resolved.agentConfig.modelId,
      toolCount: Object.keys(tools).length,
    });

    if (abortSignal?.aborted) {
      throw new Error("Request aborted");
    }

    // Run agent with tool loop via streamText (mirrors my-app-2's fullStream pattern)
    const textStream = streamText({
      model: resolveModel(resolved.agentConfig.modelId),
      messages: messages,
      tools: tools,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      ...(resolved.agentConfig.temperature !== undefined
        ? { temperature: resolved.agentConfig.temperature }
        : {}),
      ...(resolved.agentConfig.maxTokens !== undefined
        ? { maxOutputTokens: resolved.agentConfig.maxTokens }
        : {}),
      stopWhen: stepCountIs(resolved.agentConfig.maxTurns ?? 10),
      abortSignal: abortSignal,
    });

    // Track accumulator state per step (reset at each finish-step)
    let currentTextResponse = "";
    let currentReasoning = "";
    let currentToolCalls: Array<{ type: "tool-call"; toolCallId: string; toolName: string; input: unknown }> = [];
    let currentToolResults: Array<{ type: "tool-result"; toolCallId: string; toolName: string; output: ToolResultOutput }> = [];
    let finalOutput = "";

    for await (const part of textStream.fullStream) {
      switch (part.type) {
        case "text-delta":
          currentTextResponse += part.text;
          emit?.("llm.delta", { text: part.text });
          break;

        case "reasoning-delta":
          if (part.text) {
            currentReasoning += part.text;
          }
          break;

        case "tool-call":
          currentToolCalls.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          emit?.("tool.call", {
            toolName: part.toolName,
            toolCallId: part.toolCallId,
          });

          // Update task status to tool_call
          await client.mutation(api.tasks.updateForGateway, {
            gatewaySecret: gatewaySecret,
            taskId: created.taskId,
            status: "tool_call",
          });
          break;

        case "tool-result":
          currentToolResults.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: part.output as ToolResultOutput,
          });
          emit?.("tool.result", {
            toolName: part.toolName,
            toolCallId: part.toolCallId,
          });
          break;

        case "finish-step": {
          // Persist step messages to Convex (mirrors my-app-2 finish-step handling)
          if (part.finishReason === "tool-calls") {
            // Save assistant message: reasoning + text + tool-calls
            const assistantContent: AssistantContent = [];

            if (currentReasoning.trim()) {
              assistantContent.push({
                type: "reasoning",
                text: currentReasoning.trim(),
              });
            }

            if (currentTextResponse.trim()) {
              assistantContent.push({
                type: "text",
                text: currentTextResponse.trim(),
              });
            }

            for (const tc of currentToolCalls) {
              assistantContent.push({
                type: "tool-call",
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                input: tc.input as Record<string, unknown>,
              });
            }

            if (assistantContent.length > 0) {
              await client.mutation(api.messages.createForGateway, {
                gatewaySecret: gatewaySecret,
                sessionId: created.sessionId,
                message: {
                  role: "assistant",
                  content: assistantContent,
                },
                metadata: { finishReason: part.finishReason },
              });
            }

            // Save tool results as a separate tool message
            if (currentToolResults.length > 0) {
              const toolContent: ToolContent = currentToolResults.map((tr) => ({
                type: "tool-result" as const,
                toolCallId: tr.toolCallId,
                toolName: tr.toolName,
                output: tr.output,
              }));

              await client.mutation(api.messages.createForGateway, {
                gatewaySecret: gatewaySecret,
                sessionId: created.sessionId,
                message: {
                  role: "tool",
                  content: toolContent,
                },
              });
            }

            // Update task status back to running for the next step
            await client.mutation(api.tasks.updateForGateway, {
              gatewaySecret: gatewaySecret,
              taskId: created.taskId,
              status: "running",
            });
          } else {
            // Final step (stop, length, content-filter, etc.)
            const finalContent: AssistantContent = [];

            if (currentReasoning.trim()) {
              finalContent.push({
                type: "reasoning",
                text: currentReasoning.trim(),
              });
            }

            if (currentTextResponse.trim()) {
              finalContent.push({
                type: "text",
                text: currentTextResponse.trim(),
              });
            }

            if (finalContent.length > 0) {
              await client.mutation(api.messages.createForGateway, {
                gatewaySecret: gatewaySecret,
                sessionId: created.sessionId,
                message: {
                  role: "assistant",
                  content: finalContent,
                },
                metadata: { finishReason: String(part.finishReason ?? "unknown") },
              });
            }

            finalOutput = currentTextResponse.trim();
          }

          // Reset accumulators for the next step
          currentTextResponse = "";
          currentReasoning = "";
          currentToolCalls = [];
          currentToolResults = [];
          break;
        }

        case "error":
          throw normalizeError(part.error);
      }
    }

    const output = finalOutput.length > 0 ? finalOutput : "No response generated.";
    const outputContent: Array<{ type: "text"; text: string }> = [
      { type: "text", text: output },
    ];

    // Complete the task
    await client.mutation(api.tasks.updateForGateway, {
      gatewaySecret: gatewaySecret,
      taskId: created.taskId,
      status: "completed",
      result: outputContent,
    });

    return {
      status: "completed",
      output: output,
      sessionId: created.sessionId,
      taskId: created.taskId,
    };
  } catch (error) {
    if (createdTaskId) {
      await client.mutation(api.tasks.updateForGateway, {
        gatewaySecret: gatewaySecret,
        taskId: createdTaskId,
        status: "failed",
        error: toErrorMessage(error),
      });
    }

    if (createdSessionId) {
      emit?.("execution.failed", {
        sessionId: createdSessionId,
        taskId: createdTaskId,
        error: toErrorMessage(error),
      });
    }

    throw error;
  }
}
