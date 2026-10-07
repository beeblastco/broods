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
const COMPACTION_MARKER = "<session-compaction-summary>";
const COMPACTION_MARKER_END = "</session-compaction-summary>";
const COMPACTION_MESSAGE_SEPARATOR = "\n\n";
const MODEL_CATALOG: readonly ModelDefinition[] = models;

export interface SummarizeConversationInput {
  accountId?: string;
  conversationKey: string;
  priorSummaries: SystemModelMessage[];
  messages: ModelMessage[];
  agentConfig: AgentConfig;
  // Extra focus for the summary model, from /compact <instructions>.
  instructions?: string;
}

/**
 * Whether a turn auto-compacts: on unless the agent turns it off, once the
 * turn's last model call reaches the configured ceiling or 80% of the model's
 * context window, whichever comes first, or when the provider refused the turn
 * for context length.
 */
export function shouldAutoCompact(
  agentConfig: AgentConfig,
  lastInputTokens: number | undefined,
  contextExceeded = false,
): boolean {
  const config = agentConfig.session?.autoCompaction;
  if (config?.enabled === false) return false;
  if (contextExceeded) return true;
  if (lastInputTokens === undefined) return false;
  const configuredMax =
    config?.maxContextLength ?? DEFAULT_AUTO_COMPACTION_MAX_CONTEXT_LENGTH;

  return (
    lastInputTokens >= Math.min(configuredMax, modelInputBudget(agentConfig))
  );
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

  const configuredModel = resolveConfiguredModel(
    input.agentConfig,
    input.accountId,
  );
  const providerOptions = providerOptionsFromModelConfig(input.agentConfig);
  const startedAt = Date.now();
  // One character per token is deliberately conservative, so the request fits
  // the share of the window the auto-compaction threshold leaves.
  const request = formatCompactionRequest(
    input.priorSummaries,
    messages,
    modelInputBudget(input.agentConfig),
    input.instructions,
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

// Per-call data rides the user message; the system prompt stays the static
// generated DEFAULT_COMPACTION_PROMPT so its prefix stays cacheable. History
// longer than `limit` characters drops its oldest whole messages and keeps the
// instructions. Prior summaries take the room the kept messages leave, so an
// oversized summary is cut before the newest message is. A newest message that
// still overflows on its own keeps its beginning.
function formatCompactionRequest(
  priorSummaries: SystemModelMessage[],
  messages: ModelMessage[],
  limit: number,
  instructions?: string,
): string {
  const trimmed = instructions?.trim();
  const suffix = trimmed
    ? `${COMPACTION_MESSAGE_SEPARATOR}The user requested this compaction with instructions. Follow them when choosing what to preserve and emphasize:\n${trimmed}`
    : "";
  const budget = Math.max(0, limit - suffix.length);
  const blocks = formatMessagesForCompaction([...priorSummaries, ...messages]);
  const summaryBlocks = blocks.slice(0, priorSummaries.length);
  const messageBlocks = blocks.slice(priorSummaries.length);
  let length = blocks.join(COMPACTION_MESSAGE_SEPARATOR).length;
  while (length > budget && messageBlocks.length > 1) {
    length -=
      (messageBlocks.shift()?.length ?? 0) +
      COMPACTION_MESSAGE_SEPARATOR.length;
  }
  const history = messageBlocks.join(COMPACTION_MESSAGE_SEPARATOR);
  const summaries = summaryBlocks
    .join(COMPACTION_MESSAGE_SEPARATOR)
    .slice(
      0,
      Math.max(
        0,
        budget - history.length - COMPACTION_MESSAGE_SEPARATOR.length,
      ),
    );
  const body = summaries
    ? `${summaries}${COMPACTION_MESSAGE_SEPARATOR}${history}`
    : history;

  return `${body.slice(0, budget)}${suffix}`;
}

function formatMessagesForCompaction(messages: ModelMessage[]): string[] {
  return messages.map((message, index): string => {
    return `Message ${index + 1} (${message.role}):\n${stringifyMessageContent(message.content)}`;
  });
}

// Resolves provider-routed IDs against the shared model catalog. The window of
// the configured provider, or of the upstream a gateway id like `xai/grok-4`
// names, wins; otherwise the smallest window among the matching provider IDs,
// then among all providers, keeps the threshold safe.
function modelContextLength(agentConfig: AgentConfig): number {
  const modelId = agentConfig.model?.modelId;
  if (!modelId) return DEFAULT_MODEL_CONTEXT_LENGTH;
  const parts = modelId.split("/");
  const routedProvider = parts.length > 1 ? parts[0] : undefined;
  const identifiers = [modelId, parts[parts.length - 1]];
  const model = MODEL_CATALOG.find(
    (candidate): boolean =>
      identifiers.includes(candidate.id) ||
      candidate.aliases?.some((alias): boolean =>
        identifiers.includes(alias),
      ) ||
      candidate.providers.some((provider): boolean =>
        identifiers.includes(provider.externalId),
      ),
  );
  if (!model) return DEFAULT_MODEL_CONTEXT_LENGTH;
  const configuredProviders = model.providers.filter(
    (provider): boolean =>
      provider.providerId === agentConfig.model?.provider ||
      provider.providerId === routedProvider,
  );
  const exactMappings = model.providers.filter((provider): boolean =>
    identifiers.includes(provider.externalId),
  );
  const pool =
    configuredProviders.length > 0
      ? configuredProviders
      : exactMappings.length > 0
        ? exactMappings
        : model.providers;
  const contextLengths = pool.flatMap((provider): number[] =>
    provider.contextSize ? [provider.contextSize] : [],
  );

  return contextLengths.length > 0
    ? Math.min(...contextLengths)
    : DEFAULT_MODEL_CONTEXT_LENGTH;
}

// 80% of the configured model's window: the auto-compaction threshold and the
// character limit of the summary request.
function modelInputBudget(agentConfig: AgentConfig): number {
  return Math.floor(
    modelContextLength(agentConfig) * AUTO_COMPACTION_CONTEXT_FRACTION,
  );
}

function stringifyMessageContent(content: ModelMessage["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}
