/**
 * Pancake channel adapter.
 * Keep Pancake webhook normalization and outbound message API calls here.
 */

import { createHash } from "node:crypto";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult,
} from "./channels.ts";
import { logWarn } from "./log.ts";
import { PANCAKE_INTEGRATION_PREFIX } from "./runtime-keys.ts";

interface PancakeWebhookPayload {
  page_id?: string;
  event_type?: string;
  data?: {
    conversation?: PancakeConversation;
    message?: PancakeMessage;
    post?: PancakePost | null;
  };
}

interface PancakeConversation {
  id?: string;
  type?: string;
  from?: {
    id?: string;
    name?: string;
  };
}

interface PancakeMessage {
  id?: string;
  conversation_id?: string;
  page_id?: string;
  message?: string;
  original_message?: string;
  type?: string;
  inserted_at?: string;
  from?: {
    id?: string;
    name?: string;
    page_customer_id?: string;
  };
  is_hidden?: boolean;
  is_removed?: boolean;
}

interface PancakePost {
  id?: string;
}

export interface PancakeSource {
  pageId: string;
  conversationId: string;
  messageId: string;
  messageType: "INBOX" | "COMMENT";
  postId?: string;
  fromId?: string;
  fromName?: string;
  pageCustomerId?: string;
  insertedAt?: string;
  rawPayload?: unknown;
}

export function createPancakeChannel(
  pageId: string,
  pageAccessToken: string,
  senderId?: string,
): ChannelAdapter {
  return {
    name: "pancake",

    canHandle(req) {
      return req.method === "POST";
    },

    authenticate() {
      return true;
    },

    parse(req): ChannelParseResult {
      const payload = JSON.parse(req.body) as PancakeWebhookPayload;

      if (payload.event_type !== "messaging") {
        return { kind: "ignore" };
      }

      if (payload.page_id !== pageId) {
        logWarn("Pancake page not in allow list", { pageId: payload.page_id });
        return { kind: "ignore" };
      }

      const conversation = payload.data?.conversation;
      const message = payload.data?.message;
      const text = message?.message?.trim();
      if (!conversation?.id || !message?.id || !text || !isPancakeMessageType(message.type)) {
        return { kind: "ignore" };
      }

      if (message.is_hidden || message.is_removed || message.from?.id === pageId) {
        return { kind: "ignore" };
      }

      return {
        kind: "message",
        ack: { statusCode: 200 },
        message: {
          eventId: `${PANCAKE_INTEGRATION_PREFIX}${pageId}:${message.id}:${hashEventText(text)}`,
          conversationKey: `${PANCAKE_INTEGRATION_PREFIX}${pageId}:${conversation.id}`,
          channelName: "pancake",
          content: [{ type: "text", text }],
          source: {
            pageId,
            conversationId: conversation.id,
            messageId: message.id,
            messageType: message.type,
            postId: payload.data?.post?.id,
            fromId: message.from?.id ?? conversation.from?.id,
            fromName: message.from?.name ?? conversation.from?.name,
            pageCustomerId: message.from?.page_customer_id,
            insertedAt: message.inserted_at,
            rawPayload: payload,
          } satisfies PancakeSource,
        },
      };
    },

    actions(msg): ChannelActions {
      return createPancakeActions(pageAccessToken, toPancakeSource(msg.source), senderId);
    },
  };
}

export function createPancakeActions(
  pageAccessToken: string,
  source: PancakeSource,
  senderId?: string,
): ChannelActions {
  return {
    sendText: (text) => sendPancakeMessage(pageAccessToken, source, text, senderId),
    async sendTyping() {
      return;
    },
    async reactToMessage() {
      return;
    },
  };
}

async function sendPancakeMessage(
  pageAccessToken: string,
  source: PancakeSource,
  text: string,
  senderId?: string,
): Promise<void> {
  const url = new URL(
    `https://pages.fm/api/public_api/v1/pages/${encodeURIComponent(source.pageId)}/conversations/${
      encodeURIComponent(source.conversationId)
    }/messages`,
  );
  url.searchParams.set("page_access_token", pageAccessToken);

  const payload = source.messageType === "COMMENT"
    ? {
      action: "reply_comment",
      message_id: source.messageId,
      message: text,
      ...(senderId ? { sender_id: senderId } : {}),
    }
    : {
      action: "reply_inbox",
      message: text,
      ...(senderId ? { sender_id: senderId } : {}),
    };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const bodyText = await response.text();
  const body = parseJsonBody(bodyText);

  if (!response.ok || body?.success === false) {
    throw new Error(
      `Pancake send message failed (${response.status}): ${formatPancakeError(body, bodyText)}`,
    );
  }
}

function toPancakeSource(source: Record<string, unknown>): PancakeSource {
  if (
    typeof source.pageId !== "string" ||
    typeof source.conversationId !== "string" ||
    typeof source.messageId !== "string" ||
    !isPancakeMessageType(source.messageType)
  ) {
    throw new Error("Invalid Pancake source payload");
  }

  return {
    pageId: source.pageId,
    conversationId: source.conversationId,
    messageId: source.messageId,
    messageType: source.messageType,
    postId: typeof source.postId === "string" ? source.postId : undefined,
    fromId: typeof source.fromId === "string" ? source.fromId : undefined,
    fromName: typeof source.fromName === "string" ? source.fromName : undefined,
    pageCustomerId: typeof source.pageCustomerId === "string" ? source.pageCustomerId : undefined,
    insertedAt: typeof source.insertedAt === "string" ? source.insertedAt : undefined,
    rawPayload: source.rawPayload,
  };
}

function isPancakeMessageType(value: unknown): value is PancakeSource["messageType"] {
  return value === "INBOX" || value === "COMMENT";
}

function hashEventText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function parseJsonBody(text: string): { success?: boolean; message?: string } | null {
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? parsed as { success?: boolean; message?: string } : null;
  } catch {
    return null;
  }
}

function formatPancakeError(body: { message?: string } | null, bodyText: string): string {
  return body?.message ?? (bodyText || "unknown_error");
}
