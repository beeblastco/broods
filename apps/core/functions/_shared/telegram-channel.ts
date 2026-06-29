/**
 * Telegram channel adapter implementated as a ChannelAdapter.
 * Implements Telegram auth, message normalization, and reply actions through the Chat SDK Telegram adapter.
 */

import { TelegramAdapter, type TelegramMessage, type TelegramUpdate } from "@chat-adapter/telegram";
import { ConsoleLogger } from "chat";
import { timingSafeEqual } from "node:crypto";
import type { ChannelActions, ChannelAdapter, ChannelParseResult } from "./channels.ts";
import { logWarn } from "./log.ts";
import { TELEGRAM_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const TELEGRAM_SAFE_RAW_CHUNK_SIZE = 3500;

export interface TelegramSource {
  chatId: number;
  messageId: string;
  threadId: string;
  fromUserId?: number;
  fromUsername?: string;
}

export function createTelegramChannel(
  botToken: string,
  webhookSecret: string,
  allowedChatIds: Set<number>,
  reactionEmoji: string,
  apiUrl?: string,
): ChannelAdapter {
  const transport = new TelegramAdapter({
    apiUrl,
    botToken,
    secretToken: webhookSecret,
    mode: "webhook",
    logger: new ConsoleLogger("error").child("telegram"),
  });

  return {
    name: "telegram",

    canHandle(req) {
      return "x-telegram-bot-api-secret-token" in req.headers;
    },

    authenticate(req) {
      const secret = req.headers["x-telegram-bot-api-secret-token"];
      if (!verifyWebhookSecret(secret, webhookSecret)) {
        logWarn("Webhook secret verification failed");
        return false;
      }
      return true;
    },

    parse(req): ChannelParseResult {
      const update: TelegramUpdate = JSON.parse(req.body);
      const message = extractInboundMessage(update);
      if (!message?.text) {
        return { kind: "ignore" };
      }

      if (!allowedChatIds.has(message.chat.id)) {
        logWarn("Chat not in allow list", { chatId: message.chat.id });
        return { kind: "ignore" };
      }

      const parsed = transport.parseMessage(message);

      return {
        kind: "message",
        message: {
          eventId: `${TELEGRAM_INTEGRATION_PREFIX}${update.update_id}`,
          conversationKey: `${TELEGRAM_INTEGRATION_PREFIX}${message.chat.id}`,
          channelName: "telegram",
          content: parsed.text,
          source: {
            chatId: message.chat.id,
            messageId: parsed.id,
            threadId: parsed.threadId,
            fromUserId: message.from?.id,
            fromUsername: message.from?.username,
          } satisfies TelegramSource,
        },
      };
    },

    actions(msg): ChannelActions {
      const source = toTelegramSource(msg.source);

      return {
        async sendText(text) {
          for (const chunk of splitTelegramRawText(text)) {
            await transport.postMessage(source.threadId, { markdown: chunk });
          }
        },
        sendTyping: () => transport.startTyping(source.threadId),
        reactToMessage: () => transport.addReaction(source.threadId, source.messageId, reactionEmoji),
        ...(source.chatId > 0
          ? {
            stream: async (textStream, options) => {
              const result = await transport.stream(source.threadId, textStream, options);
              return result?.id ?? null;
            },
          }
          : {}),
      };
    },
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
    const boundary = splitAt > TELEGRAM_SAFE_RAW_CHUNK_SIZE * 0.5
      ? splitAt
      : TELEGRAM_SAFE_RAW_CHUNK_SIZE;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function extractInboundMessage(update: TelegramUpdate): TelegramMessage | null {
  return update.message ?? update.edited_message ?? null;
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
    threadId: source.threadId,
    fromUserId: typeof source.fromUserId === "number" ? source.fromUserId : undefined,
    fromUsername: typeof source.fromUsername === "string" ? source.fromUsername : undefined,
  };
}
