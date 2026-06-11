/**
 * Agent-side harness core.
 * Keep turn context assembly, model invocation, and tools orchestration here.
 */

import {
  stepCountIs,
  streamText,
  type AssistantModelMessage,
  type JSONValue,
  type ModelMessage,
  type StepResult,
  type ToolCallPart,
  type ToolApprovalRequestOutput,
  type ToolSet,
} from "ai";
import type { AgentConfig } from "../_shared/storage/index.ts";
import { logError, logInfo } from "../_shared/log.ts";
import {
  modelOutputFromModelConfig,
  modelSettingsFromModelConfig,
  resolveConfiguredModel,
} from "./provider.ts";
import { stripReasoningFromMessages } from "./pruning.ts";
import type { Session, TurnContextSnapshot } from "./session.ts";
import type { RunAsyncToolDispatch } from "./async-tools.ts";
import { createAgentLifecycleEmitter, toLifecycleValue } from "./lifecycle.ts";
import { createTools } from "./tools/index.ts";
import type { RunSubagentDispatch } from "./tools/run-subagent.tool.ts";

// Default max agent iterations to prevent looping or too long execution.
const MAX_AGENT_ITERATIONS = 30;

type ApprovalRequestOutput = ToolApprovalRequestOutput<ToolSet>;
type ApprovalToolCall = ApprovalRequestOutput["toolCall"];
type ToolCallSummary = {
  toolCallId: string;
  toolName: string;
  stepNumber?: number;
  durationMs?: number;
  success?: boolean;
};

export type ToolApprovalSummary = Pick<ApprovalRequestOutput, "approvalId"> & {
  toolCallId: ApprovalToolCall["toolCallId"];
  toolName: ApprovalToolCall["toolName"];
  input: ApprovalToolCall["input"];
};

export interface AgentReplyHooks {
  onFinalText(response: JSONValue): Promise<void>;
  onErrorText(error: string): Promise<void>;
  onApprovalRequired?(approvals: ToolApprovalSummary[]): Promise<void>;
}

// Optional per-run wiring owned by the request handler.
export interface AgentLoopOptions {
  dispatchSubagents?: RunSubagentDispatch;
  dispatchAsyncTools?: RunAsyncToolDispatch;
}

