/**
 * Agent execution orchestration for streaming and non-streaming deployments.
 */
import type { ModelMessage, ProviderOptions } from "@ai-sdk/provider-utils";
import type { ToolSet } from "ai";
import { jsonSchema, Output, stepCountIs, streamText } from "ai";
import type { Id } from "../../convex/_generated/dataModel";
import { convertToAiSdkMessages } from "./messages";
import { getProviderOptionsForModel } from "./providers";
import { buildToolsForAgent, type CustomToolSummary, type SubAgentSummary } from "./tools";
import {
  callGateway,
  hashApiKey,
  log,
  resolveModel,
  resolveProviderError,
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
  sessionId: Id<"sessions">;
  taskId: Id<"tasks">;
  messages: ModelMessage[];
  tools: ToolSet;
  systemPrompt: string | undefined;
  modelId: string;
  temperature: number | undefined;
  maxTokens: number | undefined;
  maxTurns: number;
  outputFormat: unknown;
  providerOptions: ProviderOptions;
};


/** Prepends current UTC date to the base system prompt. */
function composeSystemPrompt(baseSystemPrompt?: string): string | undefined {
  const dateLine = `Current date: ${new Date().toISOString().split("T")[0]} (UTC)`;

  if (!baseSystemPrompt || baseSystemPrompt.trim().length === 0) {
    return dateLine;
  }

  return `${dateLine}\n\n${baseSystemPrompt.trim()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Convert persisted outputFormat config into an AI SDK output specification.
 * Supported format:
 * { type: "json_schema" | "json", schema: {...}, name?: string, description?: string }
 */
function resolveOutputSpecification(outputFormat: unknown) {
  if (!isRecord(outputFormat)) {
    return undefined;
  }

  const type = typeof outputFormat.type === "string" ? outputFormat.type : "json_schema";
  if (type !== "json_schema" && type !== "json") {
    return undefined;
  }

  const schema = outputFormat.schema;
  if (!isRecord(schema)) {
    return undefined;
  }

  const rawName = outputFormat.name;
  const rawDescription = outputFormat.description;
  const name = typeof rawName === "string" && rawName.trim().length > 0
    ? rawName.trim()
    : undefined;
  const description = typeof rawDescription === "string" && rawDescription.trim().length > 0
    ? rawDescription.trim()
    : undefined;

  try {
    return Output.object({
      schema: jsonSchema(schema),
      ...(name ? { name: name } : {}),
      ...(description ? { description: description } : {}),
    });
  } catch (error) {
    log.warn("prepare:invalid_output_format", { error: toErrorMessage(error) });

    return undefined;
  }
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

  // Validate deployment and API key
  log.info("prepare:resolving_deployment", { endpointId: endpointId, environmentSlug: environmentSlug });
  const resolved = await callGateway<{
    deployment: { authId: string; agentConfigId: Id<"agentConfigs">; status: string; apiKeyHash: string };
    agentConfig: {
      modelId: string; systemPrompt?: string; temperature?: number; maxTokens?: number;
      maxTurns?: number; allowedTools?: string[]; memoryToolEnabled?: boolean;
      searchToolEnabled?: boolean; searchToolConfig?: { searchDepth?: string; topic?: string; maxResults?: number };
      outputFormat?: unknown;
      providerOptions?: Record<string, unknown>;
      permissionMode: string;
    };
  } | null>("/api/gateway/agentDeployments/getByEndpointId", {
    endpointId: endpointId,
    environmentSlug: environmentSlug,
  });
  if (!resolved) {
    throw new Error("Not found");
  }

  if (resolved.deployment.status !== "active") {
    log.warn("prepare:deployment_revoked", { endpointId: endpointId });
    throw new Error("Revoked");
  }

  const incomingHash = await hashApiKey(apiKey);
  if (!timingSafeEqual(incomingHash, resolved.deployment.apiKeyHash)) {
    log.warn("prepare:auth_failed", { endpointId: endpointId });
    throw new Error("Unauthorized");
  }

  let createdTaskId: Id<"tasks"> | null = null;

  try {
    // Create or continue session with user message
    const created = await callGateway<{ sessionId: Id<"sessions">; taskId: Id<"tasks"> }>(
      "/api/gateway/sessions/create",
      {
        authId: resolved.deployment.authId,
        sessionId: sessionId,
        configId: resolved.deployment.agentConfigId,
        userMessage: message
          ? [{ type: "text", text: message }]
          : undefined,
      },
    );

    createdTaskId = created.taskId;
    log.info("prepare:session_created", {
      sessionId: created.sessionId,
      taskId: created.taskId,
      configId: resolved.deployment.agentConfigId,
    });

    await callGateway("/api/gateway/tasks/update", {
      taskId: created.taskId,
      status: "running",
    });

    // Fetch conversation history, subagent configs, and custom tools in parallel
    const [rawMessages, rawSubAgents, rawToolServices] = await Promise.all([
      callGateway<Array<{ role: string; content: unknown; providerOptions?: unknown }>>(
        "/api/gateway/messages/list",
        { sessionId: created.sessionId },
      ),
      callGateway<Array<{
        _id: Id<"agentConfigs">; name: string; description?: string; modelId: string;
        systemPrompt?: string; maxTurns?: number; temperature?: number; maxTokens?: number;
        permissionMode: "default" | "bypassPermissions";
      }>>(
        "/api/gateway/agentConfig/getSubAgents",
        { parentConfigId: resolved.deployment.agentConfigId },
      ),
      callGateway<Array<{
        _id: string; name: string; description?: string; parameters?: Record<string, unknown>;
        status: string; language: "javascript" | "python"; sourceCode: string;
      }>>(
        "/api/gateway/toolService/getConnected",
        { agentConfigId: resolved.deployment.agentConfigId },
      ),
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

    // Map enabled tool services to CustomToolSummary
    const customTools: CustomToolSummary[] = rawToolServices
      .filter((ts) => ts.status === "enabled")
      .map((ts) => ({
        _id: ts._id,
        name: ts.name,
        description: ts.description,
        parameters: ts.parameters,
        language: ts.language,
        sourceCode: ts.sourceCode,
      }));

    // Build tools based on agent config
    const tools = buildToolsForAgent({
      authId: resolved.deployment.authId,
      sessionId: created.sessionId,
      subAgents: subAgents,
      customTools: customTools,
      allowedTools: resolved.agentConfig.allowedTools,
      memoryToolEnabled: resolved.agentConfig.memoryToolEnabled,
      searchToolEnabled: resolved.agentConfig.searchToolEnabled,
      searchToolConfig: resolved.agentConfig.searchToolConfig,
      abortSignal: options.abortSignal,
    });

    const systemPrompt = composeSystemPrompt(resolved.agentConfig.systemPrompt);

    log.info("prepare:ready", {
      sessionId: created.sessionId,
      model: resolved.agentConfig.modelId,
      messageCount: messages.length,
      toolCount: Object.keys(tools).length,
      tools: Object.keys(tools),
      subAgentCount: subAgents.length,
      maxTurns: resolved.agentConfig.maxTurns ?? 10,
    });

    return {
      sessionId: created.sessionId,
      taskId: created.taskId,
      messages: messages,
      tools: tools,
      systemPrompt: systemPrompt,
      modelId: resolved.agentConfig.modelId,
      temperature: resolved.agentConfig.temperature,
      maxTokens: resolved.agentConfig.maxTokens,
      maxTurns: resolved.agentConfig.maxTurns ?? 10,
      outputFormat: resolved.agentConfig.outputFormat,
      providerOptions: getProviderOptionsForModel(resolved.agentConfig.modelId, resolved.agentConfig.providerOptions),
    };
  } catch (error) {
    // Mark task as failed if it was created before the error
    if (createdTaskId) {
      log.error("prepare:failed", { taskId: createdTaskId, error: toErrorMessage(error) });
      await callGateway("/api/gateway/tasks/update", {
        taskId: createdTaskId,
        status: "failed",
        error: toErrorMessage(error),
      }).catch(() => { });
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
  let stepIndex = 0;
  const outputSpec = resolveOutputSpecification(ctx.outputFormat);

  log.info("stream:start", {
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    model: ctx.modelId,
    maxTurns: ctx.maxTurns,
  });

  const result = streamText({
    model: resolveModel(ctx.modelId),
    messages: ctx.messages,
    tools: ctx.tools,
    providerOptions: ctx.providerOptions,
    ...(ctx.systemPrompt ? { system: ctx.systemPrompt } : {}),
    ...(ctx.temperature !== undefined ? { temperature: ctx.temperature } : {}),
    ...(ctx.maxTokens !== undefined ? { maxOutputTokens: ctx.maxTokens } : {}),
    ...(outputSpec ? { output: outputSpec } : {}),
    stopWhen: stepCountIs(ctx.maxTurns),
    abortSignal: options.abortSignal,
    onStepFinish: async (step) => {
      stepIndex += 1;
      const toolNames = step.toolCalls?.map((tc) => tc.toolName) ?? [];

      log.info("stream:step_finish", {
        sessionId: ctx.sessionId,
        step: stepIndex,
        finishReason: step.finishReason,
        toolCalls: toolNames,
      });

      // Persist step messages to Convex (forward providerOptions for reasoning metadata)
      for (const msg of step.response.messages) {
        await callGateway("/api/gateway/messages/create", {
          sessionId: ctx.sessionId,
          message: { role: msg.role, content: msg.content },
          providerOptions: msg.providerOptions,
          metadata: { finishReason: String(step.finishReason) },
        });
      }

      // Update task status for tool call steps
      if (step.finishReason === "tool-calls") {
        await callGateway("/api/gateway/tasks/update", {
          taskId: ctx.taskId,
          status: "tool_call",
        });
        await callGateway("/api/gateway/tasks/update", {
          taskId: ctx.taskId,
          status: "running",
        });
      }
    },
  });

  // Manage task lifecycle in background (wrap PromiseLike → Promise for .catch)
  void Promise.all([Promise.resolve(result.text), Promise.resolve(result.output)])
    .then(async ([text, parsedOutput]: [string, unknown]) => {
      const textOutput = text.trim() || "No response generated.";
      const hasParsedOutput = parsedOutput !== undefined;
      const finalOutput = hasParsedOutput
        ? (typeof parsedOutput === "string"
          ? parsedOutput
          : JSON.stringify(parsedOutput))
        : textOutput;
      const taskResult = hasParsedOutput
        ? [{ type: "json", value: parsedOutput }]
        : [{ type: "text", text: textOutput }];

      log.info("stream:completed", {
        sessionId: ctx.sessionId,
        taskId: ctx.taskId,
        steps: stepIndex,
        outputLength: finalOutput.length,
      });

      await callGateway("/api/gateway/tasks/update", {
        taskId: ctx.taskId,
        status: "completed",
        result: taskResult,
      });
    })
    .catch(async (error: unknown) => {
      const providerError = resolveProviderError(error);
      const errorMessage = providerError?.message ?? toErrorMessage(error);

      log.error("stream:failed", {
        sessionId: ctx.sessionId,
        taskId: ctx.taskId,
        steps: stepIndex,
        error: errorMessage,
        ...(providerError ? {
          providerStatusCode: providerError.statusCode,
          provider: providerError.provider,
          modelId: providerError.modelId,
        } : {}),
      });

      await callGateway("/api/gateway/tasks/update", {
        taskId: ctx.taskId,
        status: "failed",
        error: errorMessage,
      }).catch(() => { });
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
  const [text, parsedOutput] = await Promise.all([
    result.text,
    result.output,
  ]);
  const output = parsedOutput !== undefined
    ? (typeof parsedOutput === "string"
      ? parsedOutput
      : JSON.stringify(parsedOutput))
    : (text.trim() || "No response generated.");

  return {
    status: "completed",
    output: output,
    sessionId: sessionId,
    taskId: taskId,
  };
}
