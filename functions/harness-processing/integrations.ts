/**
 * HTTP ingress and channel routing for harness-processing.
 * Keep request normalization, account/agent lookup, provider ACKs, and normalized channel events here.
 */

import type {
  SystemModelMessage,
  ToolModelMessage,
  UserContent,
  UserModelMessage,
} from "ai";
import {
  systemModelMessageSchema,
  toolModelMessageSchema,
  userModelMessageSchema,
} from "ai";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { resolveBearerAuth, type AuthContext } from "../_shared/auth.ts";
import {
  getStorage,
  toChannelRuntimeAgentConfig,
  toRuntimeAgentConfig,
  type AccountRecord,
  type AgentConfig,
  type AgentRecord,
} from "../_shared/storage/index.ts";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelRequest,
  ChannelResponse,
  InboundMessage,
} from "../_shared/channels.ts";
import { extractText, formatChannelErrorText } from "../_shared/channels.ts";
import { parseCommand } from "../_shared/commands.ts";
import { createDiscordChannel } from "../_shared/discord-channel.ts";
import { createGitHubChannel } from "../_shared/github-channel.ts";
import {
  decodeBody,
  errorResponse,
  jsonResponse,
  normalizeHeaders,
} from "../_shared/http.ts";
import { logError, logInfo, logWarn } from "../_shared/log.ts";
import { createPancakeChannel } from "../_shared/pancake-channel.ts";
import type { LambdaResponse } from "../_shared/runtime.ts";
import { createSlackChannel } from "../_shared/slack-channel.ts";
import { createTelegramChannel } from "../_shared/telegram-channel.ts";
import { createZaloChannel } from "../_shared/zalo-channel.ts";
import {
  assertValidPublicConversationKey,
  assertValidPublicEventId,
  accountAgentScopedKey,
  normalizeDirectIdentifier,
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../_shared/runtime-keys.ts";
import type { ConversationIngressEvent } from "./session.ts";

type DirectIngressEvent =
  | UserModelMessage
  | ToolModelMessage
  | (SystemModelMessage & { persist: false });

export interface DirectInboundEvent {
  accountId: string;
  agentId: string;
  agentConfig: AgentConfig;
  eventId: string;
  asyncResultEventId?: string;
  publicEventId: string;
  conversationKey: string;
  publicConversationKey: string;
  events: DirectIngressEvent[];
  connectionId?: string;
  // Set on a continuation that should also push its final text to a chat
  // channel (a background job launched from Telegram/Slack/etc.). The worker
  // rebuilds the sender from the agent config via sendChannelReply.
  replyTarget?: { channelName: string; source: Record<string, unknown> };
}

export interface AsyncDirectInboundEvent extends DirectInboundEvent {
  statusUrl: string;
}

export interface StatusInboundEvent {
  accountId: string;
  agentId: string;
  eventId: string;
  publicEventId: string;
}

export interface AsyncToolCompletionInboundEvent {
  accountId: string;
  resultId: string;
  status: "completed" | "failed";
  response?: unknown;
  error?: string;
}

// Background-job completion posted by the detached job itself. Authenticated by
// the per-job token (matched against the stored row), so no account secret rides
// inside the sandbox.
export interface SandboxJobCompletionInboundEvent {
  resultId: string;
  token: string;
  status: "completed" | "failed";
  response?: unknown;
  error?: string;
}

export interface ChannelInboundEvent {
  accountId?: string;
  agentId?: string;
  agentConfig?: AgentConfig;
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
  handleAsyncToolCompletionRequest?(event: AsyncToolCompletionInboundEvent): Promise<LambdaResponse>;
  handleSandboxJobCompletionRequest?(event: SandboxJobCompletionInboundEvent): Promise<LambdaResponse>;
  handleChannelRequest(event: ChannelInboundEvent): Promise<void>;
}

export interface ChannelRegistry {
  webhookChannels: ChannelAdapter[];
}

export interface IntegrationRoutingOptions {
  authResolver?: (headers: Record<string, string>) => Promise<AuthContext | null>;
  accountLoader?: (accountId: string) => Promise<AccountRecord | null>;
  agentLoader?: (accountId: string, agentId: string) => Promise<AgentRecord | null>;
  directApiEnabled?: boolean;
}

export async function routeIncomingEvent(
  event: LambdaFunctionURLEvent,
  handlers: IntegrationHandlers,
  options: IntegrationRoutingOptions = {},
): Promise<LambdaResponse> {
  return createIncomingEventRouter(options)(event, handlers);
}

export function createIncomingEventRouter(options: IntegrationRoutingOptions = {}) {
  const authResolver = options.authResolver ?? resolveBearerAuth;
  const accountLoader = options.accountLoader ?? ((accountId: string) => getStorage().accounts.getById(accountId));
  const agentLoader = options.agentLoader ?? ((accountId: string, agentId: string) => getStorage().agents.getById(accountId, agentId));
  const directApiEnabled = options.directApiEnabled ?? true;

  return async (
    event: LambdaFunctionURLEvent,
    handlers: IntegrationHandlers,
  ): Promise<LambdaResponse> => handleLambdaUrlEvent(event, handlers, {
    authResolver,
    accountLoader,
    agentLoader,
    directApiEnabled,
  });
}

interface LambdaUrlRoutingContext {
  authResolver(headers: Record<string, string>): Promise<AuthContext | null>;
  accountLoader(accountId: string): Promise<AccountRecord | null>;
  agentLoader(accountId: string, agentId: string): Promise<AgentRecord | null>;
  directApiEnabled: boolean;
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

      return handlers.handleStatusRequest(parseStatusPath(event.rawPath, event.rawQueryString, account));
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

  // Check for the tool async results return
  const asyncToolCompletionMatch = event.rawPath.match(/^\/async-tools\/([^/]+)\/complete$/);
  if (asyncToolCompletionMatch?.[1]) {
    const auth = await context.authResolver(request.headers);
    const account = auth?.kind === "account" ? auth.account : null;
    if (!account) {
      return unauthorizedResponse();
    }
    if (!handlers.handleAsyncToolCompletionRequest) {
      return notFoundResponse();
    }

    try {
      return handlers.handleAsyncToolCompletionRequest(parseAsyncToolCompletionPayload(
        asyncToolCompletionMatch[1],
        request.body,
        account,
      ));
    } catch (err) {
      return badRequestResponse(err);
    }
  }

  // Background-job completion: authenticated by the per-job token, not an account
  // secret, so the sandbox never needs to hold account credentials.
  const sandboxJobCompletionMatch = event.rawPath.match(/^\/sandbox-jobs\/([^/]+)\/complete$/);
  if (sandboxJobCompletionMatch?.[1]) {
    if (!handlers.handleSandboxJobCompletionRequest) {
      return notFoundResponse();
    }
    try {
      return handlers.handleSandboxJobCompletionRequest(parseSandboxJobCompletionPayload(
        sandboxJobCompletionMatch[1],
        request.headers,
        request.body,
      ));
    } catch (err) {
      return badRequestResponse(err);
    }
  }

  // Check for the webhook channel integration
  const accountWebhookMatch = event.rawPath.match(/^\/webhooks\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (accountWebhookMatch?.[1] && accountWebhookMatch[2] && accountWebhookMatch[3]) {
    const accountId = decodeURIComponent(accountWebhookMatch[1]);
    const agentId = decodeURIComponent(accountWebhookMatch[2]);
    const channelName = decodeURIComponent(accountWebhookMatch[3]);
    logInfo("Webhook request matched account route", {
      accountId,
      agentId,
      channel: channelName,
      method: request.method,
      rawPath: event.rawPath,
    });

    let account: AccountRecord | null;
    try {
      account = await context.accountLoader(accountId);
    } catch (err) {
      logError("Webhook account load failed", {
        accountId,
        agentId,
        channel: channelName,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    if (!account || account.status !== "active") {
      logWarn("Webhook account not found or inactive", {
        accountId,
        agentId,
        channel: channelName,
      });
      return notFoundResponse();
    }
    let agent: AgentRecord | null;
    try {
      agent = await context.agentLoader(account.accountId, agentId);
    } catch (err) {
      logError("Webhook agent load failed", {
        accountId: account.accountId,
        agentId,
        channel: channelName,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    if (!agent || agent.status !== "active") {
      logWarn("Webhook agent not found or inactive", {
        accountId: account.accountId,
        agentId,
        channel: channelName,
      });
      return notFoundResponse();
    }

    const accountChannelRegistry = createChannelRegistry(agent.config, {
      accountId: account.accountId,
      agentId,
    });
    const accountChannel = accountChannelRegistry.webhookChannels.find((channel) =>
      channel.name === channelName && channel.canHandle(request)
    );

    logInfo("Webhook received", {
      accountId: account.accountId,
      agentId,
      channel: channelName,
      method: request.method,
      rawPath: event.rawPath,
      channelConfigured: accountChannelRegistry.webhookChannels.some((channel) => channel.name === channelName),
      channelMatched: !!accountChannel,
    });

    if (!accountChannel) {
      const isConfigured = accountChannelRegistry.webhookChannels.some((channel) => channel.name === channelName);
      return integrationNotConfigured(isConfigured ? `Webhook ${channelName}` : channelName);
    }

    return handleChannelWebhook(accountChannel, request, handlers, account, agent);
  }

  if (!context.directApiEnabled && (event.rawPath === "/" || isAsyncPath(event.rawPath))) {
    return directApiDisabledResponse();
  }

  const auth = await context.authResolver(request.headers);
  const account = auth?.kind === "account" ? auth.account : null;
  if (!account) {
    return unauthorizedResponse();
  }

  try {
    const parsed = await parseDirectPayload(request.body, request.headers, account, context.agentLoader);
    if (isAsyncPath(event.rawPath)) {
      if (!handlers.handleAsyncRequest) {
        return notFoundResponse();
      }

      return handlers.handleAsyncRequest({
        ...parsed,
        statusUrl: buildStatusUrl(event, parsed.publicEventId, parsed.agentId),
      });
    }

    return handlers.handleDirectRequest(parsed);
  } catch (err) {
    return badRequestResponse(err);
  }
}

/**
 * This is to handle the response to the external integration webhook
 */
async function handleChannelWebhook(
  adapter: ChannelAdapter,
  request: ChannelRequest,
  handlers: IntegrationHandlers,
  account: AccountRecord,
  agent: AgentRecord,
): Promise<LambdaResponse> {
  try {
    logInfo("Channel webhook received", {
      channel: adapter.name,
      accountId: account.accountId,
      agentId: agent.agentId,
      method: request.method,
    });

    if (!(await adapter.authenticate(request))) {
      logWarn("Channel webhook authentication failed", {
        channel: adapter.name,
        accountId: account.accountId,
        agentId: agent.agentId,
      });
      return unauthorizedResponse();
    }

    // Parse event and check if it should be ignored
    // This is based on the channel integration
    const parsed = await adapter.parse(request);
    logInfo("Channel webhook parsed", {
      channel: adapter.name,
      accountId: account.accountId,
      agentId: agent.agentId,
      kind: parsed.kind,
      ...(parsed.kind === "message"
        ? {
          eventId: parsed.message.eventId,
          conversationKey: parsed.message.conversationKey,
          source: parsed.message.source,
        }
        : {}),
    });

    // Global event check for webhook event.
    // Provider needs a direct HTTP response, but no agent run. 
    // Example: Slack URL verification or Discord interaction response.
    if (parsed.kind === "response") {
      logInfo("Channel webhook responded without agent run", {
        channel: adapter.name,
        accountId: account.accountId,
        agentId: agent.agentId,
        statusCode: parsed.response.statusCode,
      });
      return toLambdaResponse(parsed.response);
    }

    // Webhook is valid enough to accept, but should not run the agent. 
    // Example: unsupported Pancake event, wrong page ID, hidden/removed message, page-originated message,
    // or a configured channel handoff gate.
    if (parsed.kind === "ignore") {
      logInfo("Channel webhook ignored", {
        channel: adapter.name,
        accountId: account.accountId,
        agentId: agent.agentId,
        statusCode: parsed.response?.statusCode ?? 200,
      });
      return toLambdaResponse(parsed.response ?? { statusCode: 200 });
    }

    // Else webhook contains a real user message.
    // Send the webhook ACK immediately then use afterResponse to conitnue into normal channle processing
    const { message, ack } = parsed;
    const channel = adapter.actions(message);
    const response = ack ?? { statusCode: 200 };
    logInfo("Channel webhook accepted for async processing", {
      channel: adapter.name,
      accountId: account.accountId,
      agentId: agent.agentId,
      eventId: message.eventId,
      conversationKey: message.conversationKey,
      statusCode: response.statusCode,
    });

    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body ?? "",
      afterResponse: processChannelMessage(
        {
          eventId: accountAgentScopedKey(account.accountId, agent.agentId, message.eventId),
          conversationKey: accountAgentScopedKey(account.accountId, agent.agentId, message.conversationKey),
          content: message.content,
          events: [{ role: "user", content: message.content }],
          channelName: message.channelName,
          source: message.source,
          channel: channel,
          accountId: account.accountId,
          agentId: agent.agentId,
          agentConfig: toChannelRuntimeAgentConfig(agent.config, message.channelName),
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
    logInfo("Channel message processing started", {
      channel: event.channelName,
      accountId: event.accountId,
      agentId: event.agentId,
      eventId: event.eventId,
      conversationKey: event.conversationKey,
      source: event.source,
    });

    event.channel.sendTyping().catch(() => { });
    event.channel.reactToMessage().catch(() => { });

    await handlers.handleChannelRequest({
      ...event,
      commandToken: resolveCommandToken(event.content, event.source) ?? undefined,
    });
    logInfo("Channel message processing completed", {
      channel: event.channelName,
      accountId: event.accountId,
      agentId: event.agentId,
      eventId: event.eventId,
      conversationKey: event.conversationKey,
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

function directApiDisabledResponse(): LambdaResponse {
  return errorResponse(404, "Direct API is disabled");
}

function createChannelRegistry(
  config: AgentConfig,
  scope: { accountId: string; agentId: string },
): ChannelRegistry {
  const telegramChannel = createTelegramChannelFromConfig(config);
  const githubChannel = createGitHubChannelFromConfig(config);
  const slackChannel = createSlackChannelFromConfig(config);
  const discordChannel = createDiscordChannelFromConfig(config);
  const pancakeChannel = createPancakeChannelFromConfig(config, scope);
  const zaloChannel = createZaloChannelFromConfig(config);

  return {
    webhookChannels: [
      telegramChannel,
      githubChannel,
      slackChannel,
      discordChannel,
      pancakeChannel,
      zaloChannel,
    ].filter((channel): channel is ChannelAdapter => channel !== null),
  };
}

/**
 * Push a single message into a chat channel outside the inbound webhook — used
 * to deliver a background job's result back to the conversation it came from.
 * Rebuilds the channel sender from the agent's encrypted config + the stored
 * routing `source`, reusing the same adapter the webhook path uses. Each channel
 * decides how to deliver a delayed message inside its own module (e.g. Discord
 * falls back to a bot-token channel post once its interaction token expires).
 */
export async function sendChannelReply(options: {
  config: AgentConfig;
  accountId: string;
  agentId: string;
  channelName: string;
  source: Record<string, unknown>;
  text: string;
}): Promise<void> {
  const registry = createChannelRegistry(options.config, {
    accountId: options.accountId,
    agentId: options.agentId,
  });
  const adapter = registry.webhookChannels.find((channel) => channel.name === options.channelName);
  if (!adapter) {
    throw new Error(`Channel ${options.channelName} is not configured for this agent`);
  }

  const message: InboundMessage = {
    eventId: "",
    conversationKey: "",
    channelName: options.channelName,
    content: options.text,
    source: options.source,
  };
  await adapter.actions(message).sendText(options.text);
}

async function parseDirectPayload(
  bodyText: string,
  headers: Record<string, string>,
  account: AccountRecord,
  agentLoader: (accountId: string, agentId: string) => Promise<AgentRecord | null>,
): Promise<DirectInboundEvent> {
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
  if (typeof record.agentId !== "string" || record.agentId.trim().length === 0) {
    throw new Error("Request body must include agentId");
  }
  const agentId = normalizeDirectIdentifier("agentId", record.agentId);
  const agent = await agentLoader(account.accountId, agentId);
  if (!agent || agent.status !== "active") {
    throw new DirectNotFoundError("Agent not found");
  }

  const rawEventId = assertValidPublicEventId(record.eventId as string);
  const rawConversationKey = assertValidPublicConversationKey(record.conversationKey as string);

  const events = parseDirectIngressEvents(record);
  if (events.length === 0) {
    throw new Error("Request body must include a non-empty events array");
  }
  if (record.webhookUrl !== undefined || headers["x-webhook-secret"] !== undefined) {
    throw new Error("Per-request webhook callbacks are no longer supported; configure config.hooks.webhook on the agent");
  }

  return {
    accountId: account.accountId,
    agentId: agent.agentId,
    agentConfig: toRuntimeAgentConfig(agent.config),
    eventId: scopedDirectEventId(account.accountId, agent.agentId, rawEventId),
    publicEventId: rawEventId,
    conversationKey: scopedDirectConversationKey(account.accountId, agent.agentId, rawConversationKey),
    publicConversationKey: rawConversationKey,
    events,
  };
}

function parseStatusPath(rawPath: string, rawQueryString: string, account: AccountRecord): StatusInboundEvent {
  const match = rawPath.match(/^\/status\/([^/]+)$/);
  const rawEventId = match?.[1] ? decodeURIComponent(match[1]) : "";
  const publicEventId = assertValidPublicEventId(rawEventId);

  const params = new URLSearchParams(rawQueryString);
  const rawAgentId = params.get("agentId");
  if (!rawAgentId) {
    throw new Error("agentId query parameter is required");
  }
  const agentId = normalizeDirectIdentifier("agentId", rawAgentId);

  return {
    accountId: account.accountId,
    agentId,
    eventId: scopedDirectEventId(account.accountId, agentId, publicEventId),
    publicEventId,
  };
}

function parseAsyncToolCompletionPayload(
  rawResultId: string,
  bodyText: string,
  account: AccountRecord,
): AsyncToolCompletionInboundEvent {
  let parsed: unknown;

  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    throw new Error(`Invalid request JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Async tool completion body must be an object");
  }

  const record = parsed as Record<string, unknown>;
  if (record.status !== "completed" && record.status !== "failed") {
    throw new Error("Async tool completion status must be completed or failed");
  }

  if (record.status === "failed" && typeof record.error !== "string") {
    throw new Error("Async tool completion error must be a string when status is failed");
  }

  return {
    accountId: account.accountId,
    resultId: decodeURIComponent(rawResultId),
    status: record.status,
    ...(record.response !== undefined ? { response: record.response } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}

function parseSandboxJobCompletionPayload(
  rawResultId: string,
  headers: Record<string, string>,
  bodyText: string,
): SandboxJobCompletionInboundEvent {
  const token = headers["x-job-token"]?.trim();
  if (!token) {
    throw new Error("Background job completion requires the x-job-token header");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    throw new Error(`Invalid request JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Background job completion body must be an object");
  }

  const record = parsed as Record<string, unknown>;
  if (record.status !== "completed" && record.status !== "failed") {
    throw new Error("Background job completion status must be completed or failed");
  }

  return {
    resultId: decodeURIComponent(rawResultId),
    token,
    status: record.status,
    ...(record.response !== undefined ? { response: record.response } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}

function unauthorizedResponse(): LambdaResponse {
  return errorResponse(401, "Unauthorized");
}

function badRequestResponse(err: unknown): LambdaResponse {
  if (err instanceof DirectNotFoundError) {
    return errorResponse(404, err.message);
  }
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

function buildStatusUrl(event: LambdaFunctionURLEvent, publicEventId: string, agentId: string): string {
  const headers = normalizeHeaders(event.headers);
  const protocol = headers["x-forwarded-proto"] ?? "https";
  const host = headers.host;
  if (!host) {
    throw new Error("Request is missing Host header");
  }

  return `${protocol}://${host}/status/${encodeURIComponent(publicEventId)}?agentId=${encodeURIComponent(agentId)}`;
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

  if (candidate.role === "tool") {
    const parsedTool = toolModelMessageSchema.safeParse(candidate);
    if (!parsedTool.success) {
      throw new Error(`Invalid direct event: ${parsedTool.error.issues[0]?.message ?? "must match ToolModelMessage"}`);
    }
    if (
      parsedTool.data.content.length === 0 ||
      !parsedTool.data.content.every((part) => part.type === "tool-approval-response")
    ) {
      throw new Error("Direct API tool events may include only tool-approval-response parts");
    }

    return parsedTool.data;
  }

  if (candidate.role !== "system") {
    throw new Error("Direct API accepts only user, tool approval, and ephemeral system events");
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

class DirectNotFoundError extends Error { }

function createTelegramChannelFromConfig(config: AgentConfig): ChannelAdapter | null {
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

function createGitHubChannelFromConfig(config: AgentConfig): ChannelAdapter | null {
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

function createSlackChannelFromConfig(config: AgentConfig): ChannelAdapter | null {
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

function createDiscordChannelFromConfig(config: AgentConfig): ChannelAdapter | null {
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

function createPancakeChannelFromConfig(
  config: AgentConfig,
  scope: { accountId: string; agentId: string },
): ChannelAdapter | null {
  const channel = config.channels?.pancake;
  if (!channel?.pageId || !channel.pageAccessToken) {
    return null;
  }

  return createPancakeChannel(
    channel.pageId,
    channel.pageAccessToken,
    channel.senderId,
    {
      accountId: scope.accountId,
      agentId: scope.agentId,
      configOptions: channel.options,
    },
  );
}

function createZaloChannelFromConfig(config: AgentConfig): ChannelAdapter | null {
  const channel = config.channels?.zalo;
  if (!channel?.botToken || !channel.webhookSecret || !channel.allowedUserIds) {
    return null;
  }

  return createZaloChannel(
    channel.botToken,
    channel.webhookSecret,
    new Set(channel.allowedUserIds),
  );
}
