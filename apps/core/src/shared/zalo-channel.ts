/**
 * Zalo channel adapter.
 * Keep official Zalo Bot API webhook normalization and outbound API calls here.
 */

import { timingSafeEqual } from "node:crypto";
import type { UserContent } from "ai";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult,
} from "./channels.ts";
import { logWarn } from "./log.ts";
import { ZALO_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const ZALO_API_BASE = "https://bot-api.zaloplatforms.com";
const ZALO_TEXT_LIMIT = 2000;
// Message events Zalo delivers, each mapped to the reason its payload is
// unusable. Anything else arrives as message.unsupported.received.
const ZALO_MESSAGE_EVENTS: Record<string, string> = {
  "message.text.received": "missing_text",
  "message.image.received": "missing_photo",
  "message.sticker.received": "missing_sticker_url",
  "message.voice.received": "missing_voice_url",
};
// .aac is the only audio format the Zalo Bot API deals in.
const ZALO_VOICE_EXTENSION = ".aac";
const ZALO_VOICE_MEDIA_TYPE = "audio/aac";

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
  // Media payloads. Zalo sends the picture, sticker and voice note as URLs it
  // hosts itself, never as bytes.
  photo?: string;
  caption?: string;
  sticker?: string;
  url?: string;
  voice_url?: string;
}

interface ZaloApiResponse<T = unknown> {
  ok?: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

// A type, not an interface: `InboundMessage.source` is Record<string, unknown>,
// which only an anonymous object type is assignable to.
export type ZaloSource = {
  chatId: string;
  chatType: "PRIVATE";
  messageId: string;
  senderId: string;
  senderName?: string;
  eventName: string;
  date?: number;
};

export function createZaloChannel(
  botToken: string,
  webhookSecret: string,
  allowedUserIds?: ReadonlySet<string>,
): ChannelAdapter {
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
      const missingContentReason = ZALO_MESSAGE_EVENTS[eventName];
      if (!missingContentReason) {

        return ignoreZaloUpdate(
          update,
          `unsupported_event:${eventName}`,
        );
      }

      const message = update.message;
      const content = zaloMessageContent(eventName, message);
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
      if (!content) {

        return ignoreZaloUpdate(update, missingContentReason);
      }
      if (chatType !== "PRIVATE") {

        return ignoreZaloUpdate(
          update,
          `unsupported_chat_type:${chatType ?? "missing"}`,
        );
      }
      if (message?.from?.is_bot) {

        return ignoreZaloUpdate(update, "bot_message");
      }

      if (allowedUserIds?.size && !allowedUserIds.has(senderId)) {
        logWarn("Zalo sender not in allow list", { senderId: senderId });

        return ignoreZaloUpdate(update, `sender_not_allowed:${senderId}`);
      }

      const source: ZaloSource = {
        chatId: chatId,
        chatType: chatType,
        messageId: messageId,
        senderId: senderId,
        senderName: message.from?.display_name ?? message.from?.name,
        eventName: eventName,
        date: message.date,
      };

      return {
        kind: "message",
        ack: { statusCode: 200, body: "ok" },
        message: {
          eventId: `${ZALO_INTEGRATION_PREFIX}${update.event_name}:${chatId}:${senderId}:${messageId}`,
          conversationKey: `${ZALO_INTEGRATION_PREFIX}${chatId}`,
          channelName: "zalo",
          content: content,
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
        },
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
    sendImage: async function(url, caption): Promise<void> {
      // Zalo fetches the picture itself, so it only ever accepts a public URL.
      const photo = zaloHttpUrl(url);
      if (!photo) {
        throw new Error(
          "Zalo sendPhoto needs an absolute http(s) image URL that Zalo can fetch",
        );
      }
      await callZaloApi(botToken, "sendPhoto", {
        chat_id: source.chatId,
        photo: photo,
        ...(caption ? { caption: caption.slice(0, ZALO_TEXT_LIMIT) } : {}),
      });
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

// Zalo hosts every attachment as a URL, so inbound media becomes AI SDK URL
// parts — strings, because the conversation is persisted as JSON.
function zaloMessageContent(
  eventName: string,
  message: ZaloMessage | undefined,
): UserContent | null {
  const caption =
    typeof message?.caption === "string" ? message.caption.trim() : "";
  switch (eventName) {
    case "message.text.received": {
      const text =
        typeof message?.text === "string" ? message.text.trim() : "";

      return text || null;
    }
    case "message.image.received": {
      const photo = zaloHttpUrl(message?.photo);
      if (!photo) {

        return null;
      }

      return caption
        ? [
            { type: "text", text: caption },
            { type: "image", image: photo },
          ]
        : [{ type: "image", image: photo }];
    }
    case "message.sticker.received": {
      const sticker = zaloHttpUrl(message?.url);

      return sticker ? [{ type: "image", image: sticker }] : null;
    }
    case "message.voice.received": {
      const voice = zaloHttpUrl(message?.voice_url);
      if (!voice) {

        return null;
      }
      // An audio type Zalo never sends goes over as a link, so the turn survives
      // instead of failing at the provider.
      const isVoiceNote = new URL(voice)
        .pathname.toLowerCase()
        .endsWith(ZALO_VOICE_EXTENSION);

      return isVoiceNote
        ? [
            {
              type: "file",
              data: voice,
              mediaType: ZALO_VOICE_MEDIA_TYPE,
            },
          ]
        : [{ type: "text", text: `Voice message: ${voice}` }];
    }
    default:

      return null;
  }
}

function ignoreZaloUpdate(
  update: ZaloUpdate,
  reason: string,
): ChannelParseResult {
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

  return {
    kind: "ignore",
    reason: `${reason} details=${JSON.stringify(details)}`,
  };
}

function verifyWebhookSecret(
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(secret);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
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

function toZaloSource(source: Record<string, unknown>): ZaloSource {
  if (
    typeof source.chatId !== "string" ||
    source.chatType !== "PRIVATE" ||
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

function zaloHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !URL.canParse(raw)) {

    return null;
  }
  const url = new URL(raw);

  return url.protocol === "http:" || url.protocol === "https:"
    ? url.toString()
    : null;
}

async function callZaloApi(
  botToken: string,
  method: "sendChatAction" | "sendMessage" | "sendPhoto",
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
