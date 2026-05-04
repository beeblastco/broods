/**
 * Session compaction for persisted conversation context.
 * Keep threshold checks and summary generation here; storage stays in session.ts.
 */

import { generateText, type ModelMessage, type SystemModelMessage } from "ai";
import { DEFAULT_COMPACTION_PROMPT } from "../_shared/.generated/compaction-prompt.ts";
import type { AccountConfig } from "../_shared/accounts.ts";
import { logInfo } from "../_shared/log.ts";
import { modelSettingsFromModelConfig, resolveConfiguredModel } from "./model.ts";

const DEFAULT_COMPACTION_MAX_CONTEXT_LENGTH = 100_000; // Runtime default when compaction is enabled without a max.
const COMPACTION_MARKER = "<session-compaction-summary>";
const COMPACTION_MARKER_END = "</session-compaction-summary>";

export interface CompactionInput {
  conversationKey: string;
  system: SystemModelMessage[];
  messages: ModelMessage[];
  accountConfig: AccountConfig;
}


export async function compactSessionContext(input: CompactionInput): Promise<SystemModelMessage | null> {
  const compactionConfig = input.accountConfig.session?.compaction;
  if (compactionConfig?.enabled !== true) {
    return null;
  }

  const maxContextLength = compactionConfig.maxContextLength ?? DEFAULT_COMPACTION_MAX_CONTEXT_LENGTH;
  if (estimateContextLength(input.system, input.messages) <= maxContextLength) {
    return null;
  }

  const keepLastMessage = input.messages.at(-1)?.role === "user";
  const compactableMessages = keepLastMessage ? input.messages.slice(0, -1) : input.messages;
  const priorSummaries = input.system.filter(isCompactionSummaryMessage);
  const compactableContext = [...priorSummaries, ...compactableMessages];
  if (compactableContext.length === 0) {
    return null;
  }

  const configuredModel = resolveConfiguredModel(input.accountConfig);
  const result = await generateText({
    ...modelSettingsFromModelConfig(input.accountConfig),
    model: configuredModel.model,
    system: DEFAULT_COMPACTION_PROMPT,
    messages: [{
      role: "user",
      content: formatMessagesForCompaction(compactableContext),
    }],
    ...(input.accountConfig.model?.options ? { providerOptions: input.accountConfig.model.options as never } : {}),
  });

  const summary = createCompactionSummaryMessage(result.text);
  logInfo("Session context compacted", {
    conversationKey: input.conversationKey,
    messageCount: input.messages.length,
    compactedMessageCount: compactableContext.length,
    maxContextLength,
  });

  return summary;
}

export function isCompactionSummaryMessage(message: SystemModelMessage): boolean {
  return typeof message.content === "string" && message.content.startsWith(COMPACTION_MARKER);
}

export function estimateContextLength(system: SystemModelMessage[], messages: ModelMessage[]): number {
  // This is a serialized character count, not a word/token count.
  // It is a cheap provider-independent threshold for the MVP compaction trigger.
  return JSON.stringify({ system, messages }).length;
}

function createCompactionSummaryMessage(summary: string): SystemModelMessage {
  return {
    role: "system",
    content: `${COMPACTION_MARKER}\nThe following is a compacted summary of earlier conversation history. Treat it as context for this conversation and prefer newer explicit messages when they conflict.\n\n${summary.trim()}\n${COMPACTION_MARKER_END}`,
  };
}

function formatMessagesForCompaction(messages: ModelMessage[]): string {
  return messages.map((message, index) => {
    return `Message ${index + 1} (${message.role}):\n${stringifyMessageContent(message.content)}`;
  }).join("\n\n");
}

function stringifyMessageContent(content: ModelMessage["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}
