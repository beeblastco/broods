/**
 * Session compaction for persisted conversation context.
 * Keep threshold checks and summary generation here; storage stays in session.ts.
 */

import { generateText, type ModelMessage, type SystemModelMessage } from "ai";
import { DEFAULT_COMPACTION_PROMPT } from "../_shared/.generated/compaction-prompt.ts";
import type { AgentConfig } from "../_shared/storage/index.ts";
import { logInfo } from "../_shared/log.ts";
import { modelSettingsFromModelConfig, resolveConfiguredModel } from "./provider.ts";
import { hasPendingToolApprovalResponse, stripReasoningFromMessages } from "./pruning.ts";

const DEFAULT_COMPACTION_MAX_CONTEXT_LENGTH = 100_000; // Runtime default when compaction is enabled without a max.
const COMPACTION_MARKER = "<session-compaction-summary>";
const COMPACTION_MARKER_END = "</session-compaction-summary>";

export interface CompactionInput {
  conversationKey: string;
  system: SystemModelMessage[];
  messages: ModelMessage[];
  agentConfig: AgentConfig;
}


export async function compactSessionContext(input: CompactionInput): Promise<SystemModelMessage | null> {
  const compactionConfig = input.agentConfig.session?.compaction;
  if (compactionConfig?.enabled !== true) {
    return null;
  }
  if (hasPendingToolApprovalResponse(input.messages)) {
    return null;
  }

  const messages = stripReasoningFromMessages(input.messages);
  const maxContextLength = compactionConfig.maxContextLength ?? DEFAULT_COMPACTION_MAX_CONTEXT_LENGTH;
  if (estimateContextLength(input.system, messages) <= maxContextLength) {
    return null;
  }

  const keepLastMessage = messages.at(-1)?.role === "user";
  const compactableMessages = keepLastMessage ? messages.slice(0, -1) : messages;
  const priorSummaries = input.system.filter(isCompactionSummaryMessage);
  const compactableContext = [...priorSummaries, ...compactableMessages];
  if (compactableContext.length === 0) {
    return null;
  }

  const configuredModel = resolveConfiguredModel(input.agentConfig);
  const result = await generateText({
    ...modelSettingsFromModelConfig(input.agentConfig),
    model: configuredModel.model,
    system: DEFAULT_COMPACTION_PROMPT,
    messages: [{
      role: "user",
      content: formatMessagesForCompaction(compactableContext),
    }],
    ...(input.agentConfig.model?.options ? { providerOptions: input.agentConfig.model.options as never } : {}),
  });

  const summary = createCompactionSummaryMessage(result.text);
  logInfo("Session context compacted", {
    conversationKey: input.conversationKey,
    messageCount: messages.length,
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
