/**
 * Discord channel adapter.
 * Verify interaction signatures, normalize slash commands, and send replies through Chat SDK's Discord adapter.
 */

import { DiscordAdapter, type DiscordThreadId } from "@chat-adapter/discord";
import { ConsoleLogger, type Attachment, type FileUpload } from "chat";
import {
  channelAttachmentBytes,
  channelAttachmentName,
  type ChannelActions,
  type ChannelAdapter,
  type ChannelFile,
  type ChannelImage,
  type ChannelParseResult,
} from "./channels.ts";
import { isAllowedId } from "./channels.ts";
import { parseCommand, resolveDiscordCommand } from "./commands.ts";
import { logWarn } from "./log.ts";
import { DISCORD_INTEGRATION_PREFIX } from "./runtime-keys.ts";

// Discord channel types that are threads. A message inside one of these keys its
// conversation to the thread, with the parent channel as its channel scope.
const DISCORD_THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

// One bound for the direct REST calls and CDN downloads, so a stalled Discord
// response cannot hold the turn open until the platform kills it.
const DISCORD_FETCH_TIMEOUT_MS = 30_000;

// Discord sticker format ids, and the CDN extension each is served under.
// Format 3 is Lottie — a JSON animation with no raster form — so it is absent.
const DISCORD_STICKER_EXTENSIONS: Record<number, string | undefined> = {
  1: "png",
  2: "png",
  4: "gif",
};

/**
 * Identity used to decide whether a guild message is addressed to the agent.
 * Without `botUserId` Discord messages cannot be attributed to a mention, so the
 * adapter keeps answering every message rather than going silent.
 */
export interface DiscordChannelOptions {
  botUserId?: string;
  mentionRoleIds?: string[];
}

interface DiscordForwardedEventPayload {
  type?: string;
  timestamp?: number;
  data?: unknown;
}

/**
 * One Discord upload. `duration_secs` and `waveform` are set only on a recorded
 * voice message, and they are the only dependable sign of one: Discord labels
 * the same file `application/ogg`, which says nothing about whether it holds
 * audio or video.
 */
interface DiscordAttachment {
  id?: string;
  url?: string;
  filename?: string;
  content_type?: string;
  size?: number;
  height?: number;
  width?: number;
  duration_secs?: number;
  waveform?: string;
}

interface DiscordGatewayMessageData {
  attachments?: DiscordAttachment[];
  sticker_items?: Array<{
    id?: string;
    name?: string;
    /** 1 PNG, 2 APNG, 3 Lottie, 4 GIF. */
    format_type?: number;
  }>;
  author?: {
    id?: string;
    username?: string;
    global_name?: string;
    bot?: boolean;
  };
  channel_id?: string;
  channel_type?: number;
  content?: string;
  guild_id?: string | null;
  id?: string;
  mention_roles?: string[];
  mentions?: Array<{ id?: string; username?: string; global_name?: string }>;
  thread?: {
    id?: string;
    parent_id?: string;
  };
  timestamp?: string;
}

interface DiscordInteractionOption {
  name?: string;
  value?: string | number | boolean;
  options?: DiscordInteractionOption[];
}

interface DiscordInteractionPayload {
  id?: string;
  type?: number;
  token?: string;
  application_id?: string;
  guild_id?: string;
  channel_id?: string;
  channel?: {
    id?: string;
    type?: number;
    parent_id?: string | null;
  };
  data?: {
    name?: string;
    options?: DiscordInteractionOption[];
  };
  member?: {
    user?: { id?: string };
  };
  user?: { id?: string };
}

interface DiscordSlashCommandContext {
  channelId: string;
  initialResponseSent: boolean;
  interactionToken: string;
}

export interface DiscordSource {
  applicationId: string;
  interactionToken?: string;
  interactionId?: string;
  guildId?: string;
  channelId?: string;
  threadId?: string;
  messageId?: string;
  commandToken?: string;
  userId?: string;
}

