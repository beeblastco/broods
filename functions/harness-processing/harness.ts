/**
 * Agent-side harness core.
 * Keep turn context assembly, model invocation, and tools orchestration here.
 */

import {
  stepCountIs,
  streamText,
  type AssistantModelMessage,
  type ModelMessage,
  type StepResult,
  type ToolCallPart,
  type ToolApprovalRequestOutput,
  type ToolSet,
} from "ai";
import type { AccountConfig } from "../_shared/accounts.ts";
import { logError, logInfo, logWarn } from "../_shared/log.ts";
import { modelSettingsFromModelConfig, resolveConfiguredModel } from "./model.ts";
import type { Session, TurnContextSnapshot } from "./session.ts";
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
  onFinalText(text: string): Promise<void>;
  onErrorText(error: string): Promise<void>;
  onApprovalRequired?(approvals: ToolApprovalSummary[]): Promise<void>;
}

// Optional per-run wiring owned by the request handler.
export interface AgentLoopOptions {
  dispatchSubagents?: RunSubagentDispatch;
}

export async function runAgentLoop(
  session: Session,
  turnContext: TurnContextSnapshot,
  accountConfig: AccountConfig,
  reply?: AgentReplyHooks,
  options: AgentLoopOptions = {},
) {
  let didFail = false;
  let failureText: string | null = null;
  let systemContextSnapshot = turnContext.systemContextSnapshot;
  const configuredModel = resolveConfiguredModel(accountConfig);

  const tools = {
    ...createTools({
      conversationKey: session.conversationKey,
      filesystemNamespace: session.filesystemNamespace(),
      modelProviderName: configuredModel.providerName,
      modelProvider: configuredModel.provider,
      session: session,
      // The handler owns subagent lifecycle, so the loop only forwards the
      // dispatcher into the tool registry for this one model run. Ephemeral
      // system messages are request-local, so pass the current turn copy into
      // child dispatch instead of expecting the coordinator to reload it.
      ...(options.dispatchSubagents
        ? {
          dispatchSubagents: (tasks, messages) =>
            options.dispatchSubagents!(tasks, messages, turnContext.ephemeralSystem),
        }
        : {}),
    }, accountConfig),
  } satisfies ToolSet;
  const enabledTools = Object.keys(tools).length > 0 ? tools : undefined;
  const modelSettings = modelSettingsFromModelConfig(accountConfig);
  let approvalSummaries: ToolApprovalSummary[] = [];

  const stream = streamText({
    maxOutputTokens: 16000,
    ...modelSettings,
    model: configuredModel.model,
    system: turnContext.system,
    messages: turnContext.messages,
    ...(enabledTools ? { tools: enabledTools } : {}),
    ...(accountConfig.model?.options ? { providerOptions: accountConfig.model.options as never } : {}),
    stopWhen: stepCountIs(accountConfig.agent?.maxTurn ?? MAX_AGENT_ITERATIONS),
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
    experimental_onToolCallStart: ({ stepNumber, toolCall }) => {
      logInfo("Tool call started", {
        conversationKey: session.conversationKey,
        eventId: session.eventId,
        stepNumber,
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
      });
    },
    experimental_onToolCallFinish: ({ stepNumber, toolCall, durationMs, success, error }) => {
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

      await reply?.onErrorText(errorText).catch(() => { });
    },
    onFinish: async ({ response, text, finishReason, steps, toolCalls }) => {
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
          await reply?.onApprovalRequired?.(approvals);
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
          await reply?.onErrorText(errorText).catch(() => { });
          return;
        }

        await reply?.onFinalText(finalText);
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

        await reply?.onErrorText(errorText).catch(() => { });
      }
    },
  });

  return Object.assign(stream, {
    didFail: () => didFail,
    failureText: () => failureText,
    approvalSummaries: () => approvalSummaries,
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
