/**
 * Thin communication-channel integration layer for harness-processing.
 * Keep request normalization, webhook routing, and per-channel lifecycle handling here.
 */

import type { UserContent } from "ai";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelRequest,
  ChannelResponse,
} from "../_shared/channels.ts";
import { extractText, isOpenAllowList } from "../_shared/channels.ts";
import { parseCommand } from "../_shared/commands.ts";
import { createDiscordChannel } from "../_shared/discord-channel.ts";
import { optionalEnv, requireEnv } from "../_shared/env.ts";
import { createGitHubChannel } from "../_shared/github-channel.ts";
import { logError } from "../_shared/log.ts";
import type { LambdaResponse } from "../_shared/runtime.ts";
import { createSlackChannel } from "../_shared/slack-channel.ts";
import { createTelegramChannel } from "../_shared/telegram-channel.ts";

const telegramChannel = createTelegramChannel(
  requireEnv("TELEGRAM_BOT_TOKEN"),
  requireEnv("TELEGRAM_WEBHOOK_SECRET"),
  parseAllowedChatIds(requireEnv("ALLOWED_CHAT_IDS")),
  requireEnv("TELEGRAM_REACTION_EMOJI"),
);

const githubChannel = createOptionalGitHubChannel();
const slackChannel = createOptionalSlackChannel();
const discordChannel = createOptionalDiscordChannel();

const webhookChannels = [
  telegramChannel,
  githubChannel,
  slackChannel,
  discordChannel,
].filter((channel): channel is ChannelAdapter => channel !== null);

export interface InboundEvent {
  eventId: string;
  conversationKey: string;
  content: UserContent;
}

export type HandlerEvent = InboundEvent | LambdaFunctionURLEvent;

export interface ChannelInboundEvent extends InboundEvent {
  channelName: string;
  source: Record<string, unknown>;
  channel: ChannelActions;
  commandToken?: string;
}

interface IntegrationHandlers {
  handleDirectRequest(event: InboundEvent): Promise<LambdaResponse>;
  handleChannelRequest(event: ChannelInboundEvent): Promise<void>;
}

export async function routeIncomingEvent(
  event: HandlerEvent,
  handlers: IntegrationHandlers,
): Promise<LambdaResponse> {
  if (!isLambdaUrlEvent(event)) {
    return handlers.handleDirectRequest(event);
  }

  return handleLambdaUrlEvent(event, handlers);
}

async function handleLambdaUrlEvent(
  event: LambdaFunctionURLEvent,
  handlers: IntegrationHandlers,
): Promise<LambdaResponse> {
  const method = event.requestContext.http.method;

  if (method === "GET" || event.rawPath === "/health") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "ok",
    };
  }

  if (method !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "Method not allowed",
    };
  }

  const request = {
    method,
    rawPath: event.rawPath,
    headers: normalizeHeaders(event.headers),
    body: decodeBody(event.body, event.isBase64Encoded),
  } satisfies ChannelRequest;

  const matchedChannel = webhookChannels.find((channel) => channel.canHandle(request));
  if (matchedChannel) {
    return handleChannelWebhook(matchedChannel, request, handlers);
  }

  const unavailableResponse = detectUnconfiguredChannel(request.headers);
  if (unavailableResponse) {
    return unavailableResponse;
  }

  return handlers.handleDirectRequest(parseDirectPayload(request.body));
}

async function handleChannelWebhook(
  adapter: ChannelAdapter,
  request: ChannelRequest,
  handlers: IntegrationHandlers,
): Promise<LambdaResponse> {
  try {
    if (!(await adapter.authenticate(request))) {
      return {
        statusCode: 401,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: "Unauthorized",
      };
    }

    const parsed = adapter.parse(request);

    if (parsed.kind === "response") {
      return toLambdaResponse(parsed.response);
    }

    if (parsed.kind === "ignore") {
      return toLambdaResponse(parsed.response ?? { statusCode: 200 });
    }

    const { message, ack } = parsed;
    const channel = adapter.actions(message);
    const response = ack ?? { statusCode: 200 };

    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body ?? "",
      afterResponse: processChannelMessage(
        {
          eventId: message.eventId,
          conversationKey: message.conversationKey,
          content: message.content,
          channelName: message.channelName,
          source: message.source,
          channel,
        },
        handlers,
      ),
    };
  } catch (err) {
    logError("Failed to process webhook request", {
      channel: adapter.name,
      error: err instanceof Error ? err.message : String(err),
    });

    return {
      statusCode: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "Internal server error",
    };
  }
}

