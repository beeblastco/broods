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
import {
  getAccount,
  resolveBearerAuth,
  toRuntimeAccountConfig,
  type AccountConfig,
  type AccountRecord,
  type AuthContext,
} from "../_shared/accounts.ts";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelRequest,
  ChannelResponse,
} from "../_shared/channels.ts";
import { extractText, formatChannelErrorText } from "../_shared/channels.ts";
import { parseCommand } from "../_shared/commands.ts";
import { createDiscordChannel } from "../_shared/discord-channel.ts";
import { INTERNAL_EVENT_ID_PREFIX } from "../_shared/filesystem-namespace.ts";
import { createGitHubChannel } from "../_shared/github-channel.ts";
import {
  decodeBody,
  errorResponse,
  jsonResponse,
  normalizeHeaders,
} from "../_shared/http.ts";
import { logError } from "../_shared/log.ts";
import type { LambdaResponse } from "../_shared/runtime.ts";
import { createSlackChannel } from "../_shared/slack-channel.ts";
import { createTelegramChannel } from "../_shared/telegram-channel.ts";
import type { WebhookConfig } from "../_shared/webhook.ts";
import type { ConversationIngressEvent } from "./session.ts";

const DIRECT_API_EVENT_ID_PREFIX = "api:";
const DIRECT_API_CONVERSATION_PREFIX = "api:";
const ACCOUNT_NAMESPACE_PREFIX = "acct:";
const RESERVED_EVENT_ID_PREFIXES = [
  INTERNAL_EVENT_ID_PREFIX,
  ACCOUNT_NAMESPACE_PREFIX,
  DIRECT_API_EVENT_ID_PREFIX,
  "gh:",
  "slack:",
  "slack-command:",
  "discord:",
  "tg-",
] as const;
const RESERVED_CONVERSATION_PREFIXES = [
  INTERNAL_EVENT_ID_PREFIX,
  ACCOUNT_NAMESPACE_PREFIX,
  DIRECT_API_CONVERSATION_PREFIX,
  "gh:",
  "slack:",
  "tg:",
  "discord:",
] as const;

type DirectIngressEvent =
  | UserModelMessage
  | (SystemModelMessage & { persist: false });

export interface DirectInboundEvent {
  accountId: string;
  accountConfig: AccountConfig;
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
  accountId: string;
  eventId: string;
  publicEventId: string;
}

