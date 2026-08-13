/**
 * Zalo channel adapter.
 * Keep official Zalo Bot API webhook normalization and outbound API calls here.
 */

import { timingSafeEqual } from "node:crypto";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult,
} from "./channels.ts";
import { logWarn } from "./log.ts";
import { ZALO_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const ZALO_API_BASE = "https://bot-api.zaloplatforms.com";
const ZALO_TEXT_LIMIT = 2000;
const ZALO_CHAT_TYPES = ["PRIVATE", "GROUP"] as const;

interface ZaloWebhookEnvelope {
  ok?: boolean;
  result?: unknown;
}

interface ZaloUpdate {
  event_name?: string;
  message?: ZaloMessage;
}

interface ZaloMessage {
  message_id?: string;
  from?: {
    id?: string;
    name?: string;
    display_name?: string;
    is_bot?: boolean;
  };
  chat?: {
    id?: string;
    chat_type?: string;
  };
  date?: number;
  text?: string;
}

interface ZaloApiResponse<T = unknown> {
  ok?: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

export type ZaloChatType = (typeof ZALO_CHAT_TYPES)[number];

export interface ZaloSource {
  chatId: string;
  chatType: ZaloChatType;
  messageId: string;
  senderId: string;
  senderName?: string;
  eventName: string;
  date?: number;
}

export interface ZaloChannelOptions {
  allowedUserIds?: ReadonlySet<string>;
  allowedGroupIds?: ReadonlySet<string>;
}

export function createZaloChannel(
  botToken: string,
  webhookSecret: string,
  options: ZaloChannelOptions = {},
): ChannelAdapter {
  const { allowedUserIds, allowedGroupIds } = options;

  return {
    name: "zalo",

    canHandle: function(req) {
      return req.method === "POST";
    },

    authenticate: function(req) {
      return verifyWebhookSecret(
        req.headers["x-bot-api-secret-token"],
        webhookSecret,
      );
    },

    parse: function(req): ChannelParseResult {
      const update = unwrapZaloUpdate(JSON.parse(req.body) as unknown);
      const eventName =
        typeof update.event_name === "string"
          ? update.event_name.slice(0, 128)
          : "missing";
      if (eventName !== "message.text.received") {

        return ignoreZaloUpdate(update, `unsupported_event:${eventName}`);
      }

      const message = update.message;
      const chatId = message?.chat?.id;
      const senderId = message?.from?.id;
      const messageId = message?.message_id;
      const chatType = message?.chat?.chat_type;
      if (!messageId) {

        return ignoreZaloUpdate(update, "missing_message_id");
      }
      if (!chatId) {

        return ignoreZaloUpdate(update, "missing_chat_id");
      }
      if (!senderId) {

        return ignoreZaloUpdate(update, "missing_sender_id");
      }
      if (!isZaloChatType(chatType)) {

        return ignoreZaloUpdate(
          update,
          `unsupported_chat_type:${chatType ?? "missing"}`,
        );
      }
      if (message?.from?.is_bot) {

        return ignoreZaloUpdate(update, "bot_message");
      }
      if (
        chatType === "GROUP" &&
        allowedGroupIds?.size &&
        !allowedGroupIds.has(chatId)
      ) {
        logWarn("Zalo group not in allow list", { chatId: chatId });

        return ignoreZaloUpdate(update, `group_not_allowed:${chatId}`);
      }
      if (allowedUserIds?.size && !allowedUserIds.has(senderId)) {
        logWarn("Zalo sender not in allow list", { senderId: senderId });

        return ignoreZaloUpdate(update, `sender_not_allowed:${senderId}`);
      }

      const source: Record<string, unknown> = {
        chatId: chatId,
        chatType: chatType,
        messageId: messageId,
        senderId: senderId,
        senderName: message.from?.display_name ?? message.from?.name,
        eventName: eventName,
        date: message.date,
      };

      const inbound = {
        eventId: `${ZALO_INTEGRATION_PREFIX}${eventName}:${chatId}:${senderId}:${messageId}`,
        conversationKey: `${ZALO_INTEGRATION_PREFIX}${chatId}`,
        channelName: "zalo",
        identity: {
          channelId: chatId,
          ...(senderId ? { actorId: senderId } : {}),
          ...((message.from?.display_name ?? message.from?.name)
            ? {
                actorName: message.from?.display_name ?? message.from?.name,
              }
            : {}),
        },
        source: source,
      };

      const text =
        typeof message.text === "string" ? message.text.trim() : undefined;
      if (!text) {

        return ignoreZaloUpdate(update, "missing_text");
      }

      return {
        kind: "message",
        ack: { statusCode: 200, body: "ok" },
        message: { ...inbound, content: text },
      };
    },

    actions: function(msg): ChannelActions {
      return createZaloActions(botToken, toZaloSource(msg.source));
    },
  };
}

export function createZaloActions(
  botToken: string,
  source: ZaloSource,
): ChannelActions {
  return {
    sendText: async function(text) {
      for (const chunk of chunkZaloText(text)) {
        await callZaloApi(botToken, "sendMessage", {
          chat_id: source.chatId,
          text: chunk,
        });
      }
    },
    sendTyping: async function() {
      await callZaloApi(botToken, "sendChatAction", {
        chat_id: source.chatId,
        action: "typing",
      });
    },
    reactToMessage: async function() {
      return;
    },
  };
}

async function callZaloApi(
  botToken: string,
  method: "sendMessage" | "sendChatAction",
  body: Record<string, unknown>,
): Promise<ZaloApiResponse> {
  const response = await fetch(`${ZALO_API_BASE}/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const bodyText = await response.text();
  const parsed = parseJsonBody(bodyText);

  if (!response.ok || parsed?.ok === false) {
    throw new Error(
      `Zalo ${method} failed (${response.status}): ${formatZaloError(parsed, bodyText)}`,
    );
  }

  return parsed ?? { ok: true };
}

function chunkZaloText(text: string): string[] {
  if (text.length === 0) {

    return [""];
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += ZALO_TEXT_LIMIT) {
    chunks.push(text.slice(offset, offset + ZALO_TEXT_LIMIT));
  }

  return chunks;
}

function describeZaloUpdate(update: ZaloUpdate): string {
  const message = update.message;
  const messageRecord =
    message && typeof message === "object"
      ? (message as unknown as Record<string, unknown>)
      : null;
  const messageFields = messageRecord ? Object.keys(messageRecord).sort() : [];
  const text = message?.text;
  const details = {
    updateFields: Object.keys(update).sort(),
    eventName:
      typeof update.event_name === "string"
        ? update.event_name.slice(0, 128)
        : null,
    eventNameType: typeof update.event_name,
    messageFields: messageFields,
    messageFieldTypes: Object.fromEntries(
      messageFields.map((field) => {
        const value = messageRecord?.[field];

        return [
          field,
          Array.isArray(value)
            ? "array"
            : value === null
              ? "null"
              : typeof value,
        ];
      }),
    ),
    nestedMessageFields: Object.fromEntries(
      messageFields.flatMap((field) => {
        const value = messageRecord?.[field];
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return [];
        }

        return [[field, Object.keys(value).sort()]];
      }),
    ),
    messageIdPresent: Boolean(message?.message_id),
    chatIdPresent: Boolean(message?.chat?.id),
    senderIdPresent: Boolean(message?.from?.id),
    chatType: message?.chat?.chat_type ?? null,
    isBot: message?.from?.is_bot ?? null,
    textType: Array.isArray(text) ? "array" : typeof text,
    textFields:
      text && typeof text === "object" ? Object.keys(text).sort() : [],
    textLength: typeof text === "string" ? text.length : null,
  };

  return `details=${JSON.stringify(details)}`;
}

function formatZaloError(
  body: ZaloApiResponse | null,
  bodyText: string,
): string {
  return (
    body?.description ??
    body?.error_code?.toString() ??
    (bodyText || "unknown_error")
  );
}

function ignoreZaloUpdate(
  update: ZaloUpdate,
  reason: string,
): ChannelParseResult {
  return {
    kind: "ignore",
    reason: `${reason} ${describeZaloUpdate(update)}`,
  };
}

function isZaloChatType(value: unknown): value is ZaloChatType {
  return ZALO_CHAT_TYPES.includes(value as ZaloChatType);
}

function parseJsonBody(text: string): ZaloApiResponse | null {
  if (!text) {

    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;

    return parsed && typeof parsed === "object"
      ? (parsed as ZaloApiResponse)
      : null;
  } catch {
    return null;
  }
}

function toZaloSource(source: Record<string, unknown>): ZaloSource {
  if (
    typeof source.chatId !== "string" ||
    !isZaloChatType(source.chatType) ||
    typeof source.messageId !== "string" ||
    typeof source.senderId !== "string" ||
    typeof source.eventName !== "string"
  ) {
    throw new Error("Invalid Zalo source payload");
  }

  return {
    chatId: source.chatId,
    chatType: source.chatType,
    messageId: source.messageId,
    senderId: source.senderId,
    senderName:
      typeof source.senderName === "string" ? source.senderName : undefined,
    eventName: source.eventName,
    date: typeof source.date === "number" ? source.date : undefined,
  };
}

function unwrapZaloUpdate(raw: unknown): ZaloUpdate {
  if (raw && typeof raw === "object") {
    const envelope = raw as ZaloWebhookEnvelope;
    if (
      envelope.ok === true &&
      envelope.result &&
      typeof envelope.result === "object"
    ) {

      return envelope.result as ZaloUpdate;
    }
  }

  return (raw && typeof raw === "object" ? raw : {}) as ZaloUpdate;
}

function verifyWebhookSecret(
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) {

    return false;
  }
  const actual = Buffer.from(header);
  const expected = Buffer.from(secret);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
