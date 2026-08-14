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
const ZALO_CHAT_TYPES = ["PRIVATE", "GROUP"] as const;
// Message events Zalo delivers, each mapped to the reason its payload is
// unusable. Anything else arrives as message.unsupported.received.
const ZALO_MESSAGE_EVENTS: Record<string, string> = {
  "message.text.received": "missing_text",
  "message.image.received": "missing_photo",
  "message.sticker.received": "missing_sticker_url",
  "message.voice.received": "missing_voice_url",
};
const ZALO_REQUEST_TIMEOUT_MS = 10_000;
const ZALO_TEXT_LIMIT = 2000;
// .aac is the only audio format the Zalo Bot API deals in.
const ZALO_VOICE_EXTENSION = ".aac";
const ZALO_VOICE_MEDIA_TYPE = "audio/aac";

interface ZaloApiResponse<T = unknown> {
  ok?: boolean;
  result?: T;
  error_code?: number;
  description?: string;
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

type ZaloChatType = (typeof ZALO_CHAT_TYPES)[number];

export interface ZaloSource {
  chatId: string;
  chatType: ZaloChatType;
  messageId: string;
  senderId: string;
  senderName?: string;
  eventName: string;
  date?: number;
}

interface ZaloChannelOptions {
  allowedUserIds?: ReadonlySet<string>;
  allowedGroupIds?: ReadonlySet<string>;
}

interface ZaloUpdate {
  event_name?: string;
  message?: ZaloMessage;
}

interface ZaloWebhookEnvelope {
  ok?: boolean;
  result?: unknown;
}

export function createZaloActions(
  botToken: string,
  source: ZaloSource,
): ChannelActions {
  return {
    sendText: async function (text) {
      for (const chunk of chunkZaloText(text)) {
        await callZaloApi(botToken, "sendMessage", {
          chat_id: source.chatId,
          text: chunk,
        });
      }
    },
    sendImage: async function (url, caption): Promise<void> {
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
    sendSticker: async function (sticker): Promise<void> {
      const value = sticker.trim();
      if (!value) {
        throw new Error("Zalo sendSticker needs a sticker id or name");
      }
      await callZaloApi(botToken, "sendSticker", {
        chat_id: source.chatId,
        sticker: value,
      });
    },
    sendTyping: async function () {
      await callZaloApi(botToken, "sendChatAction", {
        chat_id: source.chatId,
        action: "typing",
      });
    },
    reactToMessage: async function (): Promise<void> {
      return;
    },
  };
}

export function createZaloChannel(
  botToken: string,
  webhookSecret: string,
  options: ZaloChannelOptions = {},
): ChannelAdapter {
  const { allowedUserIds, allowedGroupIds } = options;

  return {
    name: "zalo",

    canHandle: function (req) {
      return req.method === "POST";
    },

    authenticate: function (req) {
      return verifyWebhookSecret(
        req.headers["x-bot-api-secret-token"],
        webhookSecret,
      );
    },

    parse: function (req): ChannelParseResult {
      const update = unwrapZaloUpdate(JSON.parse(req.body) as unknown);
      const eventName =
        typeof update.event_name === "string"
          ? update.event_name.slice(0, 128)
          : "missing";
      const missingContentReason = ZALO_MESSAGE_EVENTS[eventName];
      if (!missingContentReason) {
        return ignoreZaloUpdate(update, `unsupported_event:${eventName}`);
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

      const senderName = message.from?.display_name ?? message.from?.name;
      const source: ZaloSource = {
        chatId: chatId,
        chatType: chatType,
        messageId: messageId,
        senderId: senderId,
        eventName: eventName,
        ...(senderName ? { senderName: senderName } : {}),
        ...(typeof message.date === "number" ? { date: message.date } : {}),
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
            ...(senderName ? { actorName: senderName } : {}),
          },
          // Spread so the typed source reaches a Record<string, unknown> field.
          source: { ...source },
        },
      };
    },

    actions: function (msg): ChannelActions {
      return createZaloActions(botToken, toZaloSource(msg.source));
    },
  };
}

async function callZaloApi(
  botToken: string,
  method: "sendChatAction" | "sendMessage" | "sendPhoto" | "sendSticker",
  body: Record<string, unknown>,
): Promise<ZaloApiResponse> {
  const controller = new AbortController();
  const timeout = setTimeout((): void => {
    controller.abort();
  }, ZALO_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${ZALO_API_BASE}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const parsed = parseJsonBody(bodyText);

    if (!response.ok || parsed?.ok === false) {
      throw new Error(
        `Zalo ${method} failed (${response.status}): ${formatZaloError(parsed, bodyText)}`,
      );
    }

    return parsed ?? { ok: true };
  } finally {
    clearTimeout(timeout);
  }
}

function chunkZaloText(text: string): string[] {
  if (text.length === 0) {
    return [""];
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + ZALO_TEXT_LIMIT, text.length);
    const previousCodeUnit = text.charCodeAt(end - 1);
    const nextCodeUnit = text.charCodeAt(end);
    if (
      end < text.length &&
      previousCodeUnit >= 0xd800 &&
      previousCodeUnit <= 0xdbff &&
      nextCodeUnit >= 0xdc00 &&
      nextCodeUnit <= 0xdfff
    ) {
      end -= 1;
    }
    chunks.push(text.slice(offset, end));
    offset = end;
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

function zaloHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !URL.canParse(raw)) {
    return null;
  }
  const url = new URL(raw);

  return url.protocol === "http:" || url.protocol === "https:"
    ? url.toString()
    : null;
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
      const text = typeof message?.text === "string" ? message.text.trim() : "";

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
      const isVoiceNote = new URL(voice).pathname
        .toLowerCase()
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
