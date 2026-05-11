/**
 * Session pruning for model-visible conversation context.
 * Keep transient context cleanup here; persistence stays in session.ts.
 */

import { pruneMessages, type ModelMessage } from "ai";
import type { AccountConfig } from "../_shared/accounts.ts";

export function pruneSessionMessages(messages: ModelMessage[], accountConfig: AccountConfig): ModelMessage[] {
  if (accountConfig.session?.pruning?.enabled === false) {
    return messages;
  }

  return pruneMessages({
    messages,
    reasoning: "before-last-message",
    // A final approval response needs the preceding assistant tool-call preserved
    // so the AI SDK can match approvalId -> toolCallId on the next model run.
    toolCalls: hasPendingToolApprovalResponse(messages) ? "before-last-2-messages" : "before-last-message",
    emptyMessages: "remove",
  });
}

function hasPendingToolApprovalResponse(messages: ModelMessage[]): boolean {
  const lastMessage = messages.at(-1);
  return lastMessage?.role === "tool" &&
    lastMessage.content.length > 0 &&
    lastMessage.content.every((part) => part.type === "tool-approval-response");
}
