/**
 * Session compaction for persisted conversation context.
 * Keep the auto-compaction threshold and summary generation here; storage
 * stays in session.ts.
 */

import { models, type ModelDefinition } from "@llmgateway/models";
import { generateText, type ModelMessage, type SystemModelMessage } from "ai";
import { DEFAULT_COMPACTION_PROMPT } from "../shared/.generated/compaction-prompt.ts";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import { logInfo } from "../shared/log.ts";
import {
  modelSettingsFromModelConfig,
  providerOptionsFromModelConfig,
  resolveConfiguredModel,
} from "./provider.ts";
import { stripReasoningFromMessages } from "./pruning.ts";

// Input tokens of a turn's last model call that start an auto-compaction.
const DEFAULT_AUTO_COMPACTION_MAX_CONTEXT_LENGTH = 500_000;
// Leave room for the model's answer, tool definitions, and provider framing.
const AUTO_COMPACTION_CONTEXT_FRACTION = 0.8;
// Unknown and custom models assume a conservative 128k window.
const DEFAULT_MODEL_CONTEXT_LENGTH = 128_000;
// Character count is a conservative token ceiling for multilingual/code input.
const MAX_COMPACTION_INPUT_CHARACTERS = 100_000;
const COMPACTION_MARKER = "<session-compaction-summary>";
const COMPACTION_MARKER_END = "</session-compaction-summary>";
const MODEL_CATALOG: readonly ModelDefinition[] = models;

export interface SummarizeConversationInput {
  conversationKey: string;
  priorSummaries: SystemModelMessage[];
  messages: ModelMessage[];
  agentConfig: AgentConfig;
  // Extra focus for the summary model, from /compact <instructions>.
  instructions?: string;
}

/**
 * Whether a finished turn auto-compacts: on unless the agent turns it off, once
 * the turn's last model call reaches the configured ceiling or 80% of the
 * model's context window, whichever comes first.
 */
export function shouldAutoCompact(
  agentConfig: AgentConfig,
  lastInputTokens: number | undefined,
): boolean {
  const config = agentConfig.session?.autoCompaction;
  if (config?.enabled === false || lastInputTokens === undefined) return false;
  const configuredMax =
    config?.maxContextLength ?? DEFAULT_AUTO_COMPACTION_MAX_CONTEXT_LENGTH;
  const modelMax = Math.floor(
    modelContextLength(agentConfig) * AUTO_COMPACTION_CONTEXT_FRACTION,
  );

  return lastInputTokens >= Math.min(configuredMax, modelMax);
}

export function isCompactionSummaryMessage(
  message: SystemModelMessage,
): boolean {
  return (
    typeof message.content === "string" &&
    message.content.startsWith(COMPACTION_MARKER)
  );
}

/**
 * Unconditional summary generation. Callers decide when to compact and which
 * messages fold in; this produces the summary row from them.
 */
export async function summarizeConversation(
  input: SummarizeConversationInput,
): Promise<SystemModelMessage | null> {
  const messages = stripReasoningFromMessages(input.messages);
  const compactableContext = [...input.priorSummaries, ...messages];
  if (compactableContext.length === 0) {
    return null;
  }

  const configuredModel = resolveConfiguredModel(input.agentConfig);
  const providerOptions = providerOptionsFromModelConfig(input.agentConfig);
  const startedAt = Date.now();
  const request = fitCompactionRequest(
    formatCompactionRequest(compactableContext, input.instructions),
    input.agentConfig,
  );
  const result = await generateText({
    ...modelSettingsFromModelConfig(input.agentConfig),
    model: configuredModel.model,
    instructions: DEFAULT_COMPACTION_PROMPT,
    telemetry: {
      functionId: "harness.compaction",
      recordInputs: false,
      recordOutputs: false,
    },
    messages: [
      {
        role: "user",
        content: request,
      },
    ],
    ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
  });

  const summary = createCompactionSummaryMessage(result.text);
  logInfo("Session context compacted", {
    conversationKey: input.conversationKey,
    messageCount: input.messages.length,
    compactedMessageCount: compactableContext.length,
    durationMs: Date.now() - startedAt,
  });

  return summary;
}

function createCompactionSummaryMessage(summary: string): SystemModelMessage {
  return {
    role: "system",
    content: `${COMPACTION_MARKER}\nThe following is a compacted summary of earlier conversation history. Treat it as context for this conversation and prefer newer explicit messages when they conflict.\n\n${summary.trim()}\n${COMPACTION_MARKER_END}`,
  };
}

// The summary keeps the newest context when the stored history is itself too
// large for the model. One character per token is deliberately conservative.
function fitCompactionRequest(
  request: string,
  agentConfig: AgentConfig,
): string {
  const limit = Math.min(
    MAX_COMPACTION_INPUT_CHARACTERS,
    Math.floor(
      modelContextLength(agentConfig) * AUTO_COMPACTION_CONTEXT_FRACTION,
    ),
  );

  return request.length <= limit ? request : request.slice(-limit);
}

// Per-call data rides the user message; the system prompt stays the static
// generated DEFAULT_COMPACTION_PROMPT so its prefix stays cacheable.
function formatCompactionRequest(
  messages: ModelMessage[],
  instructions?: string,
): string {
  const formatted = formatMessagesForCompaction(messages);
  const trimmed = instructions?.trim();

  return trimmed
    ? `${formatted}\n\nThe user requested this compaction with instructions. Follow them when choosing what to preserve and emphasize:\n${trimmed}`
    : formatted;
}

function formatMessagesForCompaction(messages: ModelMessage[]): string {
  return messages
    .map((message, index) => {
      return `Message ${index + 1} (${message.role}):\n${stringifyMessageContent(message.content)}`;
    })
    .join("\n\n");
}

function stringifyMessageContent(content: ModelMessage["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

// Resolves provider-routed IDs against the shared model catalog and chooses the
// smallest matching provider window so the compaction threshold stays safe.
function modelContextLength(agentConfig: AgentConfig): number {
  const modelId = agentConfig.model?.modelId;
  if (!modelId) return DEFAULT_MODEL_CONTEXT_LENGTH;
  const identifiers = [modelId, modelId.split("/").at(-1) ?? modelId];
  const model = MODEL_CATALOG.find(
    (candidate): boolean =>
      identifiers.includes(candidate.id) ||
      ("aliases" in candidate &&
        candidate.aliases?.some((alias): boolean =>
          identifiers.includes(alias),
        )) ||
      candidate.providers.some((provider): boolean =>
        identifiers.includes(provider.externalId),
      ),
  );
  if (!model) return DEFAULT_MODEL_CONTEXT_LENGTH;
  const exactMappings = model.providers.filter((provider): boolean =>
    identifiers.includes(provider.externalId),
  );
  const contextLengths = (
    exactMappings.length > 0 ? exactMappings : model.providers
  )
    .map((provider): number | undefined => provider.contextSize)
    .filter(
      (contextLength): contextLength is number =>
        contextLength !== undefined && contextLength > 0,
    );

  return contextLengths.length > 0
    ? Math.min(...contextLengths)
    : DEFAULT_MODEL_CONTEXT_LENGTH;
}
