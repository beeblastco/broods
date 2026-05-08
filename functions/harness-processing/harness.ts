/**
 * Agent-side harness core.
 * Keep turn context assembly, model invocation, and tools orchestration here. 
 */

import {
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai";
import type { AccountConfig } from "../_shared/accounts.ts";
import { logError, logInfo, logWarn } from "../_shared/log.ts";
import { modelSettingsFromModelConfig, resolveConfiguredModel } from "./model.ts";
import type { Session, TurnContextSnapshot } from "./session.ts";
import { createTools } from "./tools/index.ts";
import loadSkillTool from "./tools/load-skill.tool.ts";

// Default max agent iterations to prevent looping or too long execution.
const MAX_AGENT_ITERATIONS = 30;

export interface AgentReplyHooks {
  onFinalText(text: string): Promise<void>;
  onErrorText(error: string): Promise<void>;
}

export async function runAgentLoop(
  session: Session,
  turnContext: TurnContextSnapshot,
  accountConfig: AccountConfig,
  reply?: AgentReplyHooks,
) {
  let didFail = false;
  let failureText: string | null = null;
  let promptContext = turnContext.promptContext;
  const configuredModel = resolveConfiguredModel(accountConfig);

  const tools = {
    ...createTools({
      conversationKey: session.conversationKey,
      filesystemNamespace: session.filesystemNamespace(),
      modelProviderName: configuredModel.providerName,
      modelProvider: configuredModel.provider,
    }, accountConfig),
    // This part is to check if the skill is enabled and allowed to be used.
    ...(accountConfig.skills?.enabled === true && 
      (accountConfig.skills.allowed?.length ?? 0) > 0 
      ? loadSkillTool(session) : {}), // Else return nothing
  } satisfies ToolSet;
  const enabledTools = Object.keys(tools).length > 0 ? tools : undefined;
  const modelSettings = modelSettingsFromModelConfig(accountConfig);

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
      const refreshed = await session.loadRefreshedSystemPromptParts({
        promptContext: promptContext,
        ephemeralSystem: turnContext.ephemeralSystem,
      });
      promptContext = refreshed.promptContext;

      return {
        system: refreshed.system,
      };
    },
    experimental_onStepStart: async ({ stepNumber, model, messages, tools, steps }) => {
      logInfo("Agent loop step started", {
        conversationKey: session.conversationKey,
        eventId: session.eventId,
        stepNumber,
        model: summarizeModel(model),
        messageCount: messages.length,
        availableTools: Object.keys(tools ?? {}),
        previousStepCount: steps.length,
      });
    },
    experimental_onToolCallStart: async ({ stepNumber, model, toolCall }) => {
      logInfo("Agent loop tool call started", {
        conversationKey: session.conversationKey,
        eventId: session.eventId,
        stepNumber,
        model: summarizeModel(model),
        toolCall: summarizeToolCall(toolCall),
      });
    },
    experimental_onToolCallFinish: async (event) => {
      logInfo("Agent loop tool call finished", {
        conversationKey: session.conversationKey,
        eventId: session.eventId,
        stepNumber: event.stepNumber,
        model: summarizeModel(event.model),
        toolCall: summarizeToolCall(event.toolCall),
        durationMs: event.durationMs,
        success: event.success,
        ...(event.success
          ? { outputSummary: summarizeValue(event.output) }
          : { errorDetails: serializeError(event.error) }),
      });
    },
    onChunk: async ({ chunk }) => {
      const summary = summarizeStreamChunk(chunk);
      if (!summary) {
        return;
      }

      logInfo("Agent loop stream chunk", {
        conversationKey: session.conversationKey,
        eventId: session.eventId,
        ...summary,
      });
    },
    onStepFinish: async (step) => {
      logInfo("Agent loop step finished", {
        conversationKey: session.conversationKey,
        eventId: session.eventId,
        step: summarizeStep(step),
      });
    },
    onError: async ({ error }) => {
      const errorText = error instanceof Error ? error.message : String(error);
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

      try {
        await session.persistModelMessages(response.messages);

        if (!finalText) {
          if (didFail) {
            logWarn("Model finished empty after a prior agent loop failure", {
              conversationKey: session.conversationKey,
              eventId: session.eventId,
              failureText,
              finishReason,
              stepCount,
              toolCallCount,
              stepSummaries: steps.map(summarizeStep),
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
            stepSummaries: steps.map(summarizeStep),
          });
          await reply?.onErrorText(errorText).catch(() => { });
          return;
        }

        await reply?.onFinalText(finalText);
        logInfo("Processing complete", { conversationKey: session.conversationKey });
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
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
  });
}

function summarizeStreamChunk(chunk: unknown): Record<string, unknown> | null {
  if (!chunk || typeof chunk !== "object") {
    return null;
  }

  const record = chunk as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "unknown";
  switch (type) {
    case "tool-call":
      return { chunkType: type, toolCall: summarizeToolCall(record) };
    case "tool-result":
      return {
        chunkType: type,
        toolCall: summarizeToolCall(record),
        outputSummary: summarizeValue(record.output),
      };
    case "tool-input-start":
      return {
        chunkType: type,
        toolName: record.toolName,
        toolCallId: record.id,
        providerExecuted: record.providerExecuted,
        dynamic: record.dynamic,
      };
    case "source":
      return {
        chunkType: type,
        sourceType: record.sourceType,
        id: record.id,
        title: record.title,
        url: record.url,
      };
    case "raw":
      return { chunkType: type, rawSummary: summarizeValue(record.rawValue) };
    default:
      return null;
  }
}

function summarizeStep(step: unknown): Record<string, unknown> {
  const record = isRecord(step) ? step : {};
  return {
    stepNumber: record.stepNumber,
    model: summarizeModel(record.model),
    finishReason: record.finishReason,
    rawFinishReason: record.rawFinishReason,
    textLength: typeof record.text === "string" ? record.text.length : 0,
    reasoningTextLength: typeof record.reasoningText === "string" ? record.reasoningText.length : 0,
    contentTypes: summarizePartTypes(record.content),
    toolCalls: summarizeArray(record.toolCalls, summarizeToolCall),
    toolResults: summarizeArray(record.toolResults, summarizeToolResult),
    usage: summarizeUsage(record.usage),
    warnings: summarizeWarnings(record.warnings),
    response: summarizeResponse(record.response),
  };
}

function summarizeToolCall(value: unknown): Record<string, unknown> {
  const record = isRecord(value) ? value : {};
  return {
    toolCallId: record.toolCallId ?? record.id,
    toolName: record.toolName,
    type: record.type,
    dynamic: record.dynamic,
    providerExecuted: record.providerExecuted,
  };
}

function summarizeToolResult(value: unknown): Record<string, unknown> {
  const record = isRecord(value) ? value : {};
  return {
    toolCallId: record.toolCallId ?? record.id,
    toolName: record.toolName,
    type: record.type,
    providerExecuted: record.providerExecuted,
    outputSummary: summarizeValue(record.output),
    errorDetails: record.error ? serializeError(record.error) : undefined,
  };
}

function summarizeModel(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    provider: value.provider,
    modelId: value.modelId,
  };
}

