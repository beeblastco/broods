/**
 * Session pruning for model-visible conversation context.
 * Keep transient context cleanup here; persistence stays in session.ts.
 */

import { pruneMessages, type ModelMessage } from "ai";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import { STORED_ITEM_PROVIDERS } from "./provider.ts";

export function pruneSessionMessages(
  messages: ModelMessage[],
  agentConfig: AgentConfig,
): ModelMessage[] {
  const approvalResume = hasPendingToolApprovalResponse(messages);
  const retainsReasoning = retainsReasoningParts(agentConfig);
  const modelMessages =
    approvalResume || retainsReasoning
      ? messages
      : stripReasoningFromMessages(messages);
  // An approval resume keeps the assistant tool call its approvalId points at.
  const prunedToolCalls = approvalResume
    ? "before-last-2-messages"
    : "before-last-message";

  if (agentConfig.session?.pruning?.enabled === false) {
    return modelMessages;
  }

  return pruneMessages({
    messages: modelMessages,
    // Never `before-last-message` here. Half-stripping leaves older assistant
    // messages referencing stored items whose reasoning is gone, which is the
    // same rejection this retention exists to avoid, only deferred a turn.
    reasoning: "none",
    // A pruned tool call orphans its reasoning item on a stored-item provider.
    toolCalls: retainsReasoning ? "none" : prunedToolCalls,
    emptyMessages: "remove",
  });
}

/**
 * Whether reasoning must survive into the next model call. On a stored-item
 * provider it is not an optimization: the assistant message goes back as a
 * reference to the item the provider already holds, and the reference is
 * rejected without the reasoning item that produced it.
 */
export function retainsReasoningParts(agentConfig: AgentConfig): boolean {
  const provider = agentConfig.model?.provider;

  return provider !== undefined && STORED_ITEM_PROVIDERS.has(provider);
}

export function stripReasoningFromMessages(
  messages: ModelMessage[],
): ModelMessage[] {
  return pruneMessages({
    messages: messages,
    reasoning: "all",
    emptyMessages: "remove",
  });
}

export function hasPendingToolApprovalResponse(
  messages: ModelMessage[],
): boolean {
  const lastMessage = messages.at(-1);

  return (
    lastMessage?.role === "tool" &&
    lastMessage.content.length > 0 &&
    lastMessage.content.every((part) => part.type === "tool-approval-response")
  );
}
