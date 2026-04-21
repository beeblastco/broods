// Telegram-specific ChannelAdapter: verifies webhook requests, parses updates, and exposes reply actions.
import type { ChannelActions, ChannelAdapter } from "./channels.ts";
import { logWarn } from "./log.ts";
import type { TelegramUpdate } from "./telegram.ts";
import { sendChatAction, sendMessage, setMessageReaction, verifyWebhookSecret } from "./telegram.ts";

export function createTelegramChannel(
  botToken: string,
  webhookSecret: string,
  allowedChatIds: Set<number>,
): ChannelAdapter {
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
      const message = update.message ?? update.edited_message;
      if (!message?.text) return null;

      if (!allowedChatIds.has(message.chat.id)) {
        logWarn("Chat not in allow list", { chatId: message.chat.id });
        return null;
      }

      return {
        eventId: `tg-${update.update_id}`,
        conversationKey: `tg:${message.chat.id}`,
        channelName: "telegram",
        content: message.text,
        source: {
          chatId: message.chat.id,
          messageId: message.message_id,
          fromUserId: message.from?.id,
          fromUsername: message.from?.username,
        },
      };
    },

    actions(msg): ChannelActions {
      const chatId = msg.source.chatId as number;
      const messageId = msg.source.messageId as number;
      return {
        sendText: (text) => sendMessage(botToken, chatId, text),
        sendTyping: () => sendChatAction(botToken, chatId),
        reactToMessage: () => setMessageReaction(botToken, chatId, messageId),
      };
    },
  };
}
