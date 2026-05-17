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
import type { AgentConfig } from "../_shared/accounts.ts";
import { logError, logInfo, logWarn } from "../_shared/log.ts";
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
    ...createTools({
      conversationKey: session.conversationKey,
      filesystemNamespace: session.filesystemNamespace(),
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

  await lifecycle.emit("agent.started", {
    modelProvider: configuredModel.providerName,
    modelId: agentConfig.model?.modelId,
    messageCount: turnContext.messages.length,
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
    experimental_onToolCallStart: async ({ stepNumber, toolCall }) => {
      await lifecycle.emit("tool.call.started", {
        stepNumber,
        toolCall: toLifecycleValue(toolCall),
      });
      logInfo("Tool call started", {
        conversationKey: session.conversationKey,
        eventId: session.eventId,
        stepNumber,
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
      });
    },
    experimental_onToolCallFinish: async ({ stepNumber, toolCall, durationMs, success, error }) => {
      await lifecycle.emit("tool.call.finished", {
        stepNumber,
        toolCall: toLifecycleValue(toolCall),
        durationMs,
        success,
        ...(success ? {} : { error: errorMessage(error) }),
      });
      const details = {
        conversationKey: session.conversationKey,
        eventId: session.eventId,
        stepNumber,
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        durationMs,
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
    onStepFinish: async ({ stepNumber, finishReason, usage, toolCalls, toolResults, warnings }) => {
      await lifecycle.emit("agent.step.finished", {
        stepNumber,
        finishReason,
        usage: toLifecycleValue(usage),
        toolCallCount: toolCalls.length,
        toolResultCount: toolResults.length,
        warningCount: warnings?.length ?? 0,
      });
      await Promise.all(toolResults.map((toolResult) =>
        lifecycle.emit("tool.result", {
          stepNumber,
          toolResult: toLifecycleValue(toolResult),
        })
      ));
      logInfo("Agent loop step finished", {
        conversationKey: session.conversationKey,
        eventId: session.eventId,
        stepNumber,
        finishReason,
        toolCallCount: toolCalls.length,
        toolResultCount: toolResults.length,
        usage,
        warningCount: warnings?.length ?? 0,
      });
    },
    onError: async ({ error }) => {
      const errorText = errorMessage(error);
      didFail = true;
      failureText = errorText;
      logError("Agent loop failed", {
        conversationKey: session.conversationKey,
        eventId: session.eventId,
        error: errorText,
        errorDetails: serializeError(error),
      });

      await lifecycle.emit("agent.failed", { error: errorText });
      await reply?.onErrorText(errorText).catch(() => { });
    },
    onFinish: async ({ response, text, finishReason, steps, toolCalls, usage }) => {
      const finalText = text.trim();
      const stepCount = steps.length;
      const toolCallCount = toolCalls.length;
      const approvalRequests = extractApprovalRequests(steps);
      const approvals = approvalRequests.map(summarizeApprovalRequest);

      try {
        await session.persistModelMessages(
          approvalRequests.length > 0
            ? withApprovalToolCalls(response.messages, approvalRequests)
            : response.messages,
        );

        if (approvals.length > 0) {
          approvalSummaries = approvals;
          logInfo("Tool approval required", {
            conversationKey: session.conversationKey,
            eventId: session.eventId,
            approvals,
          });
          await lifecycle.emit("agent.approval.required", {
            approvals: toLifecycleValue(approvals),
          });
          await reply?.onApprovalRequired?.(approvals);
          return;
        }

        if (modelOutput) {
          finalResponse = await modelOutput.parseCompleteOutput({ text }, { response, usage, finishReason }) as JSONValue;
          await reply?.onFinalText(finalResponse);
          await lifecycle.emit("agent.finished", {
            finishReason,
            stepCount,
            toolCallCount,
            response: toLifecycleValue(finalResponse),
          });
          logInfo("Processing complete", { conversationKey: session.conversationKey });
          return;
        }

        if (!finalText) {
          if (didFail) {
            logWarn("Model finished empty after a prior agent loop failure", {
              conversationKey: session.conversationKey,
              eventId: session.eventId,
              failureText,
              finishReason,
              stepCount,
              toolCallCount,
            });
            return;
          }

          const errorText = [
            "Model returned empty response",
            `(finishReason: ${finishReason}, steps: ${stepCount}, toolCalls: ${toolCallCount})`,
          ].join(" ");
          didFail = true;
          failureText = errorText;
          logError(errorText, {
            conversationKey: session.conversationKey,
            eventId: session.eventId,
            finishReason,
            stepCount,
            toolCallCount,
            responseMessageCount: response.messages.length,
          });
          await lifecycle.emit("agent.failed", {
            error: errorText,
            finishReason,
            stepCount,
            toolCallCount,
          });
          await reply?.onErrorText(errorText).catch(() => { });
          return;
        }

        finalResponse = finalText;
        await reply?.onFinalText(finalText);
        await lifecycle.emit("agent.finished", {
          finishReason,
          stepCount,
          toolCallCount,
          response: finalText,
        });
        logInfo("Processing complete", { conversationKey: session.conversationKey });
      } catch (err) {
        const errorText = errorMessage(err);
        didFail = true;
        failureText = errorText;
        logError("Post-generation steps failed", {
          conversationKey: session.conversationKey,
          error: errorText,
          errorDetails: serializeError(err),
        });

        await lifecycle.emit("agent.failed", { error: errorText });
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