// Chat SDK's direct Discord webhook path is `handleWebhook()` + ChatInstance.
// Broods cannot use that path wholesale because `integrations.ts` must first do
// account/agent lookup, per-tenant config scoping, durable session setup, and
// Convex conversation history writes. The SDK also keeps the lower-level hooks
// we need protected (`verifySignature`, `parseSlashCommand`, and requestContext),
// so this subclass is only a small access shim around the SDK implementation.
// If those hooks become public in the SDK, remove this subclass and call the SDK
// methods directly.
class BroodsDiscordAdapter extends DiscordAdapter {
  verifyRequestSignature(
    body: string,
    signature: string | null | undefined,
    timestamp: string | null | undefined,
  ): Promise<boolean> {
    return this.verifySignature(
      new TextEncoder().encode(body),
      signature ?? null,
      timestamp ?? null,
    );
  }

  parseCommand(
    name: string,
    options: DiscordInteractionOption[] | undefined,
  ): {
    command: string;
    text: string;
  } {
    return this.parseSlashCommand(name, options as never);
  }

  runWithSlashCommandContext<T>(
    context: DiscordSlashCommandContext,
    callback: () => Promise<T>,
  ): Promise<T> {
    return this.requestContext.run({ slashCommand: context }, callback);
  }
}

export function createDiscordChannel(
  botToken: string,
  publicKey: string,
  allowedChannelIds: Set<string> | null,
  allowedUserIds: Set<string> | null,
  apiUrl?: string,
  options: DiscordChannelOptions = {},
): ChannelAdapter {
  const discord = new BroodsDiscordAdapter({
    apiUrl: apiUrl,
    applicationId: "broods-discord-webhook",
    botToken: botToken,
    publicKey: publicKey,
    logger: new ConsoleLogger("error").child("discord"),
  });

  return {
    name: "discord",

    canHandle: function (req) {
      return (
        "x-signature-ed25519" in req.headers ||
        "x-discord-gateway-token" in req.headers
      );
    },

    authenticate: function (req) {
      if ("x-discord-gateway-token" in req.headers) {
        return req.headers["x-discord-gateway-token"] === botToken;
      }

      return discord.verifyRequestSignature(
        req.body,
        req.headers["x-signature-ed25519"],
        req.headers["x-signature-timestamp"],
      );
    },

    parse: function (req): ChannelParseResult {
      const payload = JSON.parse(req.body) as DiscordInteractionPayload;
      const gatewayEvent = parseForwardedGatewayEvent(
        discord,
        payload as DiscordForwardedEventPayload,
        allowedChannelIds,
        allowedUserIds,
        options,
      );
      if (gatewayEvent) {
        return gatewayEvent;
      }

      if (payload.type === 1) {
        return {
          kind: "response",
          response: {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: 1 }),
          },
        };
      }

      if (payload.type === 0) {
        return {
          kind: "response",
          response: {
            statusCode: 204,
            headers: { "Content-Type": "application/json" },
          },
        };
      }

      if (
        payload.type !== 2 ||
        !payload.id ||
        !payload.token ||
        !payload.application_id ||
        !payload.channel_id ||
        !payload.data?.name
      ) {
        return unsupportedInteractionResponse();
      }

      if (!payload.guild_id) {
        logWarn("Discord DM interactions are disabled", {
          channelId: payload.channel_id,
        });

        return {
          kind: "response",
          response: {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: 4,
              data: { content: "Discord DMs are disabled.", flags: 64 },
            }),
          },
        };
      }

      const interactionUser = payload.member?.user?.id ?? payload.user?.id;
      if (!isAllowedId(allowedUserIds, interactionUser)) {
        logWarn("Discord sender not in allow list", {
          userId: interactionUser,
        });

        return {
          kind: "response",
          response: {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: 4,
              data: { content: "You are not allowed here.", flags: 64 },
            }),
          },
        };
      }

      // Discord sends the interaction's channel object, so a command typed inside
      // a thread resolves to the same parent+thread key the gateway path builds.
      // Without this the two paths disagree and /new clears the wrong conversation.
      // Gating on the parent also matters: a thread id is never declarable.
      const thread = toDiscordInteractionThread(payload);
      if (!isAllowedId(allowedChannelIds, thread.channelId)) {
        logWarn("Discord channel not in allow list", {
          channelId: thread.channelId,
        });

        return {
          kind: "response",
          response: {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: 4,
              data: { content: "This channel is not allowed.", flags: 64 },
            }),
          },
        };
      }

      const command = discord.parseCommand(
        payload.data.name,
        payload.data.options,
      );
      const resolvedCommand = resolveDiscordCommand(
        command.command.replace(/^\//, ""),
        command.text,
      );
      if (!resolvedCommand) {
        return unsupportedInteractionResponse();
      }

      const threadId = discord.encodeThreadId(thread);
      const source: DiscordSource = {
        applicationId: payload.application_id,
        interactionToken: payload.token,
        interactionId: payload.id,
        guildId: payload.guild_id,
        channelId: thread.channelId,
        ...(thread.threadId ? { threadId: threadId } : {}),
        ...(resolvedCommand.commandToken
          ? { commandToken: resolvedCommand.commandToken }
          : {}),
        userId: payload.member?.user?.id ?? payload.user?.id,
      };

      return {
        kind: "message",
        ack: {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: 5 }),
        },
        message: {
          eventId: `${DISCORD_INTEGRATION_PREFIX}${payload.id}`,
          conversationKey: threadId,
          channelName: "discord",
          content: resolvedCommand.contentText
            ? [{ type: "text", text: resolvedCommand.contentText }]
            : [],
          identity: {
            ...(payload.guild_id ? { workspaceRef: payload.guild_id } : {}),
            channelId: thread.channelId,
            ...(thread.threadId ? { threadId: thread.threadId } : {}),
            ...((payload.member?.user?.id ?? payload.user?.id)
              ? { userId: payload.member?.user?.id ?? payload.user?.id }
              : {}),
          },
          // Spread so the typed source reaches a Record<string, unknown> field.
          source: { ...source },
        },
      };
    },

    actions: function (msg): ChannelActions {
      return createDiscordActions(
        botToken,
        publicKey,
        toDiscordSource(msg.source),
        apiUrl,
      );
    },
  };
}