export async function runAgentLoop(
  session: Session,
  turnContext: TurnContextSnapshot,
  agentConfig: AgentConfig,
  reply?: AgentReplyHooks,
  options: AgentLoopOptions = {},
) {
  let didFail = false;
  let failureText: string | null = null;
  let systemContextSnapshot = turnContext.systemContextSnapshot;
  const configuredModel = resolveConfiguredModel(agentConfig);
  const lifecycle = createAgentLifecycleEmitter(session, agentConfig);

  const tools = {
    ...await createTools({
      accountId: session.accountId,
      conversationKey: session.conversationKey,
      workspaces: session.resolvedWorkspaces(),
      statelessSandbox: session.statelessSandbox(),
      statelessPermissionMode: session.statelessPermissionMode(),
      modelProviderName: configuredModel.providerName,
      modelProvider: configuredModel.provider,
      session: session,
      dispatchAsyncTools: options.dispatchAsyncTools,
      // The handler owns subagent lifecycle, so the loop only forwards the
      // dispatcher into the tool registry for this one model run. Ephemeral
      // system messages are request-local, so pass the current turn copy into
      // child dispatch instead of expecting the coordinator to reload it.
      ...(options.dispatchSubagents
        ? {
          dispatchSubagents: (tasks, messages) =>
            options.dispatchSubagents!(tasks, stripReasoningFromMessages(messages), turnContext.ephemeralSystem),
        }
        : {}),
    }, agentConfig),
  } satisfies ToolSet;
  const enabledTools = Object.keys(tools).length > 0 ? tools : undefined;
  const modelSettings = modelSettingsFromModelConfig(agentConfig);
  const modelOutput = modelOutputFromModelConfig(agentConfig);
  let approvalSummaries: ToolApprovalSummary[] = [];
  let finalResponse: JSONValue | undefined;

  // Log context
  const runStartedAt = Date.now();
  const stepStartedAt = new Map<number, number>();
  const toolCallSummaries = new Map<string, ToolCallSummary>();
  const logContext = {
    accountId: session.accountId,
    agentId: session.agentId,
    conversationKey: session.conversationKey,
    eventId: session.eventId,
    modelProvider: configuredModel.providerName,
    modelId: agentConfig.model?.modelId,
  };

  await lifecycle.emit("agent.started", {
    modelProvider: configuredModel.providerName,
    modelId: agentConfig.model?.modelId,
    messageCount: turnContext.messages.length,
  });

  logInfo("Agent loop started", {
    eventType: "model.invocation.started",
    ...logContext,
    messageCount: turnContext.messages.length,
    enabledTools: Object.keys(tools),
  });

  const stream = streamText({
    maxOutputTokens: 16000,
    ...modelSettings,
    model: configuredModel.model,
    system: turnContext.system,
    messages: turnContext.messages,
    ...(modelOutput ? { output: modelOutput } : {}),
    ...(enabledTools ? { tools: enabledTools } : {}),
    ...(agentConfig.model?.options ? { providerOptions: agentConfig.model.options as never } : {}),
    stopWhen: stepCountIs(agentConfig.agent?.maxTurn ?? MAX_AGENT_ITERATIONS),
    prepareStep: async () => {
      // `systemContextSnapshot` is the persisted system-message snapshot from
      // session.ts. Refresh it before each step so dynamic system context added
      // during a tool loop is included without replaying the full conversation.
      const refreshed = await session.loadRefreshedSystemPromptParts({
        systemContextSnapshot: systemContextSnapshot,
        ephemeralSystem: turnContext.ephemeralSystem,
      });
      systemContextSnapshot = refreshed.systemContextSnapshot;

      return {
        system: refreshed.system,
      };
    },
    experimental_onStepStart: async ({ stepNumber }) => {
      stepStartedAt.set(stepNumber, Date.now());
    },
    experimental_onToolCallStart: async ({ stepNumber, toolCall }) => {
      if (stepNumber !== undefined && !stepStartedAt.has(stepNumber)) {
        stepStartedAt.set(stepNumber, Date.now());
      }
      recordToolCallSummary(toolCallSummaries, toolCall, { stepNumber });
      await lifecycle.emit("tool.call.started", {
        stepNumber: stepNumber,
        toolCall: toLifecycleValue(toolCall),
      });
    },
    experimental_onToolCallFinish: async ({ stepNumber, toolCall, durationMs, success, error }) => {
      recordToolCallSummary(toolCallSummaries, toolCall, { stepNumber, durationMs, success });
      await lifecycle.emit("tool.call.finished", {
        stepNumber: stepNumber,
        toolCall: toLifecycleValue(toolCall),
        durationMs: durationMs,
        success: success,
        ...(success ? {} : { error: errorMessage(error) }),
      });
      const details = {
        eventType: success ? "tool.call.finished" : "tool.call.failed",
        ...logContext,
        stepNumber: stepNumber,
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        durationMs: durationMs,
      };

      if (success) {
        logInfo("Tool call finished", details);
        return;
      }

      logError("Tool call failed", {
        ...details,
        error: errorMessage(error),
        errorDetails: serializeError(error),
      });
    },
    onStepFinish: async ({
      stepNumber,
      finishReason,
      rawFinishReason,
      usage,
      toolCalls,
      toolResults,
      warnings,
      response,
      providerMetadata,
    }) => {
      const startedAt = stepStartedAt.get(stepNumber);
      const durationMs = startedAt === undefined ? undefined : Date.now() - startedAt;
      stepStartedAt.delete(stepNumber);
      for (const toolCall of toolCalls) {
        recordToolCallSummary(toolCallSummaries, toolCall, { stepNumber });
      }

      await lifecycle.emit("agent.step.finished", {
        stepNumber: stepNumber,
        finishReason: finishReason,
        usage: toLifecycleValue(usage),
        toolCallCount: toolCalls.length,
        toolResultCount: toolResults.length,
        warningCount: warnings?.length ?? 0,
      });
      await Promise.all(toolResults.map((toolResult) =>
        lifecycle.emit("tool.result", {
          stepNumber: stepNumber,
          toolResult: toLifecycleValue(toolResult),
        })
      ));
      logInfo("Agent loop step finished", {
        eventType: "model.step.finished",
        ...logContext,
        stepNumber: stepNumber,
        finishReason: finishReason,
        rawFinishReason: rawFinishReason,
        durationMs: durationMs,
        toolCallCount: toolCalls.length,
        toolCalls: toolCalls.map(({ toolCallId, toolName }) => ({ toolCallId, toolName })),
        usage: usage,
        responseMetadata: {
          id: response.id,
          modelId: response.modelId,
          timestamp: response.timestamp.toISOString(),
        },
        providerMetadata,
      });
    },
    onError: async ({ error }) => {
      const errorText = errorMessage(error);
      const tools = summarizeToolsUsed(toolCallSummaries);
      didFail = true;
      failureText = errorText;
      logError("Agent loop failed", {
        eventType: "model.invocation.failed",
        ...logContext,
        durationMs: Date.now() - runStartedAt,
        toolsUsed: tools.toolsUsed,
        toolUsage: tools.toolUsage,
        toolCalls: tools.toolCalls,
        error: errorText,
        errorDetails: serializeError(error),
      });

      await lifecycle.emit("agent.failed", {
        error: errorText,
        toolsUsed: toLifecycleValue(tools.toolsUsed),
        toolUsage: toLifecycleValue(tools.toolUsage),
        toolCalls: toLifecycleValue(tools.toolCalls),
      });
      await reply?.onErrorText(errorText).catch(() => { });
    },
    onFinish: async ({
      response,
      text,
      finishReason,
      rawFinishReason,
      steps,
      toolCalls,
      usage,
      totalUsage,
    }) => {
      for (const toolCall of toolCalls) {
        recordToolCallSummary(toolCallSummaries, toolCall, {});
      }

      const finalText = text.trim();
      const stepCount = steps.length;
      const toolCallCount = toolCalls.length;
      const approvalRequests = extractApprovalRequests(steps);
      const approvals = approvalRequests.map(summarizeApprovalRequest);
      const tools = summarizeToolsUsed(toolCallSummaries);
      const finishLog = {
        eventType: "model.invocation.finished",
        ...logContext,
        rawFinishReason: rawFinishReason,
        durationMs: Date.now() - runStartedAt,
        finishReason: finishReason,
        stepCount: stepCount,
        toolCallCount: toolCallCount,
        toolsUsed: tools.toolsUsed,
        toolUsage: tools.toolUsage,
        toolCalls: tools.toolCalls,
        usage: totalUsage,
      };

      try {
        await session.persistModelMessages(
          approvalRequests.length > 0
            ? withApprovalToolCalls(response.messages, approvalRequests)
            : response.messages,
        );

        if (approvals.length > 0) {
          approvalSummaries = approvals;
          logInfo("Model invocation finished", finishLog);
          await lifecycle.emit("agent.approval.required", {
            approvals: toLifecycleValue(approvals),
            toolsUsed: toLifecycleValue(tools.toolsUsed),
            toolUsage: toLifecycleValue(tools.toolUsage),
            toolCalls: toLifecycleValue(tools.toolCalls),
          });
          await reply?.onApprovalRequired?.(approvals);
          return;
        }

        if (modelOutput) {
          finalResponse = await modelOutput.parseCompleteOutput({ text }, { response, usage, finishReason }) as JSONValue;
          await reply?.onFinalText(finalResponse);
          logInfo("Model invocation finished", finishLog);
          await lifecycle.emit("agent.finished", {
            finishReason: finishReason,
            stepCount: stepCount,
            toolCallCount: toolCallCount,
            toolsUsed: toLifecycleValue(tools.toolsUsed),
            toolUsage: toLifecycleValue(tools.toolUsage),
            toolCalls: toLifecycleValue(tools.toolCalls),
            response: toLifecycleValue(finalResponse),
          });
          return;
        }

        if (!finalText) {
          if (didFail) {
            return;
          }

          const errorText = [
            "Model returned empty response",
            `(finishReason: ${finishReason}, steps: ${stepCount}, toolCalls: ${toolCallCount})`,
          ].join(" ");
          didFail = true;
          failureText = errorText;
          logError(errorText, {
            eventType: "model.invocation.failed",
            ...logContext,
            durationMs: Date.now() - runStartedAt,
            finishReason: finishReason,
            stepCount: stepCount,
            toolCallCount: toolCallCount,
            toolsUsed: tools.toolsUsed,
            toolUsage: tools.toolUsage,
            toolCalls: tools.toolCalls,
            usage: totalUsage ?? usage,
          });
          await lifecycle.emit("agent.failed", {
            error: errorText,
            finishReason: finishReason,
            stepCount: stepCount,
            toolCallCount: toolCallCount,
            toolsUsed: toLifecycleValue(tools.toolsUsed),
            toolUsage: toLifecycleValue(tools.toolUsage),
            toolCalls: toLifecycleValue(tools.toolCalls),
          });
          await reply?.onErrorText(errorText).catch(() => { });
          return;
        }

        finalResponse = finalText;
        await reply?.onFinalText(finalText);
        logInfo("Model invocation finished", finishLog);
        await lifecycle.emit("agent.finished", {
          finishReason: finishReason,
          stepCount: stepCount,
          toolCallCount: toolCallCount,
          toolsUsed: toLifecycleValue(tools.toolsUsed),
          toolUsage: toLifecycleValue(tools.toolUsage),
          toolCalls: toLifecycleValue(tools.toolCalls),
          response: finalText,
        });
      } catch (err) {
        const errorText = errorMessage(err);
        const tools = summarizeToolsUsed(toolCallSummaries);
        didFail = true;
        failureText = errorText;
        logError("Post-generation steps failed", {
          eventType: "model.invocation.failed",
          ...logContext,
          durationMs: Date.now() - runStartedAt,
          toolsUsed: tools.toolsUsed,
          toolUsage: tools.toolUsage,
          toolCalls: tools.toolCalls,
          error: errorText,
          errorDetails: serializeError(err),
        });

        await lifecycle.emit("agent.failed", {
          error: errorText,
          toolsUsed: toLifecycleValue(tools.toolsUsed),
          toolUsage: toLifecycleValue(tools.toolUsage),
          toolCalls: toLifecycleValue(tools.toolCalls),
        });
        await reply?.onErrorText(errorText).catch(() => { });
      }
    },
  });

  return Object.assign(stream, {
    didFail: () => didFail,
    failureText: () => failureText,
    approvalSummaries: () => approvalSummaries,
    hasStructuredOutput: () => Boolean(modelOutput),
    finalResponse: () => finalResponse,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractApprovalRequests(steps: Array<StepResult<ToolSet>>): ApprovalRequestOutput[] {
  return steps.flatMap((step) =>
    step.content.flatMap((part) => {
      if (part.type !== "tool-approval-request") {
        return [];
      }

      return [part];
    })
  );
}

function summarizeApprovalRequest(request: ApprovalRequestOutput): ToolApprovalSummary {
  return {
    approvalId: request.approvalId,
    toolCallId: request.toolCall.toolCallId,
    toolName: request.toolCall.toolName,
    input: request.toolCall.input,
  };
}

function recordToolCallSummary(
  summaries: Map<string, ToolCallSummary>,
  toolCall: unknown,
  update: Partial<Omit<ToolCallSummary, "toolCallId" | "toolName">>,
) {
  const identity = toolCallIdentity(toolCall);
  if (!identity) {
    return;
  }

  const existing = summaries.get(identity.toolCallId);
  summaries.set(identity.toolCallId, {
    ...existing,
    ...identity,
    ...update,
  });
}

function toolCallIdentity(toolCall: unknown): Pick<ToolCallSummary, "toolCallId" | "toolName"> | null {
  if (!toolCall || typeof toolCall !== "object") {
    return null;
  }

  const record = toolCall as Record<string, unknown>;
  if (typeof record.toolCallId !== "string" || typeof record.toolName !== "string") {
    return null;
  }

  return {
    toolCallId: record.toolCallId,
    toolName: record.toolName,
  };
}

function summarizeToolsUsed(summaries: Map<string, ToolCallSummary>) {
  const toolCalls = [...summaries.values()].sort((left, right) =>
    (left.stepNumber ?? 0) - (right.stepNumber ?? 0) || left.toolCallId.localeCompare(right.toolCallId)
  );
  const toolUsage = toolCalls.reduce<Record<string, number>>((counts, toolCall) => {
    counts[toolCall.toolName] = (counts[toolCall.toolName] ?? 0) + 1;
    return counts;
  }, {});

  return {
    toolsUsed: Object.keys(toolUsage).sort(),
    toolUsage,
    toolCalls,
  };
}

function withApprovalToolCalls(
  messages: ModelMessage[],
  approvalRequests: ApprovalRequestOutput[],
): ModelMessage[] {
  const toolCallsById = new Map(
    approvalRequests.map((request) => [request.toolCall.toolCallId, request.toolCall]),
  );

  return messages.map((message) => {
    if (message.role !== "assistant" || typeof message.content === "string") {
      return message;
    }

    const existingToolCallIds = new Set(
      message.content
        .filter((part) => part.type === "tool-call")
        .map((part) => part.toolCallId),
    );
    const content = message.content.flatMap((part) => {
      if (part.type !== "tool-approval-request" || existingToolCallIds.has(part.toolCallId)) {
        return [part];
      }

      const toolCall = toolCallsById.get(part.toolCallId);
      if (!toolCall) {
        return [part];
      }

      existingToolCallIds.add(part.toolCallId);
      return [toToolCallPart(toolCall), part];
    });

    return { ...message, content } satisfies AssistantModelMessage;
  });
}

function toToolCallPart(toolCall: ApprovalToolCall): ToolCallPart {
  return {
    type: "tool-call",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: toolCall.input,
  };
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!isRecord(error)) {
    return { message: String(error) };
  }

  const details: Record<string, unknown> = {
    name: typeof error.name === "string" ? error.name : error instanceof Error ? error.name : undefined,
    message: typeof error.message === "string" ? error.message : errorMessage(error),
  };

  for (const key of ["status", "statusCode", "requestId"]) {
    if (key in error) {
      details[key] = error[key];
    }
  }
  if (error instanceof Error && error.stack) {
    details.stack = error.stack.split("\n").slice(0, 8).join("\n");
  }

  return details;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