function summarizeUsage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
  };
}

function summarizeWarnings(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((warning) => {
    if (!isRecord(warning)) {
      return summarizeValue(warning);
    }

    return {
      type: warning.type,
      feature: warning.feature,
      message: warning.message,
      details: warning.details,
    };
  });
}

function summarizeResponse(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    id: value.id,
    modelId: value.modelId,
    timestamp: value.timestamp,
    messageCount: Array.isArray(value.messages) ? value.messages.length : undefined,
    bodySummary: summarizeValue(value.body),
  };
}

function summarizePartTypes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((part) => {
    if (!isRecord(part)) {
      return typeof part;
    }
    return typeof part.type === "string" ? part.type : "unknown";
  });
}

function summarizeArray(
  value: unknown,
  summarize: (entry: unknown) => Record<string, unknown>,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(summarize);
}

function summarizeValue(value: unknown): Record<string, unknown> {
  if (value === null) {
    return { type: "null" };
  }
  if (value === undefined) {
    return { type: "undefined" };
  }
  if (typeof value === "string") {
    return { type: "string", length: value.length };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { type: typeof value, value };
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (typeof value === "object") {
    return { type: "object", keys: Object.keys(value).slice(0, 20) };
  }
  return { type: typeof value };
}

function serializeError(error: unknown, depth = 0): Record<string, unknown> {
  if (depth > 2) {
    return { message: "Nested error omitted" };
  }
  if (!isRecord(error)) {
    return { message: String(error) };
  }

  const nativeError = error instanceof Error ? error : undefined;
  const details: Record<string, unknown> = {
    name: typeof error.name === "string" ? error.name : nativeError?.name,
    message: typeof error.message === "string" ? error.message : nativeError?.message ?? String(error),
  };

  for (const key of ["reason", "statusCode", "status", "url", "requestId"]) {
    if (key in error) {
      details[key] = error[key];
    }
  }
  if (Array.isArray(error.errors)) {
    details.errors = error.errors.map((entry) => serializeError(entry, depth + 1));
  }
  if ("lastError" in error) {
    details.lastError = serializeError(error.lastError, depth + 1);
  }
  if ("cause" in error && error.cause) {
    details.cause = serializeError(error.cause, depth + 1);
  }
  if (nativeError?.stack) {
    details.stack = nativeError.stack.split("\n").slice(0, 8).join("\n");
  }

  return details;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
