/**
 * Telegram channel adapter implementated as a ChannelAdapter.
 * Implements Telegram auth, message normalization, and reply actions through low-level telegram.ts helpers.
 */

import { TelegramAdapter, type TelegramMessage, type TelegramUpdate } from "@chat-adapter/telegram";
import { ConsoleLogger } from "chat";
import type { ChannelActions, ChannelAdapter } from "./channels.ts";
import { logWarn } from "./log.ts";
import { sendMessage, verifyWebhookSecret } from "./telegram.ts";

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
): ChannelAdapter {
  const transport = new TelegramAdapter({
    botToken,
    secretToken: webhookSecret,
    mode: "webhook",
    logger: new ConsoleLogger("error").child("telegram"),
  });

  return {
    name: "telegram",

    authenticate(headers, _body) {
      const secret = headers["x-telegram-bot-api-secret-token"];
      if (!verifyWebhookSecret(secret, webhookSecret)) {
        logWarn("Webhook secret verification failed");
        return false;
      }
      return true;
    },

    parse(body) {
      const update: TelegramUpdate = JSON.parse(body);
      const message = extractInboundMessage(update);
      if (!message?.text) return null;

      if (!allowedChatIds.has(message.chat.id)) {
        logWarn("Chat not in allow list", { chatId: message.chat.id });
        return null;
      }

      const parsed = transport.parseMessage(message);

      return {
        eventId: `tg-${update.update_id}`,
        conversationKey: `tg:${message.chat.id}`,
        channelName: "telegram",
        content: parsed.text,
        source: {
          chatId: message.chat.id,
          messageId: parsed.id,
          threadId: parsed.threadId,
          fromUserId: message.from?.id,
          fromUsername: message.from?.username,
        } satisfies TelegramSource,
      };
    },

    actions(msg): ChannelActions {
      return createTelegramActions(botToken, transport, toTelegramSource(msg.source), reactionEmoji);
    },
  };
}

export function createTelegramActions(
  botToken: string,
  transport: TelegramAdapter,
  source: TelegramSource,
  reactionEmoji: string,
): ChannelActions {
  return {
    sendText: (text) => sendMessage(botToken, source.chatId, text),
    sendTyping: () => transport.startTyping(source.threadId),
    reactToMessage: () => transport.addReaction(source.threadId, source.messageId, reactionEmoji),
  };
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
