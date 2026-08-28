/**
 * Telegram channel adapter implementated as a ChannelAdapter.
 * Implements Telegram auth, message normalization, and reply actions through the Chat SDK Telegram adapter.
 */

import {
  TelegramAdapter,
  type TelegramMessage,
  type TelegramUpdate,
} from "@chat-adapter/telegram";
import {
  ConsoleLogger,
  fromFullStream,
  type Attachment,
  type Message,
} from "chat";
import { timingSafeEqual } from "node:crypto";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelFile,
  ChannelImage,
  ChannelParseResult,
} from "./channels.ts";
import { isAllowedId } from "./channels.ts";
import { logWarn } from "./log.ts";
import { TELEGRAM_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const BOT_COMMAND_ENTITY = "bot_command";
const MENTION_ENTITY = "mention";
const TELEGRAM_SAFE_RAW_CHUNK_SIZE = 3500;
const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;
// Telegram takes 2-10 attachments as a single album and one attachment on its
// own; past ten it rejects the batch, so a longer list goes out as consecutive
// albums rather than failing.
const TELEGRAM_MEDIA_GROUP_MAX = 10;
// Telegram serves every static sticker as WebP whatever the set was built from.
const TELEGRAM_STICKER_MEDIA_TYPE = "image/webp";

export interface TelegramChannelOptions {
  botUsername?: string;
}

/**
 * A Telegram sticker, including the two flags that separate a static WebP from
 * an animated `.tgs` or a `.webm` video sticker. The Chat SDK's message type
 * models the file and its emoji but neither flag, and the difference decides
 * whether the sticker is worth downloading at all.
 */
interface TelegramSticker {
  emoji?: string;
  file_id: string;
  file_size?: number;
  is_animated?: boolean;
  is_video?: boolean;
}

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
  options: TelegramChannelOptions = {},
): ChannelAdapter {
  const botUsername = normalizeBotUsername(options.botUsername);
  const transport = new TelegramAdapter({
    apiUrl: apiUrl,
    botToken: botToken,
    secretToken: webhookSecret,
    mode: "webhook",
    nativeStreaming: true,
    logger: new ConsoleLogger("error").child("telegram"),
  });

  return {
    name: "telegram",

    canHandle: function (req) {
      return "x-telegram-bot-api-secret-token" in req.headers;
    },

    authenticate: function (req) {
      const secret = req.headers["x-telegram-bot-api-secret-token"];
      if (!verifyWebhookSecret(secret, webhookSecret)) {
        logWarn("Webhook secret verification failed");

        return false;
      }

      return true;
    },

    parse: function (req): ChannelParseResult {
      const update: TelegramUpdate = JSON.parse(req.body);
      const message = extractInboundMessage(update);
      // A photo, voice note or document with no caption is still a message. It
      // is only nothing to answer when it carries no media either.
      if (
        !message ||
        (!telegramMessageText(message) && !hasTelegramMedia(message))
      ) {
        return { kind: "ignore" };
      }

      if (!isAllowedId(allowedChannelIds, String(message.chat.id))) {
        logWarn("Chat not in allow list", { chatId: message.chat.id });

        return { kind: "ignore" };
      }

      const senderId = message.from?.id ? String(message.from.id) : undefined;
      if (!isAllowedId(allowedUserIds, senderId)) {
        logWarn("Telegram sender not in allow list", { userId: senderId });

        return { kind: "ignore" };
      }

      // Only a message addressed to the agent runs it; the rest is stored so a
      // later mention still sees what the chat said. Without a configured
      // botUsername a mention cannot be recognised, so every message keeps
      // running the agent.
      const runAgent =
        !botUsername || addressesTelegramBot(message, botUsername);
      const parsed = transport.parseMessage(message);
      const attachments = telegramAttachments(
        transport,
        message.sticker,
        parsed,
      );
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
        kind: runAgent ? "message" : "context",
        message: {
          eventId: `${TELEGRAM_INTEGRATION_PREFIX}${update.update_id}`,
          conversationKey: `${TELEGRAM_INTEGRATION_PREFIX}${message.chat.id}`,
          channelName: "telegram",
          content: parsed.text || skippedStickerText(message.sticker),
          ...(attachments.length > 0 ? { attachments: attachments } : {}),
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

    actions: function (msg): ChannelActions {
      const source = toTelegramSource(msg.source);

      const sendAttachments = async function (
        attachments: ChannelFile[] | ChannelImage[],
        caption?: string,
      ): Promise<void> {
        await postTelegramAttachments(
          transport,
          source.threadId,
          attachments,
          caption,
        );
      };

      return {
        // One body for both: the Chat SDK picks sendPhoto or sendDocument from
        // each attachment's own `type`. They stay separate keys so a channel can
        // advertise one without the other.
        sendFiles: sendAttachments,
        sendImages: sendAttachments,
        sendSticker: async function (sticker): Promise<void> {
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
        sendText: async function (text) {
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

/**
 * Whether the message asks the agent to answer. A private chat always does. In a
 * group the agent answers an @-mention, a slash command, or a reply to one of
 * its own messages; anything else is people talking to each other.
 *
 * Another bot never triggers a run, so two bots sharing a group cannot mention
 * each other into a loop.
 */
function addressesTelegramBot(
  message: TelegramMessage,
  botUsername: string,
): boolean {
  if (message.from?.is_bot) {
    return false;
  }
  if (message.chat.type === "private") {
    return true;
  }

  return (
    mentionsTelegramBot(message, botUsername) ||
    repliesToTelegramBot(message, botUsername)
  );
}

function extractInboundMessage(update: TelegramUpdate): TelegramMessage | null {
  return update.message ?? update.edited_message ?? null;
}

// Whether the message carries anything the agent could look at. Kept beside the
// Chat SDK's own extraction list, plus the sticker it does not model.
function hasTelegramMedia(message: TelegramMessage): boolean {
  return Boolean(
    message.photo?.length ||
    message.audio ||
    message.document ||
    message.rich_message ||
    message.sticker ||
    message.video ||
    message.video_note ||
    message.voice,
  );
}

// The stand-in text for a sticker `telegramAttachments` skips: an animated or
// video sticker carries no caption, so without its emoji the turn would arrive
// entirely empty.
function skippedStickerText(sticker: TelegramSticker | undefined): string {
  if (!sticker || (!sticker.is_animated && !sticker.is_video)) {
    return "";
  }

  return sticker.emoji ?? "[sticker]";
}

/**
 * The media on a Telegram message, as Chat SDK attachments.
 *
 * The SDK already extracts photos, video, audio, voice notes, documents and
 * video notes, each with a reader that resolves the file id and signs the
 * download with the bot token — that is what `parsed.attachments` holds. It has
 * no notion of a sticker, so that one is built here against the same reader:
 * `rehydrateAttachment` turns a file id back into a download, which is exactly
 * what a sticker needs and all it needs.
 *
 * Animated and video stickers (.tgs, .webm) are left alone. Neither is a picture
 * a model can read; `skippedStickerText` carries their emoji as the message
 * text instead, which says more than a failed download would.
 */
function telegramAttachments(
  transport: TelegramAdapter,
  sticker: TelegramSticker | undefined,
  parsed: Message,
): Attachment[] {
  if (!sticker || sticker.is_animated || sticker.is_video) {
    return parsed.attachments;
  }

  return [
    ...parsed.attachments,
    transport.rehydrateAttachment({
      type: "image",
      name: `sticker${sticker.emoji ? `-${sticker.emoji}` : ""}.webp`,
      mimeType: TELEGRAM_STICKER_MEDIA_TYPE,
      ...(sticker.file_size !== undefined ? { size: sticker.file_size } : {}),
      fetchMetadata: { fileId: sticker.file_id },
    }),
  ];
}

// Entities are indexed against whichever of the two text fields carries the
// message, so the pair must be read together — otherwise an @-mention in a photo
// caption is matched against the offsets of a `text` that is not there.
function telegramEntities(
  message: TelegramMessage,
): NonNullable<TelegramMessage["entities"]> {
  return message.text !== undefined
    ? (message.entities ?? [])
    : (message.caption_entities ?? []);
}

// A caption is the text of a photo or document message, and Telegram never sets
// both. Everything reading the message text has to agree on that, or a captioned
// picture reads as an empty message.
function telegramMessageText(message: TelegramMessage): string {
  return message.text ?? message.caption ?? "";
}

/**
 * Telegram tags every `@name` and `/command` in the text with an entity, so the
 * entities decide this rather than a substring search. A bare `/command` counts
 * as addressed: Telegram only appends `@name` to a command when a group holds
 * more than one bot.
 */
function mentionsTelegramBot(
  message: TelegramMessage,
  botUsername: string,
): boolean {
  const text = telegramMessageText(message);

  return telegramEntities(message).some((entity): boolean => {
    const value = text
      .slice(entity.offset, entity.offset + entity.length)
      .toLowerCase();
    if (entity.type === MENTION_ENTITY) {
      return value === `@${botUsername}`;
    }
    if (entity.type !== BOT_COMMAND_ENTITY) {
      return false;
    }
    const target = value.split("@")[1];

    return target === undefined || target === botUsername;
  });
}

// BotFather hands out the name without a leading `@`, but people paste it both
// ways, and Telegram treats usernames case-insensitively.
function normalizeBotUsername(value: string | undefined): string | null {
  const name = value?.trim().replace(/^@/, "").toLowerCase();

  return name ? name : null;
}

function repliesToTelegramBot(
  message: TelegramMessage,
  botUsername: string,
): boolean {
  const author = message.reply_to_message?.from;

  return (
    author?.is_bot === true && author.username?.toLowerCase() === botUsername
  );
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

// One album per ten attachments, in order. The caption rides the first message
// only: repeating it once per batch reads as the same message sent twice. The
// Chat SDK picks the endpoint from `type`, so pictures land as photos the
// recipient sees inline and documents as files they download.
async function postTelegramAttachments(
  transport: TelegramAdapter,
  threadId: string,
  attachments: ChannelFile[] | ChannelImage[],
  caption: string | undefined,
): Promise<void> {
  for (
    let index = 0;
    index < attachments.length;
    index += TELEGRAM_MEDIA_GROUP_MAX
  ) {
    await transport.postMessage(threadId, {
      raw: index === 0 ? (caption ?? "") : "",
      attachments: attachments.slice(index, index + TELEGRAM_MEDIA_GROUP_MAX),
    });
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