function createDiscordActions(
  botToken: string,
  publicKey: string,
  source: DiscordSource,
  apiUrl?: string,
): ChannelActions {
  const discord = new BroodsDiscordAdapter({
    apiUrl: apiUrl,
    applicationId: source.applicationId,
    botToken: botToken,
    publicKey: publicKey,
    logger: new ConsoleLogger("error").child("discord"),
  });
  const threadId =
    source.threadId ??
    discord.encodeThreadId({
      guildId: source.guildId ?? "@me",
      channelId:
        source.channelId ?? source.interactionId ?? source.messageId ?? "@me",
    });

  const sendAttachments = async function (
    attachments: ChannelFile[] | ChannelImage[],
    caption?: string,
  ): Promise<void> {
    await discord.postMessage(threadId, {
      markdown: caption ?? "",
      files: await discordUploads(attachments),
    });
  };

  return {
    // Discord ignores an outbound URL attachment entirely — the API takes a
    // multipart upload and nothing else — so both deliveries read the bytes and
    // hand them over as one message. One body serves both because Discord
    // decides which to render inline from the file itself; they stay separate
    // keys so a channel can still advertise one without the other.
    sendFiles: sendAttachments,
    sendImages: sendAttachments,

    // Discord sends a sticker by id and by nothing else — there is no URL form
    // and no upload — so the model names one the bot can reach: a sticker from
    // a guild the bot is in, or a standard pack. The Chat SDK's postMessage has
    // no field for it, which is why this is the one send that goes direct.
    sendSticker: async function(sticker): Promise<void> {
      const value = sticker.trim();
      if (!/^\d+$/.test(value)) {
        throw new Error("Discord sendSticker needs a numeric sticker id");
      }
      // `threadId` on the source is the SDK's encoded composite, not an id
      // Discord's REST API would accept, so it is decoded back to the channel
      // the message actually lives in — a thread posts to the thread.
      const decoded = discord.decodeThreadId(threadId);
      const target = decoded.threadId ?? decoded.channelId;
      if (!target) {
        throw new Error("Discord sendSticker needs a channel to post in");
      }
      await callDiscordApi(apiUrl, botToken, `channels/${target}/messages`, {
        sticker_ids: [value],
      });
    },

    sendText: async function(text) {
      if (!source.interactionToken) {
        await discord.postMessage(threadId, { markdown: text });

        return;
      }

      try {
        await discord.runWithSlashCommandContext(
          {
            channelId: threadId,
            interactionToken: source.interactionToken,
            initialResponseSent: false,
          },
          () => discord.postMessage(threadId, { markdown: text }),
        );
      } catch (err) {
        if (source.channelId) {
          await discord.postMessage(threadId, { markdown: text });

          return;
        }
        throw err;
      }
    },

    sendTyping: async function () {
      if (!source.channelId) {
        return;
      }
      await discord.startTyping(threadId);
    },

    supportsReactions: typeof source.messageId === "string",
    reactToMessage: async function (emoji): Promise<void> {
      if (typeof source.messageId !== "string") {
        return;
      }
      await discord.addReaction(threadId, source.messageId, emoji ?? "eyes");

      return;
    },
  };
}

