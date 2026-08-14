/**
 * Inter-session message targeting and ingress construction.
 * Keep worker admission and scheduling in the request handler.
 */

import {
  accountAgentScopedKey,
  parseAccountAgentScopedKey,
  publicConversationKeyFromScoped,
} from "../shared/runtime-keys.ts";
import {
  getConversationDispatchTarget,
  type IngressDelivery,
  type SessionMessageInput,
} from "./ingress.ts";
import type { DirectInboundEvent } from "./integrations.ts";
import type { Session } from "./session.ts";

export interface PreparedSessionMessage {
  delivery: IngressDelivery;
  event: DirectInboundEvent;
  publicConversationKey: string;
}

export async function prepareSessionMessage(
  session: Session,
  input: SessionMessageInput,
): Promise<PreparedSessionMessage> {
  if (!session.accountId || !session.agentId) {
    throw new Error("Session messaging requires account and agent scope");
  }
  const requestedKey = input.conversationKey.trim();
  if (!requestedKey || !input.message.trim()) {
    throw new Error("Target conversation and message must not be empty");
  }
  const requestedScope = parseAccountAgentScopedKey(requestedKey);
  if (requestedKey.startsWith("acct:") && !requestedScope) {
    throw new Error("Target conversation key is invalid");
  }
  if (
    requestedScope &&
    (requestedScope.accountId !== session.accountId ||
      requestedScope.agentId !== session.agentId)
  ) {
    throw new Error("Target conversation must belong to the current agent");
  }
  const conversationKey = requestedScope
    ? requestedKey
    : accountAgentScopedKey(session.accountId, session.agentId, requestedKey);
  if (conversationKey === session.conversationKey) {
    throw new Error("send-message cannot target the current conversation");
  }
  const target = await getConversationDispatchTarget({
    accountId: session.accountId,
    agentId: session.agentId,
    conversationKey: conversationKey,
  });
  if (!target) {
    throw new Error("Target conversation is not an existing channel session");
  }
  const publicEventId = `session-message-${crypto.randomUUID()}`;
  const eventId = accountAgentScopedKey(
    session.accountId,
    session.agentId,
    publicEventId,
  );
  const publicConversationKey = publicConversationKeyFromScoped(
    conversationKey,
    session.accountId,
    session.agentId,
  );
  const event: DirectInboundEvent = {
    accountId: session.accountId,
    agentId: session.agentId,
    agentConfig: target.agentConfig,
    eventId: eventId,
    publicEventId: publicEventId,
    conversationKey: conversationKey,
    publicConversationKey: publicConversationKey,
    events: [
      {
        role: "user",
        content: `[Inter-session message from ${publicConversationKeyFromScoped(
          session.conversationKey,
          session.accountId,
          session.agentId,
        )}]\n${input.message}`,
      },
    ],
    requestedMode: "followup",
    idempotencyKey: eventId,
    replyTarget: {
      channelName: target.channelName,
      source: target.source,
    },
  };

  return {
    delivery: {
      kind: "channel",
      channel: target.channelName,
      source: target.source,
    },
    event: event,
    publicConversationKey: publicConversationKey,
  };
}
