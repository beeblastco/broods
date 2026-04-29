/**
 * Thin communication-channel integration layer for harness-processing.
 * Keep request normalization, webhook routing, and per-channel lifecycle handling here.
 */

import type {
  SystemModelMessage,
  UserContent,
  UserModelMessage,
} from "ai";
import {
  systemModelMessageSchema,
  userModelMessageSchema,
} from "ai";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { timingSafeEqual } from "node:crypto";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelRequest,
  ChannelResponse,
} from "../_shared/channels.ts";
import { extractText, formatChannelErrorText, isOpenAllowList } from "../_shared/channels.ts";
import { parseCommand } from "../_shared/commands.ts";
import { createDiscordChannel } from "../_shared/discord-channel.ts";
import { optionalEnv } from "../_shared/env.ts";
import { INTERNAL_EVENT_ID_PREFIX } from "../_shared/filesystem-namespace.ts";
import { createGitHubChannel } from "../_shared/github-channel.ts";
import { logError } from "../_shared/log.ts";
import type { LambdaResponse } from "../_shared/runtime.ts";
import { createSlackChannel } from "../_shared/slack-channel.ts";
import { createTelegramChannel } from "../_shared/telegram-channel.ts";
import type { WebhookConfig } from "../_shared/webhook.ts";
import type { ConversationIngressEvent } from "./session.ts";

const DIRECT_API_EVENT_ID_PREFIX = "api:";
const DIRECT_API_CONVERSATION_PREFIX = "api:";
const RESERVED_EVENT_ID_PREFIXES = [
  INTERNAL_EVENT_ID_PREFIX,
  DIRECT_API_EVENT_ID_PREFIX,
  "gh:",
  "slack:",
  "slack-command:",
  "discord:",
  "tg-",
] as const;
const RESERVED_CONVERSATION_PREFIXES = [
  INTERNAL_EVENT_ID_PREFIX,
  DIRECT_API_CONVERSATION_PREFIX,
  "gh:",
  "slack:",
  "tg:",
  "discord:",
] as const;
const CLOSED_ALLOW_LIST = "closed";

type DirectIngressEvent =
  | UserModelMessage
  | (SystemModelMessage & { persist: false });

export interface DirectInboundEvent {
  eventId: string;
  publicEventId: string;
  conversationKey: string;
  publicConversationKey: string;
  events: DirectIngressEvent[];
  webhookConfig?: WebhookConfig;
}

export interface AsyncDirectInboundEvent extends DirectInboundEvent {
  statusUrl: string;
}

export interface StatusInboundEvent {
  eventId: string;
  publicEventId: string;
}

export type HandlerEvent = LambdaFunctionURLEvent;

export interface ChannelInboundEvent {
  eventId: string;
  conversationKey: string;
  content: UserContent;
  events: ConversationIngressEvent[];
  channelName: string;
  source: Record<string, unknown>;
  channel: ChannelActions;
  commandToken?: string;
}

interface IntegrationHandlers {
  handleDirectRequest(event: DirectInboundEvent): Promise<LambdaResponse>;
  handleAsyncRequest?(event: AsyncDirectInboundEvent): Promise<LambdaResponse>;
  handleStatusRequest?(event: StatusInboundEvent): Promise<LambdaResponse>;
  handleChannelRequest(event: ChannelInboundEvent): Promise<void>;
}

export interface ChannelRegistry {
  telegramChannel: ChannelAdapter | null;
  githubChannel: ChannelAdapter | null;
  slackChannel: ChannelAdapter | null;
  discordChannel: ChannelAdapter | null;
  webhookChannels: ChannelAdapter[];
}

interface IntegrationRoutingOptions {
  channelRegistry?: ChannelRegistry;
}

export async function routeIncomingEvent(
  event: HandlerEvent,
  handlers: IntegrationHandlers,
): Promise<LambdaResponse> {
  return createIncomingEventRouter()(event, handlers);
}

export function createIncomingEventRouter(options: IntegrationRoutingOptions = {}) {
  const channelRegistry = options.channelRegistry ?? createChannelRegistry();

  return async (
    event: HandlerEvent,
    handlers: IntegrationHandlers,
  ): Promise<LambdaResponse> => handleLambdaUrlEvent(event, handlers, channelRegistry);
}

