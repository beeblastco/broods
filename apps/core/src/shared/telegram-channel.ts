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
  type StreamChunk,
} from "chat";
import { timingSafeStringEqual } from "./auth.ts";
import { channelApiFetch, publicHostFetch } from "./http.ts";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelFile,
  ChannelIdentity,
  ChannelImage,
  ChannelParseResult,
  ChannelQuestionPrompt,
} from "./channels.ts";
import {
  isAllowedId,
  parseChannelWebhookBody,
  parseQuestionButtonId,
  questionButtonId,
} from "./channels.ts";
import { logWarn } from "./log.ts";
import { MAX_ATTACHMENT_BYTES } from "./media-types.ts";
import { TELEGRAM_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const BOT_COMMAND_ENTITY = "bot_command";
const MENTION_ENTITY = "mention";
const TELEGRAM_SAFE_RAW_CHUNK_SIZE = 3500;
const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;
const TELEGRAM_API_URL = "https://api.telegram.org";
// Telegram rejects an album of more than ten.
const TELEGRAM_MEDIA_GROUP_MAX = 10;
// Telegram serves every static sticker as WebP whatever the set was built from.
const TELEGRAM_STICKER_MEDIA_TYPE = "image/webp";
const TELEGRAM_FILE_ID_PATTERN = /^[\w-]+$/;
const TELEGRAM_REPLY_QUOTE_MAX = 500;
const REPLY_CALLBACK_PATTERN = /^r:(.{1,60})$/s;

export interface TelegramChannelOptions {
  botUsername?: string;
}

interface TelegramSticker {
  emoji?: string;
  file_id: string;
  file_size?: number;
  is_animated?: boolean;
  is_video?: boolean;
}

export interface TelegramSource {
  chatId: number;
  commandToken?: string;
  messageId: string;
  messageThreadId?: number;
  threadId: string;
  fromUserId?: number;
  fromUsername?: string;
}

interface TelegramApiAnswer<TResult> {
  description?: string;
  error_code?: number;
  ok: boolean;
  parameters?: { retry_after?: number };
  result?: TResult;
}

// The bot token rides every path to a tenant `apiUrl`, so those calls go pinned to a checked
// public address with redirects refused.
class BroodsTelegramAdapter extends TelegramAdapter {
  private get tenantApiUrl(): boolean {
    return this.apiBaseUrl !== TELEGRAM_API_URL;
  }

  protected override async downloadFile(
    fileId: string,
  ): Promise<Buffer | ArrayBuffer> {
    if (!this.tenantApiUrl) return super.downloadFile(fileId);
    const file = await this.telegramFetch<{ file_path?: string }>("getFile", {
      file_id: fileId,
    });
    if (!file.file_path) {
      throw new Error(`Telegram file ${fileId} has no path`);
    }
    const botToken = this.staticBotToken ?? (await this.resolveBotToken());
    const response = await publicHostFetch(
      `${this.apiBaseUrl}/file/bot${botToken}/${file.file_path}`,
      { signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS) },
    );
    if (!response.ok) {
      throw new Error(
        `Failed to download Telegram file ${fileId}: ${response.status}`,
      );
    }

    return await readCappedFile(response, fileId);
  }

  protected override async telegramFetch<TResult>(
    method: string,
    payload?: Record<string, unknown> | FormData,
    request?: { signal?: AbortSignal },
  ): Promise<TResult> {
    if (!this.tenantApiUrl) {
      return super.telegramFetch(method, payload, request);
    }
    const botToken = this.staticBotToken ?? (await this.resolveBotToken());
    const response = await publicHostFetch(
      `${this.apiBaseUrl}/bot${botToken}/${method}`,
      {
        method: "POST",
        ...(payload instanceof FormData
          ? { body: payload }
          : {
              body: JSON.stringify(payload ?? {}),
              headers: { "Content-Type": "application/json" },
            }),
        ...(request?.signal ? { signal: request.signal } : {}),
      },
    );
    // A proxy error page is not JSON; its status still maps the error.
    const data = (await response
      .json()
      .catch((): TelegramApiAnswer<TResult> => ({
        ok: false,
      }))) as TelegramApiAnswer<TResult>;
    if (!response.ok || !data.ok || data.result === undefined) {
      this.throwTelegramApiError(method, response.status, data);
    }

    return data.result;
  }
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
  const transport = new BroodsTelegramAdapter({
    apiUrl: apiUrl,
    botToken: botToken,
    secretToken: webhookSecret,
    mode: "webhook",
    nativeStreaming: true,
    logger: new ConsoleLogger("error").child("telegram"),
  });

  const parseQuestionClick = (
    callback: NonNullable<TelegramUpdate["callback_query"]>,
    updateId: number,
  ): ChannelParseResult => {
    void callTelegramBotApi(apiUrl, botToken, "answerCallbackQuery", {
      callback_query_id: callback.id,
    }).catch((err: unknown): void => {
      logWarn("Telegram answerCallbackQuery failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    const answer = parseQuestionButtonId(callback.data);
    const content = answer
      ? "[button answer]"
      : REPLY_CALLBACK_PATTERN.exec(callback.data ?? "")?.[1];
    const message = callback.message;
    if (content === undefined || !message) {
      return { kind: "ignore", reason: "unknown callback" };
    }
    if (
      !isAllowedId(allowedChannelIds, String(message.chat.id)) ||
      !isAllowedId(allowedUserIds, String(callback.from.id))
    ) {
      return { kind: "ignore", reason: "not allowed" };
    }
    void callTelegramBotApi(apiUrl, botToken, "editMessageReplyMarkup", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch((): void => {});
    const envelope = telegramEnvelope(
      message,
      transport.parseMessage(message),
      callback.from,
    );

    return {
      kind: "message",
      redelivers: true,
      message: {
        eventId: `${TELEGRAM_INTEGRATION_PREFIX}${updateId}`,
        conversationKey: `${TELEGRAM_INTEGRATION_PREFIX}${message.chat.id}`,
        channelName: "telegram",
        content: content,
        identity: envelope.identity,
        source: { ...envelope.source },
        ...(answer ? { answer: answer } : {}),
      },
    };
  };

  return {
    name: "telegram",

    rehydrateAttachment: function (attachment) {
      return transport.rehydrateAttachment(attachment);
    },

    canHandle: function (req) {
      return "x-telegram-bot-api-secret-token" in req.headers;
    },

    authenticate: function (req) {
      const secret = req.headers["x-telegram-bot-api-secret-token"];
      if (!secret || !timingSafeStringEqual(secret, webhookSecret)) {
        logWarn("Webhook secret verification failed");

        return false;
      }

      return true;
    },

    parse: function (req): ChannelParseResult {
      const body = parseChannelWebhookBody<TelegramUpdate>(
        "telegram",
        req.body,
      );
      if (body.kind === "ignore") {
        return body;
      }
      const update = body.payload;
      if (update.callback_query) {
        return parseQuestionClick(update.callback_query, update.update_id);
      }
      const message = extractInboundMessage(update);
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

      const runAgent =
        !botUsername || addressesTelegramBot(message, botUsername);
      const parsed = transport.parseMessage(message);
      const attachments = telegramAttachments(
        transport,
        message.sticker,
        parsed,
      );
      const commandToken = telegramCommandToken(message, botUsername);
      const envelope = telegramEnvelope(message, parsed, message.from);

      return {
        kind: runAgent ? "message" : "context",
        redelivers: true,
        message: {
          eventId: `${TELEGRAM_INTEGRATION_PREFIX}${update.update_id}`,
          conversationKey: `${TELEGRAM_INTEGRATION_PREFIX}${message.chat.id}`,
          channelName: "telegram",
          content: withReplyContext(
            message.sticker ? stickerText(message.sticker) : parsed.text,
            parsed.replyTo,
          ),
          ...(attachments.length > 0 ? { attachments: attachments } : {}),
          identity: envelope.identity,
          source: {
            ...envelope.source,
            ...(commandToken !== undefined
              ? { commandToken: commandToken }
              : {}),
          },
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
        sendFiles: sendAttachments,
        sendImages: sendAttachments,
        sendQuestions: async function (prompt): Promise<void> {
          await callTelegramBotApi(apiUrl, botToken, "sendMessage", {
            chat_id: source.chatId,
            text: prompt.text,
            ...(source.messageThreadId !== undefined
              ? { message_thread_id: source.messageThreadId }
              : {}),
            reply_markup: { inline_keyboard: questionKeyboard(prompt) },
          });
        },
        sendReplyButtons: async function (text, replies): Promise<void> {
          const chunks = splitTelegramRawText(text);
          const last = chunks.pop() ?? text;
          const thread =
            source.messageThreadId !== undefined
              ? { message_thread_id: source.messageThreadId }
              : {};
          for (const chunk of chunks) {
            await callTelegramBotApi(apiUrl, botToken, "sendMessage", {
              chat_id: source.chatId,
              text: chunk,
              ...thread,
            });
          }
          await callTelegramBotApi(apiUrl, botToken, "sendMessage", {
            chat_id: source.chatId,
            text: last,
            ...thread,
            reply_markup: {
              inline_keyboard: [
                replies.map((label) => ({
                  text: label,
                  callback_data: `r:${label}`,
                })),
              ],
            },
          });
        },
        sendSticker: async function (sticker): Promise<void> {
          const value = sticker.trim();
          if (value.includes("://")) {
            assertTelegramStickerUrl(value);
          } else if (!TELEGRAM_FILE_ID_PATTERN.test(value)) {
            throw new Error(
              "Telegram sendSticker needs a sticker file_id or a public http(s) URL, not a file path",
            );
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
              // Telegram refuses a stream with no text, which a run that fails early leaves.
              // Nothing was posted then, so null hands the reply back as plain text.
              stream: async (textStream, options) => {
                let sawText = false;
                const chunks = (async function* (): AsyncGenerator<
                  string | StreamChunk
                > {
                  for await (const chunk of fromFullStream(textStream)) {
                    if (typeof chunk === "string") {
                      sawText ||= chunk.trim() !== "";
                    } else if (chunk.type === "markdown_text") {
                      sawText ||= chunk.text.trim() !== "";
                    }
                    yield chunk;
                  }
                })();
                const result = await transport
                  .stream(source.threadId, chunks, options)
                  .catch((err: unknown): null => {
                    if (sawText) throw err;

                    return null;
                  });

                return result?.id ?? null;
              },
            }
          : {}),
      };
    },
  };
}

// Never another bot, so two bots in one group can not mention each other into a loop.
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

// Mirrors the Chat SDK's attachment extraction list.
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

function questionKeyboard(
  prompt: ChannelQuestionPrompt,
): { text: string; callback_data: string }[][] {
  const single = prompt.questions.length === 1;

  return prompt.questions.flatMap(
    (question, questionIndex): { text: string; callback_data: string }[][] =>
      question.options.map((option, optionIndex) => [
        {
          text: single ? option.label : `${question.header}: ${option.label}`,
          callback_data: questionButtonId(
            prompt.statusId,
            questionIndex,
            optionIndex,
          ),
        },
      ]),
  );
}

// The SDK's own download cap, so a tenant host can not stream gigabytes into core.
async function readCappedFile(
  response: Response,
  fileId: string,
): Promise<Buffer> {
  const tooLarge = (): Error =>
    new Error(`Telegram file ${fileId} exceeds the download limit`);
  if (Number(response.headers.get("content-length")) > MAX_ATTACHMENT_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const read = await reader?.read();
    if (!read || read.done) break;
    size += read.value.byteLength;
    if (size > MAX_ATTACHMENT_BYTES) {
      await reader?.cancel();
      throw tooLarge();
    }
    chunks.push(read.value);
  }

  return Buffer.concat(chunks, size);
}

function stickerText(sticker: TelegramSticker): string {
  return `${sticker.emoji ?? ""} [sticker file_id: ${sticker.file_id}]`.trim();
}

// A static sticker is rebuilt with a WebP name the model can read; animated and video ones
// (.tgs, .webm) are skipped, and `stickerText` carries their emoji instead.
function telegramAttachments(
  transport: TelegramAdapter,
  sticker: TelegramSticker | undefined,
  parsed: Message,
): Attachment[] {
  if (!sticker) {
    return parsed.attachments;
  }
  const media = parsed.attachments.filter(
    (attachment) => attachment.fetchMetadata?.fileId !== sticker.file_id,
  );
  if (sticker.is_animated || sticker.is_video) {
    return media;
  }

  return [
    ...media,
    transport.rehydrateAttachment({
      type: "image",
      name: `sticker${sticker.emoji ? `-${sticker.emoji}` : ""}.webp`,
      mimeType: TELEGRAM_STICKER_MEDIA_TYPE,
      ...(sticker.file_size !== undefined ? { size: sticker.file_size } : {}),
      fetchMetadata: { fileId: sticker.file_id },
    }),
  ];
}

// Read from the entity, not the content: the reply frame and a group's `@name` suffix would
// hide the command from the exact-match parser.
function telegramCommandToken(
  message: TelegramMessage,
  botUsername: string | null,
): string | undefined {
  const entity = telegramEntities(message).find(
    (candidate) =>
      candidate.type === BOT_COMMAND_ENTITY && candidate.offset === 0,
  );
  if (!entity) {
    return undefined;
  }
  const [command, target] = telegramMessageText(message)
    .slice(0, entity.length)
    .split("@");
  if (target && botUsername && target.toLowerCase() !== botUsername) {
    return undefined;
  }

  return command;
}

function telegramEnvelope(
  message: TelegramMessage,
  parsed: Message,
  from: TelegramMessage["from"],
): { source: TelegramSource; identity: ChannelIdentity } {
  return {
    source: {
      chatId: message.chat.id,
      messageId: parsed.id,
      ...(message.message_thread_id !== undefined
        ? { messageThreadId: message.message_thread_id }
        : {}),
      threadId: parsed.threadId,
      fromUserId: from?.id,
      fromUsername: from?.username,
    },
    identity: {
      channelId: String(message.chat.id),
      ...(message.message_thread_id !== undefined
        ? { threadId: String(message.message_thread_id) }
        : {}),
      ...(from?.id ? { userId: String(from.id) } : {}),
      ...(from?.username ? { userName: from.username } : {}),
    },
  };
}

// Entity offsets index whichever of text or caption carries the message.
function telegramEntities(
  message: TelegramMessage,
): NonNullable<TelegramMessage["entities"]> {
  return message.text !== undefined
    ? (message.entities ?? [])
    : (message.caption_entities ?? []);
}

function telegramMessageText(message: TelegramMessage): string {
  return message.text ?? message.caption ?? "";
}

// A bare /command counts: Telegram only appends `@name` when the group holds several bots.
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

// The bot token rides the URL path, so a redirect is refused rather than followed.
async function callTelegramBotApi(
  apiUrl: string | undefined,
  botToken: string,
  method:
    | "answerCallbackQuery"
    | "editMessageReplyMarkup"
    | "sendMessage"
    | "sendSticker",
  body: Record<string, unknown>,
): Promise<void> {
  const url = telegramBotApiUrl(apiUrl, botToken, method);
  const controller = new AbortController();
  const timeout = setTimeout((): void => {
    controller.abort();
  }, TELEGRAM_REQUEST_TIMEOUT_MS);
  try {
    const response = await channelApiFetch(apiUrl)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `Telegram ${method} answered a redirect (${response.status}); refusing to follow it with the bot token`,
      );
    }
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

function telegramBotApiUrl(
  apiUrl: string | undefined,
  botToken: string,
  method: string,
): string {
  let base: URL;
  try {
    base = new URL(apiUrl ?? TELEGRAM_API_URL);
  } catch {
    throw new Error("config.channels.telegram.apiUrl must be a valid URL");
  }
  if (base.protocol !== "https:") {
    throw new Error("config.channels.telegram.apiUrl must use https");
  }
  if (base.search || base.hash) {
    throw new Error(
      "config.channels.telegram.apiUrl must not carry a query or fragment",
    );
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/bot${botToken}/${method}`;

  return base.href;
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

// The model reads a flat timeline, so a reply carries its quote. Same delimited shape as
// `withScheduledRunContext`, so a member can not forge one by typing it.
function withReplyContext(
  text: string,
  repliedTo: Message | undefined,
): string {
  if (!repliedTo) return text;
  const quoted = repliedTo.text.trim();
  if (!quoted) return text;

  const from = repliedTo.author.fullName.replaceAll('"', "");
  const shortened =
    quoted.length > TELEGRAM_REPLY_QUOTE_MAX
      ? `${quoted.slice(0, TELEGRAM_REPLY_QUOTE_MAX).trimEnd()}...`
      : quoted;

  return `<replying-to from="${from}">
${shortened}
</replying-to>

${text}`;
}
