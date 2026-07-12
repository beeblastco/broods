/**
 * Zalo channel adapter.
 * Keep official Zalo Bot API webhook normalization and outbound API calls here.
 */

import { timingSafeEqual } from "node:crypto";
import type { ChannelActions, ChannelAdapter, ChannelParseResult } from "./channels.ts";
import { logWarn } from "./log.ts";
import { ZALO_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const ZALO_API_BASE = "https://bot-api.zaloplatforms.com";
const ZALO_TEXT_LIMIT = 2000;

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

export interface ZaloSource {
  chatId: string;
  chatType: "PRIVATE";
  messageId: string;
  senderId: string;
  senderName?: string;
  eventName: string;
  date?: number;
}

export function createZaloChannel(
  botToken: string,
  webhookSecret: string,
  allowedUserIds?: ReadonlySet<string>,
): ChannelAdapter {
  return {
    name: "zalo",

    canHandle(req) {
      return req.method === "POST";
    },

    authenticate(req) {
      return verifyWebhookSecret(req.headers["x-bot-api-secret-token"], webhookSecret);
    },

    parse(req): ChannelParseResult {
      const update = unwrapZaloUpdate(JSON.parse(req.body) as unknown);
      if (update.event_name !== "message.text.received") {
        return { kind: "ignore" };
      }

      const message = update.message;
      const text = message?.text?.trim();
      const chatId = message?.chat?.id;
      const senderId = message?.from?.id;
      const messageId = message?.message_id;
      const chatType = message?.chat?.chat_type;
      if (!messageId || !chatId || !senderId || !text || chatType !== "PRIVATE" || message.from?.is_bot) {
        return { kind: "ignore" };
      }

      if (allowedUserIds?.size && !allowedUserIds.has(senderId)) {
        logWarn("Zalo sender not in allow list", { senderId });
        return { kind: "ignore" };
      }

      return {
        kind: "message",
        ack: { statusCode: 200, body: "ok" },
        message: {
          eventId: `${ZALO_INTEGRATION_PREFIX}${update.event_name}:${chatId}:${senderId}:${messageId}`,
          conversationKey: `${ZALO_INTEGRATION_PREFIX}${chatId}`,
          channelName: "zalo",
          content: text,
          source: {
            chatId,
            chatType,
            messageId,
            senderId,
            senderName: message.from?.display_name ?? message.from?.name,
            eventName: update.event_name,
            date: message.date,
          } satisfies ZaloSource,
        },
      };
    },

    actions(msg): ChannelActions {
      return createZaloActions(botToken, toZaloSource(msg.source));
    },
  };
}

export function createZaloActions(botToken: string, source: ZaloSource): ChannelActions {
  return {
    async sendText(text) {
      for (const chunk of chunkZaloText(text)) {
        await callZaloApi(botToken, "sendMessage", {
          chat_id: source.chatId,
          text: chunk,
        });
      }
    },
    async sendTyping() {
      await callZaloApi(botToken, "sendChatAction", {
        chat_id: source.chatId,
        action: "typing",
      });
    },
    async reactToMessage() {
      return;
    },
  };
}

function verifyWebhookSecret(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function unwrapZaloUpdate(raw: unknown): ZaloUpdate {
  if (raw && typeof raw === "object") {
    const envelope = raw as ZaloWebhookEnvelope;
    if (envelope.ok === true && envelope.result && typeof envelope.result === "object") {
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
    senderName: typeof source.senderName === "string" ? source.senderName : undefined,
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
    throw new Error(`Zalo ${method} failed (${response.status}): ${formatZaloError(parsed, bodyText)}`);
  }

  return parsed ?? { ok: true };
}

function parseJsonBody(text: string): ZaloApiResponse | null {
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? parsed as ZaloApiResponse : null;
  } catch {
    return null;
  }
}

function formatZaloError(body: ZaloApiResponse | null, bodyText: string): string {
  return body?.description ?? body?.error_code?.toString() ?? (bodyText || "unknown_error");
}