async function handleLambdaUrlEvent(
  event: LambdaFunctionURLEvent,
  handlers: IntegrationHandlers,
  channelRegistry: ChannelRegistry,
): Promise<LambdaResponse> {
  const method = event.requestContext.http.method;
  const headers = normalizeHeaders(event.headers);

  if (method === "GET" && isStatusPath(event.rawPath)) {
    if (!isDirectApiConfigured()) {
      return directApiNotConfiguredResponse();
    }

    if (!isAuthorizedDirectApiRequest(headers, optionalEnv("DIRECT_API_SECRET") ?? "")) {
      return unauthorizedResponse();
    }

    try {
      if (!handlers.handleStatusRequest) {
        return notFoundResponse();
      }

      return handlers.handleStatusRequest(parseStatusPath(event.rawPath));
    } catch (err) {
      return badRequestResponse(err);
    }
  }

  if (method === "GET") {
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
    headers,
    body: decodeBody(event.body, event.isBase64Encoded),
  } satisfies ChannelRequest;

  const matchedChannel = channelRegistry.webhookChannels.find((channel) => channel.canHandle(request));
  if (matchedChannel) {
    return handleChannelWebhook(matchedChannel, request, handlers);
  }

  const unavailableResponse = detectUnconfiguredChannel(request.headers, channelRegistry);
  if (unavailableResponse) {
    return unavailableResponse;
  }

  if (!isDirectApiConfigured()) {
    return directApiNotConfiguredResponse();
  }

  if (!isAuthorizedDirectApiRequest(request.headers, optionalEnv("DIRECT_API_SECRET") ?? "")) {
    return unauthorizedResponse();
  }

  try {
    const parsed = parseDirectPayload(request.body, request.headers);
    if (isAsyncPath(event.rawPath)) {
      if (!handlers.handleAsyncRequest) {
        return notFoundResponse();
      }

      return handlers.handleAsyncRequest({
        ...parsed,
        statusUrl: buildStatusUrl(event, parsed.publicEventId),
      });
    }

    return handlers.handleDirectRequest(parsed);
  } catch (err) {
    return badRequestResponse(err);
  }
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
          events: [{ role: "user", content: message.content }],
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
    const error = err instanceof Error ? err.message : String(err);
    logError("Failed to process channel message", {
      channel: event.channelName,
      eventId: event.eventId,
      error,
    });
    await event.channel.sendText(formatChannelErrorText(error)).catch((sendErr) => {
      logError("Failed to send channel error message", {
        channel: event.channelName,
        eventId: event.eventId,
        error: sendErr instanceof Error ? sendErr.message : String(sendErr),
      });
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

function detectUnconfiguredChannel(
  headers: Record<string, string>,
  channelRegistry: ChannelRegistry,
): LambdaResponse | null {
  if ("x-telegram-bot-api-secret-token" in headers && !channelRegistry.telegramChannel) {
    return integrationNotConfigured("Telegram");
  }

  if ("x-github-event" in headers && !channelRegistry.githubChannel) {
    return integrationNotConfigured("GitHub");
  }

  if ("x-slack-signature" in headers && !channelRegistry.slackChannel) {
    return integrationNotConfigured("Slack");
  }

  if ("x-signature-ed25519" in headers && !channelRegistry.discordChannel) {
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

function createChannelRegistry(): ChannelRegistry {
  const telegramChannel = createOptionalTelegramChannel();
  const githubChannel = createOptionalGitHubChannel();
  const slackChannel = createOptionalSlackChannel();
  const discordChannel = createOptionalDiscordChannel();

  return {
    telegramChannel,
    githubChannel,
    slackChannel,
    discordChannel,
    webhookChannels: [
      telegramChannel,
      githubChannel,
      slackChannel,
      discordChannel,
    ].filter((channel): channel is ChannelAdapter => channel !== null),
  };
}

function isAuthorizedDirectApiRequest(headers: Record<string, string>, secret: string): boolean {
  const token = extractBearerToken(headers.authorization);
  if (!token) {
    return false;
  }

  const actual = Buffer.from(token);
  const expected = Buffer.from(secret);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }

  const [scheme, token, ...rest] = authorization.trim().split(/\s+/);
  if (rest.length > 0 || !scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  return token;
}

function parseDirectPayload(bodyText: string, headers: Record<string, string>): DirectInboundEvent {
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
    typeof (parsed as Record<string, unknown>).conversationKey !== "string"
  ) {
    throw new Error("Request body must include eventId and conversationKey");
  }

  const record = parsed as Record<string, unknown>;
  const rawEventId = normalizeDirectIdentifier("eventId", record.eventId as string);
  if (hasReservedEventIdPrefix(rawEventId)) {
    throw new Error("eventId uses a reserved internal prefix");
  }

  const rawConversationKey = normalizeDirectIdentifier("conversationKey", record.conversationKey as string);
  if (hasReservedConversationPrefix(rawConversationKey)) {
    throw new Error("conversationKey uses a reserved channel or internal prefix");
  }

  const events = parseDirectIngressEvents(record);
  if (events.length === 0) {
    throw new Error("Request body must include a non-empty events array");
  }
  const webhookConfig = parseWebhookConfig(record.webhookUrl, headers["x-webhook-secret"]);

  return {
    eventId: `${DIRECT_API_EVENT_ID_PREFIX}${rawEventId}`,
    publicEventId: rawEventId,
    conversationKey: `${DIRECT_API_CONVERSATION_PREFIX}${rawConversationKey}`,
    publicConversationKey: rawConversationKey,
    events,
    ...(webhookConfig ? { webhookConfig } : {}),
  };
}

function parseWebhookConfig(rawUrl: unknown, rawSecret: string | undefined): WebhookConfig | undefined {
  if (rawUrl == null && rawSecret == null) {
    return undefined;
  }

  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    throw new Error("webhookUrl must be a non-empty string when X-Webhook-Secret is provided");
  }

  if (!rawSecret || rawSecret.trim().length === 0) {
    throw new Error("X-Webhook-Secret is required when webhookUrl is provided");
  }

  const url = rawUrl.trim();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error("webhookUrl must use https");
    }
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "webhookUrl must be a valid URL");
  }

  return {
    url,
    secret: rawSecret,
  };
}

