/**
 * Telegram channel adapter implementated as a ChannelAdapter.
 * Implements Telegram auth, message normalization, and reply actions through the Chat SDK Telegram adapter.
 */

import {
  TelegramAdapter,
  type TelegramMessage,
  type TelegramUpdate,
} from "@chat-adapter/telegram";
import { ConsoleLogger, fromFullStream } from "chat";
import { timingSafeEqual } from "node:crypto";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult,
} from "./channels.ts";
import { isAllowedId } from "./channels.ts";
import { logWarn } from "./log.ts";
import { TELEGRAM_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const TELEGRAM_SAFE_RAW_CHUNK_SIZE = 3500;
const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;

export interface TelegramSource {
  chatId: number;
  messageId: string;
  messageThreadId?: number;
  threadId: string;
  fromUserId?: number;
  fromUsername?: string;
}

export function createTelegramChannel(
  botToken: string,
  webhookSecret: string,
  allowedChannelIds: Set<string> | null,
  allowedUserIds: Set<string> | null,
  reactionEmoji: string,
  apiUrl?: string,
): ChannelAdapter {
  const transport = new TelegramAdapter({
    apiUrl: apiUrl,
    botToken: botToken,
    secretToken: webhookSecret,
    mode: "webhook",
    logger: new ConsoleLogger("error").child("telegram"),
  });

  return {
    name: "telegram",

    canHandle: function(req) {
      return "x-telegram-bot-api-secret-token" in req.headers;
    },

    authenticate: function(req) {
      const secret = req.headers["x-telegram-bot-api-secret-token"];
      if (!verifyWebhookSecret(secret, webhookSecret)) {
        logWarn("Webhook secret verification failed");

        return false;
      }

      return true;
    },

    parse: function(req): ChannelParseResult {
      const update: TelegramUpdate = JSON.parse(req.body);
      const message = extractInboundMessage(update);
      if (!message?.text) {
        return { kind: "ignore" };
      }

      if (
        !isAllowedId(allowedChannelIds, String(message.chat.id))
      ) {
        logWarn("Chat not in allow list", { chatId: message.chat.id });

        return { kind: "ignore" };
      }

      const senderId = message.from?.id ? String(message.from.id) : undefined;
      if (!isAllowedId(allowedUserIds, senderId)) {
        logWarn("Telegram sender not in allow list", { userId: senderId });

        return { kind: "ignore" };
      }

      const parsed = transport.parseMessage(message);
      const source: TelegramSource = {
        chatId: message.chat.id,
        messageId: parsed.id,
        ...(message.message_thread_id !== undefined
          ? { messageThreadId: message.message_thread_id }
          : {}),
        threadId: parsed.threadId,
        fromUserId: message.from?.id,
        fromUsername: message.from?.username,
      };

      return {
        kind: "message",
        message: {
          eventId: `${TELEGRAM_INTEGRATION_PREFIX}${update.update_id}`,
          conversationKey: `${TELEGRAM_INTEGRATION_PREFIX}${message.chat.id}`,
          channelName: "telegram",
          content: parsed.text,
          identity: {
            channelId: String(message.chat.id),
            ...(message.message_thread_id !== undefined
              ? { threadId: String(message.message_thread_id) }
              : {}),
            ...(message.from?.id ? { userId: String(message.from.id) } : {}),
            ...(message.from?.username
              ? { userName: message.from.username }
              : {}),
          },
          // Spread so the typed source reaches a Record<string, unknown> field.
          source: { ...source },
        },
      };
    },

    actions: function(msg): ChannelActions {
      const source = toTelegramSource(msg.source);

      return {
        sendImage: async function(url, caption): Promise<void> {
          await transport.postMessage(source.threadId, {
            raw: caption ?? "",
            attachments: [
              {
                type: "image",
                url: url,
              },
            ],
          });
        },
        sendSticker: async function(sticker): Promise<void> {
          const value = sticker.trim();
          if (!value) {
            throw new Error(
              "Telegram sendSticker needs a file id or public http(s) URL",
            );
          }
          if (value.includes("://")) {
            assertTelegramStickerUrl(value);
          }
          await callTelegramBotApi(apiUrl, botToken, "sendSticker", {
            chat_id: source.chatId,
            sticker: value,
            ...(source.messageThreadId !== undefined
              ? { message_thread_id: source.messageThreadId }
              : {}),
          });
        },
        sendText: async function(text) {
          for (const chunk of splitTelegramRawText(text)) {
            await transport.postMessage(source.threadId, { markdown: chunk });
          }
        },
        sendTyping: () => transport.startTyping(source.threadId),
        supportsReactions: true,
        reactToMessage: (emoji): Promise<void> =>
          transport.addReaction(
            source.threadId,
            source.messageId,
            emoji ?? reactionEmoji,
          ),
        ...(source.chatId > 0
          ? {
              stream: async (textStream, options) => {
                const result = await transport.stream(
                  source.threadId,
                  fromFullStream(textStream),
                  options,
                );

                return result?.id ?? null;
              },
            }
          : {}),
      };
    },
  };
}

function extractInboundMessage(update: TelegramUpdate): TelegramMessage | null {
  return update.message ?? update.edited_message ?? null;
}

async function callTelegramBotApi(
  apiUrl: string | undefined,
  botToken: string,
  method: "sendSticker",
  body: Record<string, unknown>,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout((): void => {
    controller.abort();
  }, TELEGRAM_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${(apiUrl ?? "https://api.telegram.org").replace(/\/+$/, "")}/bot${botToken}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    const result = (await response.json()) as {
      ok?: boolean;
      description?: string;
    };
    if (!response.ok || result.ok !== true) {
      throw new Error(
        `Telegram ${method} failed (${response.status}): ${result.description ?? "unknown error"}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

function assertTelegramStickerUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Telegram sendSticker needs an absolute http(s) sticker URL",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "Telegram sendSticker needs an absolute http(s) sticker URL",
    );
  }
}

function splitTelegramRawText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return ["..."];
  if (trimmed.length <= TELEGRAM_SAFE_RAW_CHUNK_SIZE) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > TELEGRAM_SAFE_RAW_CHUNK_SIZE) {
    const candidate = remaining.slice(0, TELEGRAM_SAFE_RAW_CHUNK_SIZE);
    const splitAt = Math.max(
      candidate.lastIndexOf("\n\n"),
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf(" "),
    );
    const boundary =
      splitAt > TELEGRAM_SAFE_RAW_CHUNK_SIZE * 0.5
        ? splitAt
        : TELEGRAM_SAFE_RAW_CHUNK_SIZE;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) chunks.push(remaining);

  return chunks;
}

function toTelegramSource(source: Record<string, unknown>): TelegramSource {
  if (
    typeof source.chatId !== "number" ||
    typeof source.messageId !== "string" ||
    typeof source.threadId !== "string"
  ) {
    throw new Error("Invalid Telegram source payload");
  }

  return {
    chatId: source.chatId,
    messageId: source.messageId,
    messageThreadId:
      typeof source.messageThreadId === "number"
        ? source.messageThreadId
        : undefined,
    threadId: source.threadId,
    fromUserId:
      typeof source.fromUserId === "number" ? source.fromUserId : undefined,
    fromUsername:
      typeof source.fromUsername === "string" ? source.fromUsername : undefined,
  };
}

function verifyWebhookSecret(
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
