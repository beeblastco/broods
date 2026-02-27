import type { AssistantContent, ModelMessage, ToolContent } from "@ai-sdk/provider-utils";
import { stepCountIs, streamText } from "ai";
import type { ToolSet } from "ai";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { buildToolsForAgent, type SubAgentSummary } from "./tools";
import {
  createConvexClient,
  getGatewaySecret,
  hashApiKey,
  resolveModel,
  timingSafeEqual,
  toErrorMessage,
} from "./utils";


export type ExecuteDeploymentResult = {
  status: "completed";
  output: string;
  sessionId: Id<"sessions">;
  taskId: Id<"tasks">;
};

export type DeploymentExecutionOptions = {
  endpointId: string;
  environmentSlug?: string;
  apiKey: string;
  message?: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
};

/** Shared context for agent execution after validation and setup. */
type ExecutionContext = {
  client: ConvexHttpClient;
  gatewaySecret: string;
  sessionId: Id<"sessions">;
  taskId: Id<"tasks">;
  messages: ModelMessage[];
  tools: ToolSet;
  systemPrompt: string | undefined;
  modelId: string;
  temperature: number | undefined;
  maxTokens: number | undefined;
  maxTurns: number;
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
 * Validates deployment, creates session, fetches history, and builds tools.
 * Shared setup for both streaming and non-streaming execution.
 */
async function prepareExecution(options: DeploymentExecutionOptions): Promise<ExecutionContext> {
  const { endpointId, environmentSlug, apiKey, message, sessionId } = options;

  if (!message && !sessionId) {
    throw new Error("Provide message or sessionId");
  }

  const client = createConvexClient();
  const gatewaySecret = getGatewaySecret();

  // Validate deployment and API key
  const resolved = await client.query(api.agentDeployments.getByEndpointIdForGateway, {
    endpointId: endpointId,
    environmentSlug: environmentSlug,
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

    await client.mutation(api.tasks.updateForGateway, {
      gatewaySecret: gatewaySecret,
      taskId: created.taskId,
      status: "running",
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

    // Map Convex config records to SubAgentSummary
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
    });

    const systemPrompt = composeSystemPrompt(resolved.agentConfig.systemPrompt);

    return {
      client: client,
      gatewaySecret: gatewaySecret,
      sessionId: created.sessionId,
      taskId: created.taskId,
      messages: messages,
      tools: tools,
      systemPrompt: systemPrompt,
      modelId: resolved.agentConfig.modelId,
      temperature: resolved.agentConfig.temperature,
      maxTokens: resolved.agentConfig.maxTokens,
      maxTurns: resolved.agentConfig.maxTurns ?? 10,
    };
  } catch (error) {
    // Mark task as failed if it was created before the error
    if (createdTaskId) {
      await client.mutation(api.tasks.updateForGateway, {
        gatewaySecret: gatewaySecret,
        taskId: createdTaskId,
        status: "failed",
        error: toErrorMessage(error),
      }).catch(() => {});
    }

    throw error;
  }
}


/**
 * Streams a deployed agent execution using the native AI SDK data stream protocol.
 * Returns the stream result for use with toDataStreamResponse().
 */
export async function streamDeployment(options: DeploymentExecutionOptions) {
  const ctx = await prepareExecution(options);

  const result = streamText({
    model: resolveModel(ctx.modelId),
    messages: ctx.messages,
    tools: ctx.tools,
    ...(ctx.systemPrompt ? { system: ctx.systemPrompt } : {}),
    ...(ctx.temperature !== undefined ? { temperature: ctx.temperature } : {}),
    ...(ctx.maxTokens !== undefined ? { maxOutputTokens: ctx.maxTokens } : {}),
    stopWhen: stepCountIs(ctx.maxTurns),
    abortSignal: options.abortSignal,
    onStepFinish: async (step) => {
      // Persist step messages to Convex
      for (const msg of step.response.messages) {
        await ctx.client.mutation(api.messages.createForGateway, {
          gatewaySecret: ctx.gatewaySecret,
          sessionId: ctx.sessionId,
          message: { role: msg.role, content: msg.content },
          metadata: { finishReason: String(step.finishReason) },
        });
      }

      // Update task status for tool call steps
      if (step.finishReason === "tool-calls") {
        await ctx.client.mutation(api.tasks.updateForGateway, {
          gatewaySecret: ctx.gatewaySecret,
          taskId: ctx.taskId,
          status: "tool_call",
        });
        await ctx.client.mutation(api.tasks.updateForGateway, {
          gatewaySecret: ctx.gatewaySecret,
          taskId: ctx.taskId,
          status: "running",
        });
      }
    },
  });

  // Manage task lifecycle in background (wrap PromiseLike → Promise for .catch)
  void Promise.resolve(result.text)
    .then(async (text: string) => {
      const output = text.trim() || "No response generated.";
      await ctx.client.mutation(api.tasks.updateForGateway, {
        gatewaySecret: ctx.gatewaySecret,
        taskId: ctx.taskId,
        status: "completed",
        result: [{ type: "text", text: output }],
      });
    })
    .catch(async (error: unknown) => {
      await ctx.client.mutation(api.tasks.updateForGateway, {
        gatewaySecret: ctx.gatewaySecret,
        taskId: ctx.taskId,
        status: "failed",
        error: toErrorMessage(error),
      }).catch(() => {});
    });

  return {
    result: result,
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
  };
}


/**
 * Executes a deployed agent and returns the complete result.
 * For non-streaming HTTP responses.
 */
export async function executeDeployment(
  options: DeploymentExecutionOptions,
): Promise<ExecuteDeploymentResult> {
  const { result, sessionId, taskId } = await streamDeployment(options);
  const text = await result.text;

  return {
    status: "completed",
    output: text.trim() || "No response generated.",
    sessionId: sessionId,
    taskId: taskId,
  };
}
