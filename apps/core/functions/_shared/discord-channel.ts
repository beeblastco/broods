/**
 * Discord channel adapter.
 * Verify interaction signatures, normalize slash commands, and send replies through Chat SDK's Discord adapter.
 */

import { DiscordAdapter, type DiscordThreadId } from "@chat-adapter/discord";
import { ConsoleLogger } from "chat";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult
} from "./channels.ts";
import { resolveDiscordCommand } from "./commands.ts";
import { logWarn } from "./log.ts";
import { DISCORD_INTEGRATION_PREFIX } from "./runtime-keys.ts";

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
  data?: {
    name?: string;
    options?: DiscordInteractionOption[];
  };
  member?: {
    user?: { id?: string };
  };
  user?: { id?: string };
}

interface DiscordForwardedEventPayload {
  type?: string;
  timestamp?: number;
  data?: unknown;
}

interface DiscordGatewayMessageData {
  attachments?: Array<{
    id?: string;
    url?: string;
    filename?: string;
    content_type?: string;
    size?: number;
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
  mentions?: Array<{ id?: string; username?: string }>;
  thread?: {
    id?: string;
    parent_id?: string;
  };
  timestamp?: string;
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

interface DiscordSlashCommandContext {
  channelId: string;
  initialResponseSent: boolean;
  interactionToken: string;
}

// Chat SDK's direct Discord webhook path is `handleWebhook()` + ChatInstance.
// Broods cannot use that path wholesale because `integrations.ts` must first do
// account/agent lookup, per-tenant config scoping, durable session setup, and
// DynamoDB conversation history writes. The SDK also keeps the lower-level hooks
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
    return this.verifySignature(new TextEncoder().encode(body), signature ?? null, timestamp ?? null);
  }

  parseCommand(name: string, options: DiscordInteractionOption[] | undefined): {
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
  allowedGuildIds: Set<string> | null,
  apiUrl?: string,
): ChannelAdapter {
  const discord = new BroodsDiscordAdapter({
    apiUrl,
    applicationId: "broods-discord-webhook",
    botToken,
    publicKey,
    logger: new ConsoleLogger("error").child("discord"),
  });

  return {
    name: "discord",

    canHandle(req) {
      return "x-signature-ed25519" in req.headers || "x-discord-gateway-token" in req.headers;
    },

    authenticate(req) {
      if ("x-discord-gateway-token" in req.headers) {
        return req.headers["x-discord-gateway-token"] === botToken;
      }

      return discord.verifyRequestSignature(
        req.body,
        req.headers["x-signature-ed25519"],
        req.headers["x-signature-timestamp"],
      );
    },

    parse(req): ChannelParseResult {
      const payload = JSON.parse(req.body) as DiscordInteractionPayload;
      const gatewayEvent = parseForwardedGatewayEvent(discord, payload as DiscordForwardedEventPayload, allowedGuildIds);
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
        logWarn("Discord DM interactions are disabled", { channelId: payload.channel_id });
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

      if (allowedGuildIds && payload.guild_id && !allowedGuildIds.has(payload.guild_id)) {
        logWarn("Discord guild not in allow list", { guildId: payload.guild_id });
        return {
          kind: "response",
          response: {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: 4,
              data: { content: "This server is not allowed.", flags: 64 },
            }),
          },
        };
      }

      const command = discord.parseCommand(payload.data.name, payload.data.options);
      const resolvedCommand = resolveDiscordCommand(command.command.replace(/^\//, ""), command.text);
      if (!resolvedCommand) {
        return unsupportedInteractionResponse();
      }

      return {
        kind: "message",
        ack: {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: 5 }),
        },
        message: {
          eventId: `${DISCORD_INTEGRATION_PREFIX}${payload.id}`,
          conversationKey: `${DISCORD_INTEGRATION_PREFIX}${payload.guild_id}:${payload.channel_id}`,
          channelName: "discord",
          content: resolvedCommand.contentText
            ? [{ type: "text", text: resolvedCommand.contentText }]
            : [],
          source: {
            applicationId: payload.application_id,
            interactionToken: payload.token,
            interactionId: payload.id,
            guildId: payload.guild_id,
            channelId: payload.channel_id,
            ...(resolvedCommand.commandToken
              ? { commandToken: resolvedCommand.commandToken }
              : {}),
            userId: payload.member?.user?.id ?? payload.user?.id,
          } satisfies DiscordSource,
        },
      };
    },