function parseStatusPath(rawPath: string): StatusInboundEvent {
  const match = rawPath.match(/^\/status\/([^/]+)$/);
  const rawEventId = match?.[1] ? decodeURIComponent(match[1]) : "";
  const publicEventId = normalizeDirectIdentifier("eventId", rawEventId);
  if (hasReservedEventIdPrefix(publicEventId)) {
    throw new Error("eventId uses a reserved internal prefix");
  }

  return {
    eventId: `${DIRECT_API_EVENT_ID_PREFIX}${publicEventId}`,
    publicEventId,
  };
}

function isDirectApiConfigured(): boolean {
  return optionalEnv("ENABLE_DIRECT_API") === "true" && !!optionalEnv("DIRECT_API_SECRET");
}

function directApiNotConfiguredResponse(): LambdaResponse {
  return {
    statusCode: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: "Direct API is not configured",
  };
}

function unauthorizedResponse(): LambdaResponse {
  return {
    statusCode: 401,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: "Unauthorized",
  };
}

function badRequestResponse(err: unknown): LambdaResponse {
  return {
    statusCode: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: err instanceof Error ? err.message : "Invalid request",
  };
}

function notFoundResponse(): LambdaResponse {
  return {
    statusCode: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: "Not found",
  };
}

function isAsyncPath(rawPath: string): boolean {
  return rawPath === "/async";
}

function isStatusPath(rawPath: string): boolean {
  return rawPath.startsWith("/status/");
}

function buildStatusUrl(event: LambdaFunctionURLEvent, publicEventId: string): string {
  const headers = normalizeHeaders(event.headers);
  const protocol = headers["x-forwarded-proto"] ?? "https";
  const host = headers.host;
  if (!host) {
    throw new Error("Request is missing Host header");
  }

  return `${protocol}://${host}/status/${encodeURIComponent(publicEventId)}`;
}

function parseDirectIngressEvents(record: Record<string, unknown>): DirectIngressEvent[] {
  const explicitEvents = record.events;

  if (explicitEvents == null) {
    return [];
  }

  if (!Array.isArray(explicitEvents)) {
    throw new Error("Request body field 'events' must be an array");
  }

  return explicitEvents.map(parseDirectIngressEvent);
}

function parseDirectIngressEvent(rawEvent: unknown): DirectIngressEvent {
  if (!rawEvent || typeof rawEvent !== "object") {
    throw new Error("Each direct event must be an object");
  }

  const candidate = rawEvent as Record<string, unknown>;
  const persist = candidate.persist;
  if (persist !== undefined && typeof persist !== "boolean") {
    throw new Error("Event field 'persist' must be a boolean when provided");
  }

  if (persist !== undefined && candidate.role !== "system") {
    throw new Error("Only system-role events may set persist");
  }

  if (candidate.role === "user") {
    const parsedUser = userModelMessageSchema.safeParse(candidate);
    if (!parsedUser.success) {
      throw new Error(`Invalid direct event: ${parsedUser.error.issues[0]?.message ?? "must match UserModelMessage"}`);
    }

    return parsedUser.data;
  }

  if (candidate.role !== "system") {
    throw new Error("Direct API accepts only user and ephemeral system events");
  }

  if (persist === true) {
    throw new Error("Direct API system events cannot be persisted");
  }

  const parsedSystem = systemModelMessageSchema.safeParse(candidate);
  if (!parsedSystem.success) {
    throw new Error(`Invalid direct event: ${parsedSystem.error.issues[0]?.message ?? "must match SystemModelMessage"}`);
  }

  return {
    ...parsedSystem.data,
    persist: false,
  };
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
  if (raw?.trim().toLowerCase() === CLOSED_ALLOW_LIST) {
    return new Set();
  }

  if (isOpenAllowList(raw)) {
    return null;
  }

  const values = raw
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0) ?? [];

  return values.length > 0 ? new Set(values) : null;
}

function hasReservedConversationPrefix(value: string): boolean {
  return RESERVED_CONVERSATION_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function hasReservedEventIdPrefix(value: string): boolean {
  return RESERVED_EVENT_ID_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function normalizeDirectIdentifier(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} must not be empty`);
  }

  return normalized;
}

function createOptionalTelegramChannel(): ChannelAdapter | null {
  const botToken = optionalEnv("TELEGRAM_BOT_TOKEN");
  const webhookSecret = optionalEnv("TELEGRAM_WEBHOOK_SECRET");
  const allowedChatIdsRaw = optionalEnv("ALLOWED_CHAT_IDS");
  if (!botToken || !webhookSecret || !allowedChatIdsRaw) {
    return null;
  }

  return createTelegramChannel(
    botToken,
    webhookSecret,
    parseAllowedChatIds(allowedChatIdsRaw),
    optionalEnv("TELEGRAM_REACTION_EMOJI") ?? "👀",
  );
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
