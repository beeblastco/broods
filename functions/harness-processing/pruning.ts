/**
 * Session pruning for model-visible conversation context.
 * Keep transient context cleanup here; persistence stays in session.ts.
 */

import { pruneMessages, type ModelMessage } from "ai";
import type { AgentConfig } from "../_shared/storage/index.ts";

export function pruneSessionMessages(messages: ModelMessage[], agentConfig: AgentConfig): ModelMessage[] {
  const approvalResume = hasPendingToolApprovalResponse(messages);
  const modelMessages = approvalResume ? messages : stripReasoningFromMessages(messages);

  if (agentConfig.session?.pruning?.enabled === false) {
    return modelMessages;
  }

  return pruneMessages({
    messages: modelMessages,
    reasoning: "none",
    // A final approval response needs the preceding assistant tool-call preserved
    // so the AI SDK can match approvalId -> toolCallId on the next model run.
    toolCalls: approvalResume ? "before-last-2-messages" : "before-last-message",
    emptyMessages: "remove",
  });
}

export function stripReasoningFromMessages(messages: ModelMessage[]): ModelMessage[] {
  return pruneMessages({
    messages,
    reasoning: "all",
    emptyMessages: "remove",
  });
}

export function hasPendingToolApprovalResponse(messages: ModelMessage[]): boolean {
  const lastMessage = messages.at(-1);
  return lastMessage?.role === "tool" &&
    lastMessage.content.length > 0 &&
    lastMessage.content.every((part) => part.type === "tool-approval-response");
}
