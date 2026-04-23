/**
 * Discord channel adapter.
 * Verify interaction signatures, normalize slash commands, and send replies through the Discord HTTP API.
 */

import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult
} from "./channels.ts";
import { verifyDiscordSignature } from "./discord-signature.ts";
import { logWarn } from "./log.ts";

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

      return {
        kind: "message",
        ack: {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: 5 }),
        },
        message: {
          eventId: `discord:${payload.id}`,
          conversationKey: payload.guild_id
            ? `discord:${payload.guild_id}:${payload.channel_id}`
            : `discord:dm:${payload.channel_id}`,
          channelName: "discord",
          content: [{ type: "text", text: extractOptionText(payload.data.options) }],
          source: {
            applicationId: payload.application_id,
            interactionToken: payload.token,
            interactionId: payload.id,
            guildId: payload.guild_id,
            channelId: payload.channel_id,
            commandToken: `/${payload.data.name}`,
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
      const response = await fetch(
        `https://discord.com/api/v10/webhooks/${source.applicationId}/${source.interactionToken}/messages/@original`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: text,
            allowed_mentions: { parse: [] },
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Discord reply failed (${response.status}): ${body}`);
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