async function processChannelMessage(
  event: ChannelInboundEvent,
  handlers: IntegrationHandlers,
): Promise<void> {
  try {
    event.channel.sendTyping().catch(() => { });
    event.channel.reactToMessage().catch(() => { });

    await handlers.handleChannelRequest({
      ...event,
      commandToken: resolveCommandToken(event.content, event.source) ?? undefined,
    });
  } catch (err) {
    logError("Failed to process channel message", {
      channel: event.channelName,
      eventId: event.eventId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function resolveCommandToken(
  content: UserContent,
  source: Record<string, unknown>,
): string | null {
  const inlineCommand = parseCommand(extractText(content));
  if (inlineCommand) {
    return inlineCommand;
  }

  if (typeof source.commandToken === "string") {
    return parseCommand(source.commandToken);
  }

  return null;
}

function toLambdaResponse(response: ChannelResponse): LambdaResponse {
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body ?? "",
  };
}

function normalizeHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
    }
  }

  return normalized;
}

function decodeBody(body: string | undefined, isBase64Encoded?: boolean): string {
  const raw = body ?? "";
  return isBase64Encoded ? Buffer.from(raw, "base64").toString("utf-8") : raw;
}

function isLambdaUrlEvent(event: HandlerEvent): event is LambdaFunctionURLEvent {
  return typeof event === "object" && event !== null && "version" in event;
}

function detectUnconfiguredChannel(headers: Record<string, string>): LambdaResponse | null {
  if ("x-github-event" in headers && !githubChannel) {
    return integrationNotConfigured("GitHub");
  }

  if ("x-slack-signature" in headers && !slackChannel) {
    return integrationNotConfigured("Slack");
  }

  if ("x-signature-ed25519" in headers && !discordChannel) {
    return integrationNotConfigured("Discord");
  }

  return null;
}

function integrationNotConfigured(name: string): LambdaResponse {
  return {
    statusCode: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: `${name} integration is not configured`,
  };
}

function parseDirectPayload(bodyText: string): InboundEvent {
  let parsed: unknown;

  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    throw new Error(`Invalid request JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).eventId !== "string" ||
    typeof (parsed as Record<string, unknown>).conversationKey !== "string" ||
    !("content" in (parsed as Record<string, unknown>))
  ) {
    throw new Error("Request body must include eventId, conversationKey, and content");
  }

  return parsed as InboundEvent;
}

function parseAllowedChatIds(raw: string): Set<number> {
  const ids = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));

  if (ids.length === 0) {
    throw new Error("ALLOWED_CHAT_IDS contains no valid numeric IDs");
  }

  return new Set(ids);
}

function parseStringAllowList(raw: string | undefined): Set<string> | null {
  if (isOpenAllowList(raw)) {
    return null;
  }

  const values = raw
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0) ?? [];

  return values.length > 0 ? new Set(values) : null;
}

function createOptionalGitHubChannel(): ChannelAdapter | null {
  const webhookSecret = optionalEnv("GITHUB_WEBHOOK_SECRET");
  const appId = optionalEnv("GITHUB_APP_ID");
  const privateKey = optionalEnv("GITHUB_PRIVATE_KEY");
  if (!webhookSecret || !appId || !privateKey) {
    return null;
  }

  return createGitHubChannel(
    webhookSecret,
    appId,
    privateKey,
    parseStringAllowList(optionalEnv("GITHUB_ALLOWED_REPOS")),
  );
}

function createOptionalSlackChannel(): ChannelAdapter | null {
  const botToken = optionalEnv("SLACK_BOT_TOKEN");
  const signingSecret = optionalEnv("SLACK_SIGNING_SECRET");
  if (!botToken || !signingSecret) {
    return null;
  }

  return createSlackChannel(
    botToken,
    signingSecret,
    parseStringAllowList(optionalEnv("SLACK_ALLOWED_CHANNEL_IDS")),
  );
}

function createOptionalDiscordChannel(): ChannelAdapter | null {
  const botToken = optionalEnv("DISCORD_BOT_TOKEN");
  const publicKey = optionalEnv("DISCORD_PUBLIC_KEY");
  if (!botToken || !publicKey) {
    return null;
  }

  return createDiscordChannel(
    botToken,
    publicKey,
    parseStringAllowList(optionalEnv("DISCORD_ALLOWED_GUILD_IDS")),
  );
}
