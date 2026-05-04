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
    toolCalls: "before-last-message",
    emptyMessages: "remove",
  });
}