// Bytes read once per attachment, in parallel, because Discord takes the whole
// batch in one multipart request and rejects a message with no content and no
// files anyway.
async function discordUploads(
  attachments: ChannelFile[] | ChannelImage[],
): Promise<FileUpload[]> {
  return await Promise.all(
    attachments.map(async (attachment): Promise<FileUpload> => ({
      data: await channelAttachmentBytes(attachment),
      filename: channelAttachmentName(attachment),
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    })),
  );
}

/**
 * The uploads and stickers on a Discord message, as Chat SDK attachments.
 *
 * Discord's CDN URLs are signed and expire, so each attachment is read while
 * the turn runs rather than linked and fetched later — that is what the reader
 * on every attachment is for. Nothing here is authenticated: a Discord upload
 * URL is a bearer credential in itself, which is also why it is never persisted.
 */
function discordAttachments(data: DiscordGatewayMessageData): Attachment[] {
  const uploads = (data.attachments ?? []).flatMap(
    (attachment): Attachment[] => {
      const url = attachment.url;
      if (!url) {
        return [];
      }
      const mimeType = discordMediaType(attachment);

      return [
        {
          type: discordAttachmentType(attachment, mimeType),
          url: url,
          ...(attachment.filename ? { name: attachment.filename } : {}),
          ...(mimeType ? { mimeType: mimeType } : {}),
          ...(attachment.size !== undefined ? { size: attachment.size } : {}),
          ...(attachment.width !== undefined ? { width: attachment.width } : {}),
          ...(attachment.height !== undefined
            ? { height: attachment.height }
            : {}),
          fetchData: (): Promise<Buffer> => fetchDiscordFile(url),
        },
      ];
    },
  );

  return [...uploads, ...discordStickers(data.sticker_items ?? [])];
}

// A voice message is the one case where the structure beats the label: Discord
// sends it as `application/ogg`, which a MIME prefix reads as neither audio nor
// video, but only a voice message carries a duration and a waveform.
function discordAttachmentType(
  attachment: DiscordAttachment,
  mimeType: string | undefined,
): Attachment["type"] {
  if (
    attachment.duration_secs !== undefined ||
    attachment.waveform !== undefined
  ) {
    return "audio";
  }
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";

  return "file";
}

// Dropping the claimed type on a voice message is deliberate: keeping
// `application/ogg` would let it override the sniff that identifies the real
// codec, and the label is the part that is wrong.
function discordMediaType(attachment: DiscordAttachment): string | undefined {
  const isVoice =
    attachment.duration_secs !== undefined ||
    attachment.waveform !== undefined;

  return isVoice ? undefined : attachment.content_type;
}

// Discord serves a sticker from a well-known CDN path keyed by its id. Lottie
// stickers (format 3) are a JSON animation, not a picture, so only the raster
// formats are worth fetching — the sticker's name carries the rest.
function discordStickers(
  stickers: NonNullable<DiscordGatewayMessageData["sticker_items"]>,
): Attachment[] {
  return stickers.flatMap((sticker): Attachment[] => {
    const extension = sticker.id
      ? DISCORD_STICKER_EXTENSIONS[sticker.format_type ?? 1]
      : undefined;
    if (!extension) {
      return [];
    }
    const url = `https://media.discordapp.net/stickers/${sticker.id}.${extension}`;

    return [
      {
        type: "image",
        url: url,
        name: `${sticker.name ?? "sticker"}.${extension}`,
        mimeType: extension === "gif" ? "image/gif" : "image/png",
        fetchData: (): Promise<Buffer> => fetchDiscordFile(url),
      },
    ];
  });
}

// One direct Discord REST call, for the sends the Chat SDK models no field for.
async function callDiscordApi(
  apiUrl: string | undefined,
  botToken: string,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const base = (apiUrl ?? "https://discord.com/api/v10").replace(/\/+$/, "");
  const response = await fetch(`${base}/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bot ${botToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DISCORD_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Discord ${path} failed (${response.status}): ${await response.text()}`,
    );
  }
}

