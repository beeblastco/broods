/**
 * Discord channel adapter.
 * Verify interaction signatures, normalize slash commands, and send replies through the Discord HTTP API.
 */

import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult
} from "./channels.ts";
import { formatDiscordMessage } from "./channel-format.ts";
import { resolveDiscordCommand } from "./commands.ts";
import { verifyDiscordSignature } from "./discord-signature.ts";
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

export interface DiscordSource {
  applicationId: string;
  interactionToken: string;
  interactionId: string;
  guildId?: string;
  channelId?: string;
  commandToken?: string;
  userId?: string;
}

export function createDiscordChannel(
  botToken: string,
  publicKey: string,
  allowedGuildIds: Set<string> | null,
): ChannelAdapter {
  return {
    name: "discord",

    canHandle(req) {
      return "x-signature-ed25519" in req.headers;
    },

    authenticate(req) {
      return verifyDiscordSignature(
        publicKey,
        req.headers["x-signature-ed25519"],
        req.headers["x-signature-timestamp"],
        req.body,
      );
    },

    parse(req): ChannelParseResult {
      const payload = JSON.parse(req.body) as DiscordInteractionPayload;

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

      const resolvedCommand = resolveDiscordCommand(
        payload.data.name,
        extractOptionText(payload.data.options),
      );
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
      return createDiscordActions(botToken, toDiscordSource(msg.source));
    },
  };
}

function createDiscordActions(
  botToken: string,
  source: DiscordSource,
): ChannelActions {
  return {
    async sendText(text) {
      const chunks = splitDiscordMessage(formatDiscordMessage(text));

      try {
        await sendInteractionReply(source, chunks);
      } catch (err) {
        // The interaction token expires ~15 min after the slash command, so a
        // delayed reply (e.g. a background job that finishes later) cannot use
        // it. When nothing was sent yet and we know the channel, post with the
        // bot token instead. A mid-send failure (first chunk already delivered)
        // is rethrown so the live path never double-posts.
        if (err instanceof DiscordInteractionUnavailable && source.channelId) {
          await sendBotChannelMessages(botToken, source.channelId, chunks);
          return;
        }
        throw err;
      }
    },

    async sendTyping() {
      if (!source.channelId) {
        return;
      }

      const response = await fetch(
        `https://discord.com/api/v10/channels/${source.channelId}/typing`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bot ${botToken}`,
          },
        },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Discord typing indicator failed (${response.status}): ${body}`);
      }
    },

    async reactToMessage() {
      return;
    },
  };
}

// Raised when the first interaction request fails, signalling that nothing was
// delivered yet so the caller may safely fall back to a bot-token channel post.
class DiscordInteractionUnavailable extends Error {}

/**
 * Reply to a slash command through its interaction webhook: the first chunk
 * edits the deferred "thinking" message, the rest post as follow-ups. A failure
 * on the first chunk throws DiscordInteractionUnavailable (token likely expired,
 * nothing sent); a later failure throws a plain error (partial delivery).
 */
async function sendInteractionReply(source: DiscordSource, chunks: string[]): Promise<void> {
  for (const [index, chunk] of chunks.entries()) {
    const response = await fetch(
      index === 0
        ? `https://discord.com/api/v10/webhooks/${source.applicationId}/${source.interactionToken}/messages/@original`
        : `https://discord.com/api/v10/webhooks/${source.applicationId}/${source.interactionToken}`,
      {
        method: index === 0 ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: chunk,
          allowed_mentions: { parse: [] },
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      const message = `Discord reply failed (${response.status}): ${body}`;
      throw index === 0 ? new DiscordInteractionUnavailable(message) : new Error(message);
    }
  }
}

/**
 * Post a message directly to a channel with the bot token. Used for delayed
 * replies once the interaction token has expired; requires the bot to have
 * Send Messages permission in the channel.
 */
async function sendBotChannelMessages(botToken: string, channelId: string, chunks: string[]): Promise<void> {
  for (const chunk of chunks) {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bot ${botToken}`,
        },
        body: JSON.stringify({
          content: chunk,
          allowed_mentions: { parse: [] },
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord channel message failed (${response.status}): ${body}`);
    }
  }
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

function extractOptionText(options: DiscordInteractionOption[] | undefined): string {
  if (!options || options.length === 0) {
    return "";
  }

  return flattenOptions(options).join(" ").trim();
}

function flattenOptions(options: DiscordInteractionOption[]): string[] {
  const values: string[] = [];

  for (const option of options) {
    if (option.options?.length) {
      values.push(...flattenOptions(option.options));
      continue;
    }

    if (option.value !== undefined) {
      values.push(String(option.value));
    }
  }

  return values;
}

function splitDiscordMessage(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [""];
  }

  if (trimmed.length <= 2000) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > 2000) {
    const candidate = remaining.slice(0, 2000);
    const splitAt = Math.max(
      candidate.lastIndexOf("\n\n"),
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf(" "),
    );
    const boundary = splitAt > 1000 ? splitAt : 2000;

    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function toDiscordSource(source: Record<string, unknown>): DiscordSource {
  if (
    typeof source.applicationId !== "string" ||
    typeof source.interactionToken !== "string" ||
    typeof source.interactionId !== "string"
  ) {
    throw new Error("Invalid Discord source payload");
  }

  return {
    applicationId: source.applicationId,
    interactionToken: source.interactionToken,
    interactionId: source.interactionId,
    guildId: typeof source.guildId === "string" ? source.guildId : undefined,
    channelId: typeof source.channelId === "string" ? source.channelId : undefined,
    commandToken: typeof source.commandToken === "string" ? source.commandToken : undefined,
    userId: typeof source.userId === "string" ? source.userId : undefined,
  };
}
