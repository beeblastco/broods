/**
 * Session compaction for persisted conversation context.
 * Keep threshold checks and summary generation here; storage stays in session.ts.
 */

import { generateText, type ModelMessage, type SystemModelMessage } from "ai";
import { DEFAULT_COMPACTION_PROMPT } from "../shared/.generated/compaction-prompt.ts";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import { logInfo } from "../shared/log.ts";
import {
  modelSettingsFromModelConfig,
  providerOptionsFromModelConfig,
  resolveConfiguredModel,
} from "./provider.ts";
import {
  hasPendingToolApprovalResponse,
  stripReasoningFromMessages,
} from "./pruning.ts";

const DEFAULT_COMPACTION_MAX_CONTEXT_LENGTH = 100_000; // Runtime default when compaction is enabled without a max.
const COMPACTION_MARKER = "<session-compaction-summary>";
const COMPACTION_MARKER_END = "</session-compaction-summary>";

export interface CompactionInput {
  conversationKey: string;
  system: SystemModelMessage[];
  messages: ModelMessage[];
  agentConfig: AgentConfig;
}

export interface SummarizeConversationInput {
  conversationKey: string;
  priorSummaries: SystemModelMessage[];
  messages: ModelMessage[];
  agentConfig: AgentConfig;
  // Extra focus for the summary model, from /compact <instructions>.
  instructions?: string;
}

/**
 * The automatic compaction gate: compacts only when the agent's compaction
 * config enables it and the serialized context exceeds the configured max.
 */
export async function compactSessionContext(
  input: CompactionInput,
): Promise<SystemModelMessage | null> {
  const compactionConfig = input.agentConfig.session?.compaction;
  if (compactionConfig?.enabled !== true) {
    return null;
  }
  if (hasPendingToolApprovalResponse(input.messages)) {
    return null;
  }

  const messages = stripReasoningFromMessages(input.messages);
  const maxContextLength =
    compactionConfig.maxContextLength ?? DEFAULT_COMPACTION_MAX_CONTEXT_LENGTH;
  if (estimateContextLength(input.system, messages) <= maxContextLength) {
    return null;
  }

  // The active turn resumes after compaction, so a pending user message stays
  // out of the summary.
  const keepLastMessage = messages.at(-1)?.role === "user";

  return summarizeConversation({
    conversationKey: input.conversationKey,
    priorSummaries: input.system.filter(isCompactionSummaryMessage),
    messages: keepLastMessage ? messages.slice(0, -1) : messages,
    agentConfig: input.agentConfig,
  });
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
        content: formatCompactionRequest(
          compactableContext,
          input.instructions,
        ),
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

export function isCompactionSummaryMessage(
  message: SystemModelMessage,
): boolean {
  return (
    typeof message.content === "string" &&
    message.content.startsWith(COMPACTION_MARKER)
  );
}

export function estimateContextLength(
  system: SystemModelMessage[],
  messages: ModelMessage[],
): number {
  // This is a serialized character count, not a word/token count.
  // It is a cheap provider-independent threshold for the MVP compaction trigger.
  return JSON.stringify({ system: system, messages: messages }).length;
}

function createCompactionSummaryMessage(summary: string): SystemModelMessage {
  return {
    role: "system",
    content: `${COMPACTION_MARKER}\nThe following is a compacted summary of earlier conversation history. Treat it as context for this conversation and prefer newer explicit messages when they conflict.\n\n${summary.trim()}\n${COMPACTION_MARKER_END}`,
  };
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
