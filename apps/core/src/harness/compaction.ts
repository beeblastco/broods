/**
 * Session compaction for persisted conversation context.
 * Keep the auto-compaction threshold and summary generation here; storage
 * stays in session.ts.
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
import { stripReasoningFromMessages } from "./pruning.ts";

// Input tokens of a turn's last model call that start an auto-compaction.
const DEFAULT_AUTO_COMPACTION_MAX_CONTEXT_LENGTH = 500_000;
const COMPACTION_MARKER = "<session-compaction-summary>";
const COMPACTION_MARKER_END = "</session-compaction-summary>";

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
 * Whether a finished turn auto-compacts: on unless the agent turns it off, once
 * the turn's last model call read `maxContextLength` input tokens or more.
 */
export function shouldAutoCompact(
  agentConfig: AgentConfig,
  lastInputTokens: number | undefined,
): boolean {
  const config = agentConfig.session?.autoCompaction;
  if (config?.enabled === false || lastInputTokens === undefined) return false;

  return (
    lastInputTokens >=
    (config?.maxContextLength ?? DEFAULT_AUTO_COMPACTION_MAX_CONTEXT_LENGTH)
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