export interface ChannelInboundEvent {
  accountId?: string;
  accountConfig?: AccountConfig;
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

export interface IntegrationRoutingOptions {
  authResolver?: (headers: Record<string, string>) => Promise<AuthContext | null>;
  accountLoader?: (accountId: string) => Promise<AccountRecord | null>;
}

export async function routeIncomingEvent(
  event: LambdaFunctionURLEvent,
  handlers: IntegrationHandlers,
): Promise<LambdaResponse> {
  return createIncomingEventRouter()(event, handlers);
}

export function createIncomingEventRouter(options: IntegrationRoutingOptions = {}) {
  const authResolver = options.authResolver ?? resolveBearerAuth;
  const accountLoader = options.accountLoader ?? getAccount;

  return async (
    event: LambdaFunctionURLEvent,
    handlers: IntegrationHandlers,
  ): Promise<LambdaResponse> => handleLambdaUrlEvent(event, handlers, {
    authResolver,
    accountLoader,
  });
}

interface LambdaUrlRoutingContext {
  authResolver(headers: Record<string, string>): Promise<AuthContext | null>;
  accountLoader(accountId: string): Promise<AccountRecord | null>;
}

async function handleLambdaUrlEvent(
  event: LambdaFunctionURLEvent,
  handlers: IntegrationHandlers,
  context: LambdaUrlRoutingContext,
): Promise<LambdaResponse> {
  const method = event.requestContext.http.method;
  const headers = normalizeHeaders(event.headers);

  if (method === "GET" && isStatusPath(event.rawPath)) {
    const auth = await context.authResolver(headers);
    const account = auth?.kind === "account" ? auth.account : null;
    if (!account) {
      return unauthorizedResponse();
    }

    try {
      if (!handlers.handleStatusRequest) {
        return notFoundResponse();
      }

      return handlers.handleStatusRequest(parseStatusPath(event.rawPath, account));
    } catch (err) {
      return badRequestResponse(err);
    }
  }

  if (method === "GET") {
    return jsonResponse(200, {
      status: "ok",
      method: "POST",
    });
  }

  if (method !== "POST") {
    return errorResponse(405, "Method not allowed", {
      method,
      allowedMethods: ["GET", "POST"],
    });
  }

  const request = {
    method,
    rawPath: event.rawPath,
    headers,
    body: decodeBody(event.body, event.isBase64Encoded),
  } satisfies ChannelRequest;

  const accountWebhookMatch = event.rawPath.match(/^\/webhooks\/([^/]+)\/([^/]+)$/);
  if (accountWebhookMatch?.[1] && accountWebhookMatch[2]) {
    const account = await context.accountLoader(decodeURIComponent(accountWebhookMatch[1]));
    if (!account || account.status !== "active") {
      return notFoundResponse();
    }

    const accountChannelRegistry = createChannelRegistry(account.config);
    const channelName = decodeURIComponent(accountWebhookMatch[2]);
    const accountChannel = accountChannelRegistry.webhookChannels.find((channel) =>
      channel.name === channelName && channel.canHandle(request)
    );
    if (!accountChannel) {
      const isConfigured = accountChannelRegistry.webhookChannels.some((channel) => channel.name === channelName);
      return integrationNotConfigured(isConfigured ? `Webhook ${channelName}` : channelName);
    }

    return handleChannelWebhook(accountChannel, request, handlers, account);
  }

  const auth = await context.authResolver(request.headers);
  const account = auth?.kind === "account" ? auth.account : null;
  if (!account) {
    return unauthorizedResponse();
  }

  try {
    const parsed = parseDirectPayload(request.body, request.headers, account);
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
  account?: AccountRecord,
): Promise<LambdaResponse> {
  try {
    if (!(await adapter.authenticate(request))) {
      return unauthorizedResponse();
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
          eventId: account ? accountScopedKey(account.accountId, message.eventId) : message.eventId,
          conversationKey: account ? accountScopedKey(account.accountId, message.conversationKey) : message.conversationKey,
          content: message.content,
          events: [{ role: "user", content: message.content }],
          channelName: message.channelName,
          source: message.source,
          channel,
          ...(account
            ? {
              accountId: account.accountId,
              accountConfig: toRuntimeAccountConfig(account.config),
            }
            : {}),
        },
        handlers,
      ),
    };
  } catch (err) {
    logError("Failed to process webhook request", {
      channel: adapter.name,
      error: err instanceof Error ? err.message : String(err),
    });

    return errorResponse(500, "Internal server error");
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

function integrationNotConfigured(name: string): LambdaResponse {
  return errorResponse(503, `${name} integration is not configured`);
}

function createChannelRegistry(config: AccountConfig): ChannelRegistry {
  const telegramChannel = createTelegramChannelFromConfig(config);
  const githubChannel = createGitHubChannelFromConfig(config);
  const slackChannel = createSlackChannelFromConfig(config);
  const discordChannel = createDiscordChannelFromConfig(config);

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

function parseDirectPayload(
  bodyText: string,
  headers: Record<string, string>,
  account: AccountRecord,
): DirectInboundEvent {
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
    accountId: account.accountId,
    accountConfig: toRuntimeAccountConfig(account.config),
    eventId: accountScopedKey(account.accountId, `${DIRECT_API_EVENT_ID_PREFIX}${rawEventId}`),
    publicEventId: rawEventId,
    conversationKey: accountScopedKey(account.accountId, `${DIRECT_API_CONVERSATION_PREFIX}${rawConversationKey}`),
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

function parseStatusPath(rawPath: string, account: AccountRecord): StatusInboundEvent {
  const match = rawPath.match(/^\/status\/([^/]+)$/);
  const rawEventId = match?.[1] ? decodeURIComponent(match[1]) : "";
  const publicEventId = normalizeDirectIdentifier("eventId", rawEventId);
  if (hasReservedEventIdPrefix(publicEventId)) {
    throw new Error("eventId uses a reserved internal prefix");
  }

  return {
    accountId: account.accountId,
    eventId: accountScopedKey(account.accountId, `${DIRECT_API_EVENT_ID_PREFIX}${publicEventId}`),
    publicEventId,
  };
}

function unauthorizedResponse(): LambdaResponse {
  return errorResponse(401, "Unauthorized");
}

function badRequestResponse(err: unknown): LambdaResponse {
  return errorResponse(400, err instanceof Error ? err.message : "Invalid request");
}

function notFoundResponse(): LambdaResponse {
  return errorResponse(404, "Not found");
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

function createTelegramChannelFromConfig(config: AccountConfig): ChannelAdapter | null {
  const channel = config.channels?.telegram;
  if (!channel?.botToken || !channel.webhookSecret || !channel.allowedChatIds) {
    return null;
  }

  return createTelegramChannel(
    channel.botToken,
    channel.webhookSecret,
    new Set(channel.allowedChatIds),
    channel.reactionEmoji ?? "👀",
  );
}

function createGitHubChannelFromConfig(config: AccountConfig): ChannelAdapter | null {
  const channel = config.channels?.github;
  if (!channel?.webhookSecret || !channel.appId || !channel.privateKey) {
    return null;
  }

  return createGitHubChannel(
    channel.webhookSecret,
    channel.appId,
    channel.privateKey,
    channel.allowedRepos ? new Set(channel.allowedRepos) : null,
  );
}

function createSlackChannelFromConfig(config: AccountConfig): ChannelAdapter | null {
  const channel = config.channels?.slack;
  if (!channel?.botToken || !channel.signingSecret) {
    return null;
  }

  return createSlackChannel(
    channel.botToken,
    channel.signingSecret,
    channel.allowedChannelIds ? new Set(channel.allowedChannelIds) : null,
  );
}

function createDiscordChannelFromConfig(config: AccountConfig): ChannelAdapter | null {
  const channel = config.channels?.discord;
  if (!channel?.botToken || !channel.publicKey) {
    return null;
  }

  return createDiscordChannel(
    channel.botToken,
    channel.publicKey,
    channel.allowedGuildIds ? new Set(channel.allowedGuildIds) : null,
  );
}

function accountScopedKey(accountId: string, key: string): string {
  return `${ACCOUNT_NAMESPACE_PREFIX}${accountId}:${key}`;
}