async function fetchDiscordFile(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DISCORD_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Discord answered ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Prefix the sender so the agent knows who is talking in a multi-person guild
 * channel, and turn `<@id>` mentions into readable names. Mentions that only
 * target the bot are dropped, and a command keeps its bare text so the leading
 * token still parses.
 */
function formatDiscordMessageText(
  content: string,
  data: DiscordGatewayMessageData,
  omittedUserIds: Set<string>,
): string {
  const names = new Map<string, string>();
  for (const mention of data.mentions ?? []) {
    const name = mention.global_name || mention.username;
    if (mention.id && name) {
      names.set(mention.id, name);
    }
  }
  const normalized = content
    .replace(/<@!?([^>\s]+)>/g, (match, userId: string) => {
      if (omittedUserIds.has(userId)) return "";
      const name = names.get(userId);

      return name ? `@${name}` : match;
    })
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  const author = data.author?.global_name || data.author?.username;
  if (!normalized || !author || parseCommand(normalized)) {
    return normalized;
  }

  return `${author}: ${normalized}`;
}

function gatewayAck(): Extract<ChannelParseResult, { kind: "response" }> {
  return {
    kind: "response",
    response: {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    },
  };
}

// `author.bot` is optional on purpose: Discord omits the field entirely for
// human authors, so requiring a boolean here rejected every real message and
// left the forwarder to invent a field Discord never sends. An absent flag means
// human, which is how `data.author.bot` reads at the call site.
function isGatewayMessage(
  data: DiscordGatewayMessageData,
): data is Required<
  Pick<
    DiscordGatewayMessageData,
    "author" | "channel_id" | "content" | "guild_id" | "id"
  >
> &
  DiscordGatewayMessageData {
  return Boolean(
    data &&
    typeof data.id === "string" &&
    typeof data.channel_id === "string" &&
    typeof data.content === "string" &&
    (typeof data.guild_id === "string" || data.guild_id === null) &&
    data.author &&
    typeof data.author.id === "string" &&
    typeof data.author.username === "string" &&
    (data.author.bot === undefined || typeof data.author.bot === "boolean"),
  );
}

function mentionsDiscordBot(
  data: DiscordGatewayMessageData,
  options: DiscordChannelOptions,
): boolean {
  if (
    options.botUserId &&
    (data.mentions ?? []).some((mention) => mention.id === options.botUserId)
  ) {
    return true;
  }

  const roleIds = options.mentionRoleIds ?? [];

  return (
    roleIds.length > 0 &&
    (data.mention_roles ?? []).some((roleId) => roleIds.includes(roleId))
  );
}

function parseForwardedGatewayEvent(
  discord: BroodsDiscordAdapter,
  event: DiscordForwardedEventPayload,
  allowedChannelIds: Set<string> | null,
  allowedUserIds: Set<string> | null,
  options: DiscordChannelOptions,
): ChannelParseResult | null {
  if (typeof event.type !== "string" || !event.type.startsWith("GATEWAY_")) {
    return null;
  }

  if (event.type !== "GATEWAY_MESSAGE_CREATE") {
    return gatewayAck();
  }

  const data = event.data as DiscordGatewayMessageData;
  if (!isGatewayMessage(data)) {
    return gatewayAck();
  }

  if (data.author.bot) {
    return {
      kind: "ignore",
      reason: "bot_message",
      response: gatewayAck().response,
    };
  }

  if (!data.guild_id) {
    logWarn("Discord DM gateway messages are disabled", {
      channelId: data.channel_id,
    });

    return {
      kind: "ignore",
      reason: "dm_disabled",
      response: gatewayAck().response,
    };
  }

  if (!isAllowedId(allowedUserIds, data.author?.id)) {
    logWarn("Discord sender not in allow list", { userId: data.author?.id });

    return {
      kind: "ignore",
      reason: "user_not_allowed",
      response: gatewayAck().response,
    };
  }

  // Gate the parent channel, not the thread: a thread id cannot be declared.
  const thread = toDiscordGatewayThread(data);
  if (!isAllowedId(allowedChannelIds, thread.channelId)) {
    logWarn("Discord channel not in allow list", {
      channelId: thread.channelId,
    });

    return {
      kind: "ignore",
      reason: "channel_not_allowed",
      response: gatewayAck().response,
    };
  }

  const threadId = discord.encodeThreadId(thread);
  const attachments = discordAttachments(data);
  const content = data.content.trim();
  // A picture, a voice message or a sticker on its own is still a message.
  if (!content && attachments.length === 0) {
    return {
      kind: "ignore",
      reason: "empty_message",
      response: gatewayAck().response,
    };
  }

  // Only a message addressed to the agent runs it; the rest is stored so a later
  // mention still sees what the channel said. Without a configured botUserId a
  // mention cannot be recognised, so every message keeps running the agent.
  const runAgent = !options.botUserId || mentionsDiscordBot(data, options);
  const omittedUserIds = new Set(
    options.botUserId && runAgent ? [options.botUserId] : [],
  );
  const text = formatDiscordMessageText(content, data, omittedUserIds);
  if (!text && attachments.length === 0) {
    return {
      kind: "ignore",
      reason: "empty_message",
      response: gatewayAck().response,
    };
  }

  const source: DiscordSource = {
    applicationId: "broods-discord-gateway",
    guildId: data.guild_id,
    channelId: thread.channelId,
    ...(thread.threadId ? { threadId: threadId } : {}),
    messageId: data.id,
    userId: data.author.id,
  };

  return {
    kind: runAgent ? "message" : "context",
    ack: gatewayAck().response,
    message: {
      eventId: `${DISCORD_INTEGRATION_PREFIX}${data.id}`,
      conversationKey: threadId,
      channelName: "discord",
      content: [{ type: "text", text: text }],
      ...(attachments.length > 0 ? { attachments: attachments } : {}),
      identity: {
        workspaceRef: data.guild_id,
        channelId: thread.channelId,
        ...(thread.threadId ? { threadId: thread.threadId } : {}),
        userId: data.author.id,
        ...(data.author.global_name || data.author.username
          ? { userName: data.author.global_name || data.author.username }
          : {}),
      },
      // Spread so the typed source reaches a Record<string, unknown> field.
      source: { ...source },
    },
  };
}

function toDiscordGatewayThread(
  data: Required<Pick<DiscordGatewayMessageData, "channel_id" | "guild_id">> &
    DiscordGatewayMessageData,
): DiscordThreadId {
  if (data.thread?.id && data.thread.parent_id) {
    return {
      guildId: data.guild_id ?? "@me",
      channelId: data.thread.parent_id,
      threadId: data.thread.id,
    };
  }

  return {
    guildId: data.guild_id ?? "@me",
    channelId: data.channel_id,
  };
}

function toDiscordInteractionThread(
  payload: DiscordInteractionPayload,
): DiscordThreadId {
  const channelId = payload.channel_id ?? "@me";
  const parentId = payload.channel?.parent_id;
  if (
    parentId &&
    DISCORD_THREAD_CHANNEL_TYPES.has(payload.channel?.type ?? 0)
  ) {
    return {
      guildId: payload.guild_id ?? "@me",
      channelId: parentId,
      threadId: channelId,
    };
  }

  return {
    guildId: payload.guild_id ?? "@me",
    channelId: channelId,
  };
}

function toDiscordSource(source: Record<string, unknown>): DiscordSource {
  if (typeof source.applicationId !== "string") {
    throw new Error("Invalid Discord source payload");
  }

  const channelId =
    typeof source.channelId === "string" ? source.channelId : undefined;
  const threadId =
    typeof source.threadId === "string" ? source.threadId : undefined;
  const interactionId =
    typeof source.interactionId === "string" ? source.interactionId : undefined;
  if (!channelId && !threadId && !interactionId) {
    throw new Error("Invalid Discord source payload");
  }

  return {
    applicationId: source.applicationId,
    interactionToken:
      typeof source.interactionToken === "string"
        ? source.interactionToken
        : undefined,
    interactionId: interactionId,
    guildId: typeof source.guildId === "string" ? source.guildId : undefined,
    channelId: channelId,
    threadId: threadId,
    messageId:
      typeof source.messageId === "string" ? source.messageId : undefined,
    commandToken:
      typeof source.commandToken === "string" ? source.commandToken : undefined,
    userId: typeof source.userId === "string" ? source.userId : undefined,
  };
}

function unsupportedInteractionResponse(): ChannelParseResult {
  return {
    kind: "response",
    response: {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: 4,
        data: { content: "Unsupported interaction.", flags: 64 },
      }),
    },
  };
}