    actions(msg): ChannelActions {
      return createDiscordActions(botToken, publicKey, toDiscordSource(msg.source), apiUrl);
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
    apiUrl,
    applicationId: source.applicationId,
    botToken,
    publicKey,
    logger: new ConsoleLogger("error").child("discord"),
  });
  const threadId = source.threadId ?? discord.encodeThreadId({
    guildId: source.guildId ?? "@me",
    channelId: source.channelId ?? source.interactionId ?? source.messageId ?? "@me",
  } satisfies DiscordThreadId);

  return {
    async sendText(text) {
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

    async sendTyping() {
      if (!source.channelId) {
        return;
      }
      await discord.startTyping(threadId);
    },

    async reactToMessage() {
      if (typeof source.messageId !== "string") {
        return;
      }
      await discord.addReaction(threadId, source.messageId, "eyes");
      return;
    },
  };
}

function parseForwardedGatewayEvent(
  discord: BroodsDiscordAdapter,
  event: DiscordForwardedEventPayload,
  allowedGuildIds: Set<string> | null,
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
    return { kind: "ignore", reason: "bot_message", response: gatewayAck().response };
  }

  if (!data.guild_id) {
    logWarn("Discord DM gateway messages are disabled", { channelId: data.channel_id });
    return { kind: "ignore", reason: "dm_disabled", response: gatewayAck().response };
  }

  if (allowedGuildIds && !allowedGuildIds.has(data.guild_id)) {
    logWarn("Discord guild not in allow list", { guildId: data.guild_id });
    return { kind: "ignore", reason: "guild_not_allowed", response: gatewayAck().response };
  }

  const thread = toDiscordGatewayThread(data);
  const threadId = discord.encodeThreadId(thread);
  const content = data.content.trim();
  if (!content) {
    return { kind: "ignore", reason: "empty_message", response: gatewayAck().response };
  }

  return {
    kind: "message",
    ack: gatewayAck().response,
    message: {
      eventId: `${DISCORD_INTEGRATION_PREFIX}${data.id}`,
      conversationKey: threadId,
      channelName: "discord",
      content: [{ type: "text", text: content }],
      source: {
        applicationId: "broods-discord-gateway",
        guildId: data.guild_id,
        channelId: thread.channelId,
        ...(thread.threadId ? { threadId } : {}),
        messageId: data.id,
        userId: data.author.id,
      } satisfies DiscordSource,
    },
  };
}

function isGatewayMessage(data: DiscordGatewayMessageData): data is Required<
  Pick<DiscordGatewayMessageData, "author" | "channel_id" | "content" | "guild_id" | "id">
> & DiscordGatewayMessageData {
  return Boolean(
    data &&
    typeof data.id === "string" &&
    typeof data.channel_id === "string" &&
    typeof data.content === "string" &&
    (typeof data.guild_id === "string" || data.guild_id === null) &&
    data.author &&
    typeof data.author.id === "string" &&
    typeof data.author.username === "string" &&
    typeof data.author.bot === "boolean",
  );
}

function toDiscordGatewayThread(data: Required<
  Pick<DiscordGatewayMessageData, "channel_id" | "guild_id">
> & DiscordGatewayMessageData): DiscordThreadId {
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

function toDiscordSource(source: Record<string, unknown>): DiscordSource {
  if (typeof source.applicationId !== "string") {
    throw new Error("Invalid Discord source payload");
  }

  const channelId = typeof source.channelId === "string" ? source.channelId : undefined;
  const threadId = typeof source.threadId === "string" ? source.threadId : undefined;
  const interactionId = typeof source.interactionId === "string" ? source.interactionId : undefined;
  if (!channelId && !threadId && !interactionId) {
    throw new Error("Invalid Discord source payload");
  }

  return {
    applicationId: source.applicationId,
    interactionToken: typeof source.interactionToken === "string" ? source.interactionToken : undefined,
    interactionId,
    guildId: typeof source.guildId === "string" ? source.guildId : undefined,
    channelId,
    threadId,
    messageId: typeof source.messageId === "string" ? source.messageId : undefined,
    commandToken: typeof source.commandToken === "string" ? source.commandToken : undefined,
    userId: typeof source.userId === "string" ? source.userId : undefined,
  };
}
