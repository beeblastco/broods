/**
 * Pancake channel adapter.
 * Keep Pancake webhook normalization and outbound message API calls here.
 * 
 * Pancake channle have options:
 * - handoff tags id which will skip processing based on specific tags `PancakeHandoffOptions`
 */

import { createHash } from "node:crypto";
import { timingSafeStringEqual } from "./auth.ts";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult,
  ChannelRequest,
  ParsedChannelMessage,
} from "./channels.ts";
import { logInfo, logWarn } from "./log.ts";
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
  tags?: unknown[];
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
  tagIds?: string[];
}

export interface PancakeHandoffOptions {
  tagIds: string[];
}

export interface PancakeChannelOptions {
  accountId?: string;
  agentId?: string;
  configOptions?: Record<string, unknown>;
}

export function createPancakeChannel(
  pageId: string,
  pageAccessToken: string,
  webhookSecret: string,
  senderId?: string,
  options: PancakeChannelOptions = {},
): ChannelAdapter {
  const handoff = resolvePancakeHandoffOptions(options.configOptions);

  return {
    name: "pancake",

    canHandle(req) {
      return req.method === "POST";
    },

    // Pancake sends no signature header; the webhook URL carries the secret as
    // a ?secret= query parameter instead.
    authenticate(req) {
      const provided = new URLSearchParams(req.rawQueryString).get("secret");
      return Boolean(provided) && timingSafeStringEqual(provided!, webhookSecret);
    },

    parse(req): ChannelParseResult | Promise<ChannelParseResult> {
      const parsed = parsePancakeWebhook(req, pageId);
      if (parsed.kind !== "message" || !handoff) {
        return parsed;
      }

      return applyPancakeHandoffTag(handoff, parsed);
    },

    actions(msg): ChannelActions {
      return createPancakeActions(pageAccessToken, toPancakeSource(msg.source), senderId);
    },
  };
}

function resolvePancakeHandoffOptions(configOptions: Record<string, unknown> | undefined): PancakeHandoffOptions | null {
  const tagIds = normalizePancakeTagIds(configOptions?.ignoreTagIds);
  if (tagIds.length === 0) {
    return null;
  }
  return { tagIds };
}

function parsePancakeWebhook(req: ChannelRequest, pageId: string): ChannelParseResult {
  const payload = JSON.parse(req.body) as PancakeWebhookPayload;
  logInfo("Pancake webhook received", {
    configuredPageId: pageId,
    payloadPageId: payload.page_id,
    eventType: payload.event_type,
    conversationId: payload.data?.conversation?.id,
    messageId: payload.data?.message?.id,
    messageType: payload.data?.message?.type,
    fromId: payload.data?.message?.from?.id ?? payload.data?.conversation?.from?.id,
    fromName: payload.data?.message?.from?.name ?? payload.data?.conversation?.from?.name,
    pageCustomerId: payload.data?.message?.from?.page_customer_id,
    tagIds: normalizePancakeTagIds(payload.data?.conversation?.tags),
  });

  if (payload.event_type !== "messaging") {
    logInfo("Pancake webhook ignored", {
      reason: "unsupported_event_type",
      eventType: payload.event_type,
      pageId: payload.page_id,
    });
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
    logInfo("Pancake webhook ignored", {
      reason: "missing_or_unsupported_message",
      pageId: payload.page_id,
      conversationId: conversation?.id,
      messageId: message?.id,
      hasText: Boolean(text),
      messageType: message?.type,
    });
    return { kind: "ignore" };
  }

  if (message.is_hidden || message.is_removed || message.from?.id === pageId || !message.from?.page_customer_id) {
    logInfo("Pancake webhook ignored", {
      reason: message.is_hidden
        ? "hidden_message"
        : message.is_removed
          ? "removed_message"
          : message.from?.id === pageId
            ? "page_originated_message"
            : "missing_page_customer_id",
      pageId: payload.page_id,
      conversationId: conversation.id,
      messageId: message.id,
      fromId: message.from?.id,
      pageCustomerId: message.from?.page_customer_id,
    });
    return { kind: "ignore" };
  }

  logInfo("Pancake webhook accepted", {
    pageId,
    conversationId: conversation.id,
    messageId: message.id,
    messageType: message.type,
    textLength: text.length,
    tagIds: normalizePancakeTagIds(conversation.tags),
  });

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
        tagIds: normalizePancakeTagIds(conversation.tags),
      } satisfies PancakeSource,
    },
  };
}

function applyPancakeHandoffTag(
  config: PancakeHandoffOptions,
  parsed: ParsedChannelMessage,
): ChannelParseResult {
  const tagIds = normalizePancakeTagIds(parsed.message.source.tagIds);
  const matchedTagId = config.tagIds.find((tagId) => tagIds.includes(tagId));
  if (!matchedTagId) {
    return parsed;
  }

  logInfo("Pancake handoff tag skipped agent reply", {
    conversationKey: parsed.message.conversationKey,
    tagId: matchedTagId,
  });

  return {
    kind: "ignore",
    response: parsed.ack ?? { statusCode: 200 },
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

  logInfo("Pancake send message request", {
    pageId: source.pageId,
    conversationId: source.conversationId,
    messageType: source.messageType,
    replyToMessageId: source.messageId,
    hasSenderId: Boolean(senderId),
    textLength: text.length,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const bodyText = await response.text();
  const body = parseJsonBody(bodyText);

  if (!response.ok || body?.success === false) {
    logWarn("Pancake send message failed", {
      pageId: source.pageId,
      conversationId: source.conversationId,
      status: response.status,
      error: formatPancakeError(body, bodyText),
    });
    throw new Error(
      `Pancake send message failed (${response.status}): ${formatPancakeError(body, bodyText)}`,
    );
  }

  logInfo("Pancake send message succeeded", {
    pageId: source.pageId,
    conversationId: source.conversationId,
    status: response.status,
    responseMessage: body?.message,
  });
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
  };
}

function normalizePancakeTagIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((tag) => {
    if (typeof tag === "string" || typeof tag === "number") {
      return [String(tag)];
    }
    return [];
  });
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
