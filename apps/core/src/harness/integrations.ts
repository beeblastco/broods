/**
 * HTTP ingress and channel routing for harness-processing.
 * Keep request normalization, account/agent lookup, provider ACKs, and normalized channel events here.
 */

import { context as otelContextApi } from "@opentelemetry/api";
import type {
  JSONValue,
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
import { resolveBearerAuth, type AuthContext } from "../shared/auth.ts";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelIdentity,
  ChannelRequest,
  ChannelResponse,
  InboundMessage,
} from "../shared/channels.ts";
import { extractText, formatChannelErrorText } from "../shared/channels.ts";
import { parseCommand } from "../shared/commands.ts";
import { createDiscordChannel } from "../shared/discord-channel.ts";
import type { AccountRecord } from "../shared/domain/accounts.ts";
import {
  applyRunOverrides,
  MODEL_CONFIG_SETTING_KEYS,
  RUN_OVERRIDE_RESERVED_MODEL_KEYS,
  toChannelRuntimeAgentConfig,
  toRuntimeAgentConfig,
  type AgentChannelWorkspaceScope,
  type AgentConfig,
  type RunOverrides,
} from "../shared/domain/agent-config.ts";
import type { AgentRecord } from "../shared/domain/agents.ts";
import {
  applyChannelRecord,
  channelActorRoles,
  channelRecordMatchesWorkspace,
  resolveChannelAgentId,
  type ChannelRecord,
} from "../shared/domain/channel-record.ts";
import { getHarnessPublicUrl } from "../shared/env.ts";
import { createGitHubChannel } from "../shared/github-channel.ts";
import {
  errorResponse,
  jsonResponse,
  type CoreRequest,
} from "../shared/http.ts";
import {
  collectSecretValues,
  logError,
  logInfo,
  logWarn,
} from "../shared/log.ts";
import { isPlainObject } from "../shared/object.ts";
import {
  getObservabilityContext,
  mintTraceId,
  setObservabilityContext,
} from "../shared/otel.ts";
import { createPancakeChannel } from "../shared/pancake-channel.ts";
import {
  accountAgentScopedKey,
  assertValidPublicConversationKey,
  assertValidPublicEventId,
  assertValidPublicStatusEventId,
  channelScopeKeyFromConversation,
  normalizeDirectIdentifier,
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../shared/runtime-keys.ts";
import { deleteS3Prefix } from "../shared/s3.ts";
import { releaseReservedSandboxes } from "../shared/sandbox-cleanup.ts";
import { createSlackChannel } from "../shared/slack-channel.ts";
import type { AgentDeploymentScope } from "../shared/storage.ts";
import { getStorage } from "../shared/storage.ts";
import { createTelegramChannel } from "../shared/telegram-channel.ts";
import {
  isolatedWorkspaceNamespace,
  workspaceNamespace,
} from "../shared/workspaces.ts";
import { createZaloChannel } from "../shared/zalo-channel.ts";
import {
  applyMessageSendingHook,
  createAgentHookDispatcher,
} from "./hook-dispatcher.ts";
import { statusAccessDenial } from "./status-access.ts";
import {
  getAsyncAgentResult,
  type AsyncAgentResultRecord,
} from "./async-agent-result.ts";
import {
  getIngressStatus,
  type IngressMode,
  type IngressStatusRecord,
  type PublicDeploymentIngress,
} from "./ingress.ts";
import { toLifecycleValue } from "./lifecycle.ts";
import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "./sandbox/s3-mount.ts";
import { channelPolicyIdentity, evaluateChannelInvoke } from "./policy.ts";
import type { ConversationIngressEvent } from "./session.ts";

type DirectIngressEvent =
  | UserModelMessage
  | ToolModelMessage
  | (SystemModelMessage & { persist: false });

type PublicEndpointPath = {
  endpointId: string;
  projectSlug?: string;
  stageSlug?: string;
  mode: "sync" | "async";
};

export interface DirectInboundEvent {
  accountId: string;
  agentId: string;
  agentConfig: AgentConfig;
  // Per-deployment id from the runtime key, when the request authenticated with a
  // deployment key. Scopes realtime telemetry to the dashboard's deployment view.
  endpointId?: string;
  // Project and stage slugs from the runtime key scope, forwarded to the
  // harness so it can build NATS observability subjects for live streaming.
  projectSlug?: string;
  stageSlug?: string;
  // Dedicated server-derived proof that this ingress entered through a public
  // deployment route. Generic deployment fields also exist on channel/cron work.
  publicDeploymentIngress?: PublicDeploymentIngress;
  eventId: string;
  asyncResultEventId?: string;
  publicEventId: string;
  conversationKey: string;
  publicConversationKey: string;
  events: DirectIngressEvent[];
  requestedMode: IngressMode;
  idempotencyKey: string;
  // Server-issued fencing token added only after durable admission.
  ownerGeneration?: number;
  connectionId?: string;
  // One-turn system events from the direct request. Model overrides are already folded into agentConfig.
  ephemeralSystem?: SystemModelMessage[];
  // Set on a continuation that should also push its final text to a chat
  // channel (a background job launched from Telegram/Slack/etc.). The worker
  // rebuilds the sender from the agent config via sendChannelReply.
  replyTarget?: { channelName: string; source: Record<string, unknown> };
  cronRun?: { cronId: string; runId: string };
}

/** The scope a queued envelope needs to be rebuilt into its own run. */
export type IngressDispatchScope = Pick<
  DirectInboundEvent,
  | "accountId"
  | "agentId"
  | "agentConfig"
  | "conversationKey"
  | "publicConversationKey"
  | "endpointId"
  | "projectSlug"
  | "stageSlug"
>;

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
  response?: JSONValue;
  error?: string;
}

// Background-job completion posted by the detached job itself. Authenticated by
// the per-job token (matched against the stored row), so no account secret rides
// inside the sandbox.
export interface SandboxJobCompletionInboundEvent {
  resultId: string;
  token: string;
  status: "completed" | "failed";
  response?: JSONValue;
  error?: string;
}

export interface ChannelInboundEvent {
  accountId?: string;
  agentId?: string;
  agentConfig?: AgentConfig;
  endpointId?: string;
  projectSlug?: string;
  stageSlug?: string;
  eventId: string;
  conversationKey: string;
  content: UserContent;
  events: ConversationIngressEvent[];
  channelName: string;
  identity?: ChannelIdentity;
  source: Record<string, unknown>;
  channel: ChannelActions;
  channelFactory?: (source: Record<string, unknown>) => ChannelActions;
  commandToken?: string;
}

export interface ChannelContextEvent {
  accountId?: string;
  agentId?: string;
  agentConfig?: AgentConfig;
  endpointId?: string;
  projectSlug?: string;
  stageSlug?: string;
  eventId: string;
  conversationKey: string;
  content: UserContent;
  events: ConversationIngressEvent[];
  channelName: string;
  identity?: ChannelIdentity;
  source: Record<string, unknown>;
}

interface IntegrationHandlers {
  handleDirectRequest(event: DirectInboundEvent): Promise<Response>;
  handleAsyncRequest?(event: AsyncDirectInboundEvent): Promise<Response>;
  handleStatusRequest?(event: StatusInboundEvent): Promise<Response>;
  handleAsyncToolCompletionRequest?(
    event: AsyncToolCompletionInboundEvent,
  ): Promise<Response>;
  handleSandboxJobCompletionRequest?(
    event: SandboxJobCompletionInboundEvent,
  ): Promise<Response>;
  handleChannelRequest(event: ChannelInboundEvent): Promise<void>;
  handleChannelContext?(event: ChannelContextEvent): Promise<void>;
}

export interface ChannelRegistry {
  webhookChannels: ChannelAdapter[];
}

export interface IntegrationRoutingOptions {
  authResolver?: (
    headers: Record<string, string>,
  ) => Promise<AuthContext | null>;
  accountLoader?: (accountId: string) => Promise<AccountRecord | null>;
  agentLoader?: (
    accountId: string,
    agentId: string,
  ) => Promise<AgentRecord | null>;
  agentLister?: (accountId: string) => Promise<AgentRecord[]>;
  stageAgentLister?: (
    accountId: string,
    endpointId: string,
  ) => Promise<AgentRecord[]>;
  channelRecordLoader?: (
    accountId: string,
    platform: string,
    externalId: string,
  ) => Promise<ChannelRecord | null>;
  deploymentLoader?: (
    accountId: string,
    agentId: string,
  ) => Promise<AgentDeploymentScope | null>;
  asyncAgentResultLoader?: (
    eventId: string,
  ) => Promise<AsyncAgentResultRecord | null>;
  ingressStatusLoader?: (options: {
    accountId: string;
    agentId: string;
    eventId: string;
  }) => Promise<IngressStatusRecord | null>;
  directApiEnabled?: boolean;
  /** Registers post-response background work (channel ack-then-process). */
  waitUntil?: (promise: Promise<unknown>) => void;
}

interface HttpRoutingContext {
  authResolver(headers: Record<string, string>): Promise<AuthContext | null>;
  accountLoader(accountId: string): Promise<AccountRecord | null>;
  agentLoader(accountId: string, agentId: string): Promise<AgentRecord | null>;
  agentLister(accountId: string): Promise<AgentRecord[]>;
  stageAgentLister(
    accountId: string,
    endpointId: string,
  ): Promise<AgentRecord[]>;
  channelRecordLoader(
    accountId: string,
    platform: string,
    externalId: string,
  ): Promise<ChannelRecord | null>;
  deploymentLoader(
    accountId: string,
    agentId: string,
  ): Promise<AgentDeploymentScope | null>;
  asyncAgentResultLoader(
    eventId: string,
  ): Promise<AsyncAgentResultRecord | null>;
  ingressStatusLoader(options: {
    accountId: string;
    agentId: string;
    eventId: string;
  }): Promise<IngressStatusRecord | null>;
  directApiEnabled: boolean;
  waitUntil(promise: Promise<unknown>): void;
}

// `endpointId` absent means the bare production URL, which scans the account.
interface WebhookRoute {
  accountId: string;
  channelName: string;
  endpointId?: string;
}

class DirectNotFoundError extends Error {}

class StatusUrlConfigError extends Error {}

export async function routeIncomingEvent(
  request: CoreRequest,
  handlers: IntegrationHandlers,
  options: IntegrationRoutingOptions = {},
): Promise<Response> {
  return createIncomingEventRouter(options)(request, handlers);
}

export function createIncomingEventRouter(
  options: IntegrationRoutingOptions = {},
) {
  const authResolver = options.authResolver ?? resolveBearerAuth;
  const accountLoader =
    options.accountLoader ??
    ((accountId: string) => getStorage().accounts.getById(accountId));
  const agentLoader =
    options.agentLoader ??
    ((accountId: string, agentId: string) =>
      getStorage().agents.getById(accountId, agentId));
  const agentLister =
    options.agentLister ??
    ((accountId: string) => getStorage().agents.list(accountId));
  const stageAgentLister =
    options.stageAgentLister ??
    ((accountId: string, endpointId: string) =>
      getStorage().agents.listForEndpoint(accountId, endpointId));
  const channelRecordLoader =
    options.channelRecordLoader ??
    ((accountId: string, platform: string, externalId: string) =>
      getStorage().channelRecords.getByExternalId(
        accountId,
        platform,
        externalId,
      ));
  const deploymentLoader =
    options.deploymentLoader ??
    ((accountId: string, agentId: string) =>
      getStorage().agentDeployments.getByAgentId?.(accountId, agentId) ??
      Promise.resolve(null));
  const asyncAgentResultLoader =
    options.asyncAgentResultLoader ?? getAsyncAgentResult;
  const ingressStatusLoader = options.ingressStatusLoader ?? getIngressStatus;
  const directApiEnabled = options.directApiEnabled ?? true;
  const waitUntil = options.waitUntil ?? (() => {});

  return async (
    request: CoreRequest,
    handlers: IntegrationHandlers,
  ): Promise<Response> =>
    handleHttpRequest(request, handlers, {
      authResolver: authResolver,
      accountLoader: accountLoader,
      agentLoader: agentLoader,
      agentLister: agentLister,
      stageAgentLister: stageAgentLister,
      channelRecordLoader: channelRecordLoader,
      deploymentLoader: deploymentLoader,
      asyncAgentResultLoader: asyncAgentResultLoader,
      ingressStatusLoader: ingressStatusLoader,
      directApiEnabled: directApiEnabled,
      waitUntil: waitUntil,
    });
}

async function handleHttpRequest(
  request: CoreRequest,
  handlers: IntegrationHandlers,
  context: HttpRoutingContext,
): Promise<Response> {
  const method = request.method;
  const headers = request.headers;

  if (method === "GET" && isStatusPath(request.path)) {
    const auth = await context.authResolver(headers);
    const account =
      auth?.kind === "account" || auth?.kind === "deployment"
        ? auth.account
        : null;
    if (!account) {
      return unauthorizedResponse();
    }

    try {
      if (!handlers.handleStatusRequest) {
        return notFoundResponse();
      }

      const parsed = parseStatusPath(request.path, request.search, account);
      if (auth?.kind === "deployment") {
        const denial = await statusAccessDenial(auth, parsed, context);
        if (denial) {
          return errorResponse(403, denial.message, {
            code: denial.code,
            agentId: parsed.agentId,
          });
        }
      }

      return handlers.handleStatusRequest(parsed);
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
      method: method,
      allowedMethods: ["GET", "POST"],
    });
  }

  const channelRequest = {
    method: method,
    rawPath: request.path,
    rawQueryString: request.search,
    headers: headers,
    body: request.body,
  } satisfies ChannelRequest;

  // Check for the tool async results return
  const asyncToolCompletionMatch = request.path.match(
    /^\/async-tools\/([^/]+)\/complete$/,
  );
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
      return handlers.handleAsyncToolCompletionRequest(
        parseAsyncToolCompletionPayload(
          asyncToolCompletionMatch[1],
          request.body,
          account,
        ),
      );
    } catch (err) {
      return badRequestResponse(err);
    }
  }

  // Background-job completion: authenticated by the per-job token, not an account
  // secret, so the sandbox never needs to hold account credentials.
  const sandboxJobCompletionMatch = request.path.match(
    /^\/sandbox-jobs\/([^/]+)\/complete$/,
  );
  if (sandboxJobCompletionMatch?.[1]) {
    if (!handlers.handleSandboxJobCompletionRequest) {
      return notFoundResponse();
    }
    try {
      return handlers.handleSandboxJobCompletionRequest(
        parseSandboxJobCompletionPayload(
          sandboxJobCompletionMatch[1],
          request.headers,
          request.body,
        ),
      );
    } catch (err) {
      return badRequestResponse(err);
    }
  }

  // Two webhook shapes, neither naming an agent: the bare one production keeps,
  // and a `/dev/{endpointId}/` one that pins delivery to a single stage.
  const webhookRoute = matchWebhookPath(request.path);
  // Answer a wrong webhook shape here rather than letting it fall through to
  // the generic 401, which reads as "bad credentials" to a provider that is
  // really just pointed at the retired /webhooks/{account}/{agent}/{channel}.
  if (!webhookRoute && request.path.startsWith("/webhooks/")) {
    logWarn("Webhook path does not match a known webhook shape", {
      method: request.method,
      rawPath: request.path,
    });

    return errorResponse(
      404,
      "Unknown webhook URL. Provider webhooks are /webhooks/{accountId}/{channel} for a production stage, or /webhooks/{accountId}/dev/{endpointId}/{channel} for any other stage — the agent is chosen by credentials and channel records, never named in the URL.",
      { code: "unknown_webhook_url" },
    );
  }
  if (webhookRoute) {
    const accountId = webhookRoute.accountId;
    const channelName = webhookRoute.channelName;
    const endpointId = webhookRoute.endpointId;
    const agentId = "(by channel)";
    logInfo("Webhook request matched account route", {
      accountId: accountId,
      agentId: agentId,
      channel: channelName,
      endpointId: endpointId ?? "(production)",
      method: request.method,
      rawPath: request.path,
    });

    let account: AccountRecord | null;
    try {
      account = await context.accountLoader(accountId);
    } catch (err) {
      logError("Webhook account load failed", {
        accountId: accountId,
        agentId: agentId,
        channel: channelName,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    if (!account || account.status !== "active") {
      logWarn("Webhook account not found or inactive", {
        accountId: accountId,
        agentId: agentId,
        channel: channelName,
      });

      return notFoundResponse();
    }
    // The credential holder owns the provider app the request came from:
    // whichever of the account's agents holds credentials that verify this
    // request. Its adapter parses the request and sends the reply, because the
    // reply must come from the app that received it; the channel record only
    // chooses who runs.
    let holder: ChannelCredentialHolder;
    try {
      holder = await findChannelCredentialHolder(
        context,
        account.accountId,
        channelName,
        channelRequest,
        endpointId,
      );
    } catch (err) {
      logError("Webhook agent load failed", {
        accountId: account.accountId,
        agentId: agentId,
        channel: channelName,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    // Without an agent in the URL these three cases would all collapse into one
    // 404, so keep them apart: nothing configures the channel, something does
    // but no credentials verified, or the scan itself failed.
    if (holder.kind === "unconfigured") {
      logWarn("Webhook channel not configured by any agent", {
        accountId: account.accountId,
        channel: channelName,
        channelConfigured: holder.configured,
      });

      // "configured" means an agent declares the channel but its adapter would
      // not take this request — a different message from nobody declaring it.
      return integrationNotConfigured(
        holder.configured ? `Webhook ${channelName}` : channelName,
      );
    }
    if (holder.kind === "unknown-stage") {
      logWarn("Webhook stage endpoint not found", {
        accountId: account.accountId,
        channel: channelName,
        endpointId: endpointId,
      });

      return errorResponse(
        404,
        `No stage of this account is deployed at ${endpointId}. Re-copy the webhook URL that broods printed for the stage.`,
        { code: "unknown_webhook_stage" },
      );
    }
    if (holder.kind === "unverified") {
      logWarn("Webhook credentials verified by no agent", {
        accountId: account.accountId,
        channel: channelName,
      });

      return unauthorizedResponse();
    }
    if (holder.kind === "unavailable") {
      return notFoundResponse();
    }
    const agent = holder.agent;

    const accountChannelRegistry = createChannelRegistry(agent.config);
    const accountChannel = accountChannelRegistry.webhookChannels.find(
      (channel) =>
        channel.name === channelName && channel.canHandle(channelRequest),
    );

    logInfo("Webhook received", {
      accountId: account.accountId,
      agentId: agentId,
      channel: channelName,
      method: request.method,
      rawPath: request.path,
      channelConfigured: accountChannelRegistry.webhookChannels.some(
        (channel) => channel.name === channelName,
      ),
      channelMatched: !!accountChannel,
    });

    if (!accountChannel) {
      const isConfigured = accountChannelRegistry.webhookChannels.some(
        (channel) => channel.name === channelName,
      );

      return integrationNotConfigured(
        isConfigured ? `Webhook ${channelName}` : channelName,
      );
    }

    const deployment = await context.deploymentLoader(
      account.accountId,
      agent.agentId,
    );

    return handleChannelWebhook(
      accountChannel,
      channelRequest,
      handlers,
      account,
      agent,
      deployment,
      context,
    );
  }

  const publicEndpoint = parsePublicEndpointPath(request.path);
  if (
    !context.directApiEnabled &&
    (request.path === "/" || isAsyncPath(request.path) || publicEndpoint)
  ) {
    return directApiDisabledResponse();
  }

  const auth = await context.authResolver(request.headers);

  // Scope resolution for the realtime observability gateway. The gateway calls
  // this server-side with the client's runtime key to learn which NATS subjects
  // and Loki/Tempo labels it may stream. Scope comes from the key, never the
  // client, so a deployment key is required and the response is its own scope.
  if (isObservabilityScopePath(request.path)) {
    if (auth?.kind !== "deployment") {
      return unauthorizedResponse();
    }

    return jsonResponse(200, {
      accountId: auth.account.accountId,
      projectSlug: auth.projectSlug,
      stageSlug: auth.stageSlug,
      endpointIds: [auth.endpointId],
    });
  }

  // A project+stage runtime key works on both the root direct API and the scoped
  // /v1/{project}/agents/{stage}/{endpointId} URL the dashboard advertises. When
  // the scoped path is present it must match the key's stage; the agent itself is
  // chosen by the request body's agentId and loaded against the key's account.
  if (auth?.kind === "deployment") {
    if (publicEndpoint && !deploymentMatchesPath(auth, publicEndpoint)) {
      return unauthorizedResponse();
    }

    try {
      const parsed = await parseDirectPayload(
        request.body,
        request.headers,
        auth.account,
        context.agentLoader,
      );
      // Secure by default: the public runtime key only reaches agents that have
      // explicitly opted into the public endpoint. Internal callers (account/
      // admin secret), channel webhooks, and cron paths are never gated here.
      if (parsed.agentConfig.publicAccess !== true) {
        return errorResponse(
          403,
          `Agent ${parsed.agentId} is not publicly accessible. Enable public access and redeploy, or reach it through an internal endpoint or channel webhook.`,
          { code: "public_access_disabled", agentId: parsed.agentId },
        );
      }
      if (publicEndpoint?.mode === "async" || isAsyncPath(request.path)) {
        if (!handlers.handleAsyncRequest) {
          return notFoundResponse();
        }

        const statusUrl = buildStatusUrl(parsed.publicEventId, parsed.agentId);
        if (!statusUrl) {
          return errorResponse(
            503,
            "Async API is unavailable: PUBLIC_BASE_URL is not configured",
          );
        }

        return handlers.handleAsyncRequest({
          ...parsed,
          endpointId: auth.endpointId,
          projectSlug: auth.projectSlug,
          stageSlug: auth.stageSlug,
          publicDeploymentIngress: publicDeploymentIngress(auth),
          statusUrl: statusUrl,
        });
      }

      return handlers.handleDirectRequest({
        ...parsed,
        endpointId: auth.endpointId,
        projectSlug: auth.projectSlug,
        stageSlug: auth.stageSlug,
        publicDeploymentIngress: publicDeploymentIngress(auth),
      });
    } catch (err) {
      return badRequestResponse(err);
    }
  }

  // The scoped public URL only accepts a deployment key.
  if (publicEndpoint) {
    return unauthorizedResponse();
  }

  const account = auth?.kind === "account" ? auth.account : null;
  if (!account) {
    return unauthorizedResponse();
  }

  try {
    const parsed = await parseDirectPayload(
      request.body,
      request.headers,
      account,
      context.agentLoader,
    );
    if (isAsyncPath(request.path)) {
      if (!handlers.handleAsyncRequest) {
        return notFoundResponse();
      }

      const statusUrl = buildStatusUrl(parsed.publicEventId, parsed.agentId);
      if (!statusUrl) {
        return errorResponse(
          503,
          "Async API is unavailable: PUBLIC_BASE_URL is not configured",
        );
      }

      return handlers.handleAsyncRequest({
        ...parsed,
        statusUrl: statusUrl,
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
/**
 * Find the agent whose channel credentials verify this request. Only agents
 * that configure the channel are tried, signature checks are cheap, and the
 * scan is capped so a large account cannot turn one webhook into unbounded work.
 */
async function findChannelCredentialHolder(
  context: HttpRoutingContext,
  accountId: string,
  channelName: string,
  request: ChannelRequest,
  endpointId?: string,
): Promise<ChannelCredentialHolder> {
  let listed: AgentRecord[];
  try {
    // A stage-scoped URL narrows the scan to that stage, so a sibling stage
    // holding the same provider credentials is never a candidate.
    listed = endpointId
      ? await context.stageAgentLister(accountId, endpointId)
      : await context.agentLister(accountId);
  } catch (err) {
    logWarn("Channel credential holder lookup failed", {
      accountId: accountId,
      channel: channelName,
      endpointId: endpointId,
      error: err instanceof Error ? err.message : String(err),
    });

    return { kind: "unavailable" };
  }
  // A stage URL that resolves to nothing named a stage of another account, or
  // one that is gone. Say that, rather than reporting the channel unconfigured.
  if (endpointId && listed.length === 0) {
    return { kind: "unknown-stage" };
  }
  // Cap the agents that actually configure this channel, not the raw list — an
  // account whose 30th agent owns the Slack app must still be reachable. Sort
  // first: the cap is applied while scanning, so ordering it afterwards would
  // still leave *which* agents were considered up to the lister.
  const candidates: Array<{ agent: AgentRecord; adapter: ChannelAdapter }> = [];
  let configured = false;
  let truncated = false;
  for (const candidate of [...listed].sort((left, right) =>
    left.agentId.localeCompare(right.agentId),
  )) {
    if (candidate.status !== "active") continue;
    // Cheap key check before building any adapter: an unauthenticated caller
    // should not make us instantiate SDK clients for every agent in the account.
    if (!candidate.config.channels?.[channelName]) continue;
    configured = true;
    const adapter = createChannelRegistry(
      candidate.config,
    ).webhookChannels.find(
      (channel) => channel.name === channelName && channel.canHandle(request),
    );
    if (!adapter) continue;
    if (candidates.length >= CHANNEL_CREDENTIAL_CANDIDATE_LIMIT) {
      truncated = true;
      break;
    }
    candidates.push({ agent: candidate, adapter: adapter });
  }
  if (truncated) {
    logWarn("Channel credential candidates truncated", {
      accountId: accountId,
      channel: channelName,
      limit: CHANNEL_CREDENTIAL_CANDIDATE_LIMIT,
    });
  }

  // Sort before authenticating. With no agent in the URL this scan is the only
  // thing choosing a receiver, so two agents sharing one provider app must not
  // resolve differently between requests — pick the same one every time and say
  // so, since a channel record is what disambiguates them properly.
  candidates.sort((left, right) =>
    left.agent.agentId.localeCompare(right.agent.agentId),
  );
  for (const candidate of candidates) {
    if (await candidate.adapter.authenticate(request)) {
      if (candidates.length > 1) {
        logInfo("Channel credentials matched multiple agents", {
          accountId: accountId,
          channel: channelName,
          candidates: candidates.length,
          receivingAgentId: candidate.agent.agentId,
        });
      }

      return { kind: "holder", agent: candidate.agent };
    }
  }

  return candidates.length > 0
    ? { kind: "unverified" }
    : { kind: "unconfigured", configured: configured };
}

/**
 * Hand the turn to the agent this channel is bound to, with the record's
 * instructions, workspaces and policies layered on. A lookup that answers
 * "no record" falls back to the receiving agent; a lookup that *fails* returns
 * unavailable, because running without a record's policies and denyTools would
 * be an escalation. The channel path already needs Convex to admit ingress, so
 * failing closed here costs no availability that is not already lost.
 */
async function resolveChannelTarget(
  context: HttpRoutingContext,
  account: AccountRecord,
  agent: AgentRecord,
  channelName: string,
  identity: ChannelIdentity | undefined,
): Promise<ChannelTarget> {
  if (!identity?.channelId) return { kind: "resolved", agent: agent };

  // try/catch, not .catch(): a loader can throw synchronously (a partial storage
  // stub, a missing binding) and that must not escape as a 500.
  let record: ChannelRecord | null = null;
  try {
    record = await context.channelRecordLoader(
      account.accountId,
      channelName,
      identity.channelId,
    );
  } catch (err) {
    logWarn("Channel record lookup failed", {
      accountId: account.accountId,
      channel: channelName,
      channelId: identity.channelId,
      error: err instanceof Error ? err.message : String(err),
    });

    return { kind: "unavailable" };
  }
  if (
    record &&
    !channelRecordMatchesWorkspace(record.workspaceRef, identity.workspaceRef)
  ) {
    logWarn("Channel record belongs to a different provider workspace", {
      accountId: account.accountId,
      channel: channelName,
      channelId: identity.channelId,
      recordWorkspaceRef: record.workspaceRef,
      messageWorkspaceRef: identity.workspaceRef,
    });
    record = null;
  }
  if (!record) return { kind: "resolved", agent: agent };

  const boundAgentId = resolveChannelAgentId(record);
  if (!boundAgentId || boundAgentId === agent.agentId) {
    return { kind: "resolved", agent: agent, record: record };
  }

  const bound = await context.agentLoader(account.accountId, boundAgentId);
  if (!bound || bound.status !== "active") {
    logWarn("Channel record binds an agent that is missing or inactive", {
      accountId: account.accountId,
      channel: channelName,
      channelRecordId: record.channelRecordId,
      boundAgentId: boundAgentId,
    });

    return { kind: "resolved", agent: agent, record: record };
  }

  return { kind: "resolved", agent: bound, record: record };
}

// A lookup that failed is not the same as "no record": the first must not run.
type ChannelTarget =
  | { kind: "resolved"; agent: AgentRecord; record?: ChannelRecord }
  | { kind: "unavailable" };

// With no agent in the webhook URL, "nobody configures this channel", "nobody's
// credentials verified" and "the scan broke" are the operator's whole diagnosis.
type ChannelCredentialHolder =
  | { kind: "holder"; agent: AgentRecord }
  | { kind: "unconfigured"; configured: boolean }
  | { kind: "unknown-stage" }
  | { kind: "unverified" }
  | { kind: "unavailable" };

/** Attach the roles this actor holds in the channel so policies can read them. */
function identityWithChannelRoles(
  identity: ChannelIdentity | undefined,
  record: ChannelRecord | undefined,
): ChannelIdentity | undefined {
  if (!identity || !record) return identity;
  const roles = channelActorRoles(record, identity.actorId);

  return roles.length > 0 ? { ...identity, actorRoles: roles } : identity;
}

/**
 * Refuse the tag before the turn starts when a policy says this person may not
 * address the agent here. Audit mode only records it, so a rule can be watched
 * on a live channel before it starts blocking anyone.
 */
async function refuseChannelInvoke(
  agentConfig: AgentConfig,
  account: AccountRecord,
  agentId: string,
  channelName: string,
  identity: ChannelIdentity | undefined,
): Promise<string | null> {
  const decision = await evaluateChannelInvoke(agentConfig, {
    accountId: account.accountId,
    agentId: agentId,
    channel: channelName,
    ...channelPolicyIdentity(identity),
  });
  if (!decision || decision.allowed) return null;

  logWarn(
    `Agent policy ${decision.mode === "enforce" ? "denied" : "would deny"} agent.invoke (${decision.mode})`,
    {
      accountId: account.accountId,
      agentId: agentId,
      channel: channelName,
      channelId: identity?.channelId,
      actorId: identity?.actorId,
      reason: decision.reason,
      matchedRuleIds: decision.matchedRuleIds,
    },
  );

  return decision.mode === "enforce" ? decision.reason : null;
}

/**
 * Reply routing for this turn. A record's `threadPolicy` decides between a
 * thread and the channel, so it applies only where the provider gives the
 * runtime that choice — everywhere else the source is already the one place.
 */
function channelReplySource(
  adapter: ChannelAdapter,
  message: InboundMessage,
  record: ChannelRecord | undefined,
): Record<string, unknown> {
  const policy = record?.config.threadPolicy;
  if (!policy || !adapter.applyThreadPolicy) return message.source;

  return adapter.applyThreadPolicy(message.source, policy);
}

/** Scope the run to this channel's own config, then layer the record over it. */
function channelRuntimeAgentConfig(
  target: { agent: AgentRecord; record?: ChannelRecord },
  channelName: string,
  credentialHolderConfig: AgentConfig,
): AgentConfig {
  const targetConfig = toChannelRuntimeAgentConfig(
    target.agent.config,
    channelName,
  );
  const credentialChannel = credentialHolderConfig.channels?.[channelName];
  const config = credentialChannel
    ? {
        ...targetConfig,
        channels: {
          ...targetConfig.channels,
          [channelName]: credentialChannel,
        },
      }
    : targetConfig;

  return target.record
    ? applyChannelRecord(config, target.record, channelName)
    : config;
}

// Bound so one inbound webhook cannot fan out into an unbounded credential scan.
const CHANNEL_CREDENTIAL_CANDIDATE_LIMIT = 25;

async function handleChannelWebhook(
  adapter: ChannelAdapter,
  request: ChannelRequest,
  handlers: IntegrationHandlers,
  account: AccountRecord,
  agent: AgentRecord,
  deployment: AgentDeploymentScope | null,
  context: HttpRoutingContext,
): Promise<Response> {
  const waitUntil = context.waitUntil;
  const previousObservabilityContext = getObservabilityContext();
  if (deployment) {
    setObservabilityContext({
      accountId: account.accountId,
      project: deployment.projectSlug,
      stage: deployment.stageSlug,
      endpointId: deployment.endpointId,
      agentId: agent.agentId,
      conversationKey: `webhook:${adapter.name}:${agent.agentId}`,
      traceId: mintTraceId(),
      otelContext: otelContextApi.active(),
      secretValues: collectSecretValues(agent.config),
    });
  }

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
        reason: parsed.reason,
        statusCode: parsed.response.statusCode,
      });

      return toResponse(parsed.response);
    }

    // Webhook is valid enough to accept, but should not run the agent.
    // Example: unsupported Pancake event, wrong page ID, hidden/removed or page-originated message.
    if (parsed.kind === "ignore") {
      logInfo(`Channel webhook ignored: ${parsed.reason ?? "unspecified"}`, {
        channel: adapter.name,
        accountId: account.accountId,
        agentId: agent.agentId,
        reason: parsed.reason,
        statusCode: parsed.response?.statusCode ?? 200,
      });

      return toResponse(parsed.response ?? { statusCode: 200 });
    }

    if (parsed.kind === "cleanup") {
      const response = parsed.ack ?? { statusCode: 200 };
      logInfo("Channel webhook accepted for workspace cleanup", {
        channel: adapter.name,
        accountId: account.accountId,
        agentId: agent.agentId,
        eventId: parsed.eventId,
        conversationKey: parsed.conversationKey,
        statusCode: response.statusCode,
      });
      waitUntil(
        Promise.resolve().then(() =>
          cleanupChannelWorkspaceScopes({
            accountId: account.accountId,
            agentConfig: agent.config,
            channelName: parsed.channelName,
            conversationKey: parsed.conversationKey,
          }),
        ),
      );

      return toResponse(response);
    }

    if (parsed.kind === "context") {
      const { message, ack } = parsed;
      const response = ack ?? { statusCode: 200 };
      const target = await resolveChannelTarget(
        context,
        account,
        agent,
        message.channelName,
        message.identity,
      );
      if (target.kind === "unavailable") {
        logWarn("Channel context dropped; record lookup unavailable", {
          channel: adapter.name,
          accountId: account.accountId,
          conversationKey: message.conversationKey,
        });

        return toResponse(response);
      }
      const targetDeployment =
        target.agent.agentId === agent.agentId
          ? deployment
          : await context.deploymentLoader(
              account.accountId,
              target.agent.agentId,
            );
      const contextIdentity = identityWithChannelRoles(
        message.identity,
        target.record,
      );
      logInfo("Channel webhook accepted as context", {
        channel: adapter.name,
        accountId: account.accountId,
        agentId: target.agent.agentId,
        channelRecordId: target.record?.channelRecordId,
        eventId: message.eventId,
        conversationKey: message.conversationKey,
        statusCode: response.statusCode,
      });

      waitUntil(
        Promise.resolve().then(() =>
          handlers.handleChannelContext?.({
            eventId: accountAgentScopedKey(
              account.accountId,
              target.agent.agentId,
              message.eventId,
            ),
            conversationKey: accountAgentScopedKey(
              account.accountId,
              target.agent.agentId,
              message.conversationKey,
            ),
            content: message.content,
            events: message.events ?? [
              { role: "user", content: message.content },
            ],
            channelName: message.channelName,
            ...(contextIdentity ? { identity: contextIdentity } : {}),
            source: message.source,
            accountId: account.accountId,
            agentId: target.agent.agentId,
            agentConfig: channelRuntimeAgentConfig(
              target,
              message.channelName,
              agent.config,
            ),
            ...(targetDeployment
              ? {
                  endpointId: targetDeployment.endpointId,
                  projectSlug: targetDeployment.projectSlug,
                  stageSlug: targetDeployment.stageSlug,
                }
              : {}),
          }),
        ),
      );

      return toResponse(response);
    }

    // The promise is deferred by one microtask so this request's scoped context
    // is restored in finally before background channel processing establishes
    // its own context.
    const { message, ack } = parsed;
    const response = ack ?? { statusCode: 200 };
    const target = await resolveChannelTarget(
      context,
      account,
      agent,
      message.channelName,
      message.identity,
    );
    if (target.kind === "unavailable") {
      logWarn("Channel turn refused; record lookup unavailable", {
        channel: adapter.name,
        accountId: account.accountId,
        conversationKey: message.conversationKey,
      });
      waitUntil(
        adapter
          .actions(message)
          .sendText(
            formatChannelErrorText(
              "I can't reach my channel configuration right now — try again in a moment.",
            ),
          )
          .catch(() => {}),
      );

      return toResponse(response);
    }
    // The rewritten source is what every later reply routes on, so a background
    // job's delayed answer lands in the same place this turn's did.
    const source = channelReplySource(adapter, message, target.record);
    // Replies go out through the adapter that received the webhook — the same
    // provider app — even when the channel record hands the run to another agent.
    const channel = adapter.actions({ ...message, source: source });
    const targetDeployment =
      target.agent.agentId === agent.agentId
        ? deployment
        : await context.deploymentLoader(
            account.accountId,
            target.agent.agentId,
          );
    logInfo("Channel webhook accepted for async processing", {
      channel: adapter.name,
      accountId: account.accountId,
      agentId: target.agent.agentId,
      channelRecordId: target.record?.channelRecordId,
      eventId: message.eventId,
      conversationKey: message.conversationKey,
      statusCode: response.statusCode,
    });

    const identity = identityWithChannelRoles(message.identity, target.record);
    const targetConfig = channelRuntimeAgentConfig(
      target,
      message.channelName,
      agent.config,
    );
    const refusal = await refuseChannelInvoke(
      targetConfig,
      account,
      target.agent.agentId,
      message.channelName,
      identity,
    );
    if (refusal) {
      waitUntil(
        channel
          .sendText(formatChannelErrorText(refusal))
          .catch((err: unknown) => {
            logError("Failed to send channel policy refusal", {
              channel: adapter.name,
              error: err instanceof Error ? err.message : String(err),
            });
          }),
      );

      return toResponse(response);
    }

    waitUntil(
      Promise.resolve().then(() =>
        processChannelMessage(
          {
            eventId: accountAgentScopedKey(
              account.accountId,
              target.agent.agentId,
              message.eventId,
            ),
            conversationKey: accountAgentScopedKey(
              account.accountId,
              target.agent.agentId,
              message.conversationKey,
            ),
            content: message.content,
            events: message.events ?? [
              { role: "user", content: message.content },
            ],
            channelName: message.channelName,
            ...(identity ? { identity: identity } : {}),
            source: source,
            channel: channel,
            channelFactory: (replySource) =>
              adapter.actions({ ...message, source: replySource }),
            accountId: account.accountId,
            agentId: target.agent.agentId,
            agentConfig: targetConfig,
            ...(targetDeployment
              ? {
                  endpointId: targetDeployment.endpointId,
                  projectSlug: targetDeployment.projectSlug,
                  stageSlug: targetDeployment.stageSlug,
                }
              : {}),
          },
          handlers,
        ),
      ),
    );

    return toResponse(response);
  } catch (err) {
    logError("Failed to process webhook request", {
      channel: adapter.name,
      error: err instanceof Error ? err.message : String(err),
    });

    return errorResponse(500, "Internal server error");
  } finally {
    if (deployment) {
      setObservabilityContext(previousObservabilityContext);
    }
  }
}

async function cleanupChannelWorkspaceScopes(options: {
  accountId: string;
  agentConfig: AgentConfig;
  channelName: string;
  conversationKey: string;
}): Promise<void> {
  const channelConfig = options.agentConfig.channels?.[options.channelName];
  const rawWorkspaceScope = isPlainObject(channelConfig)
    ? channelConfig.workspaceScope
    : undefined;
  const workspaceScope = isChannelWorkspaceScope(rawWorkspaceScope)
    ? rawWorkspaceScope
    : undefined;
  if (workspaceScope?.level !== "conversation") {
    return;
  }

  const storage = getStorage();
  let deleted = 0;
  let reservedSandboxesReleased = 0;
  for (const ref of options.agentConfig.workspaces ?? []) {
    const record = await storage.workspaceConfigs.getById(
      options.accountId,
      ref.workspaceId,
    );
    if (!record || record.config.isolation !== true) {
      continue;
    }

    const namespace = isolatedWorkspaceNamespace(
      workspaceNamespace(options.accountId, ref.workspaceId),
      record.config.isolation,
      {
        channelName: options.channelName,
        channelScopeKey: channelScopeKeyFromConversation(
          options.conversationKey,
        ),
        conversationKey: channelScopeKeyFromConversation(
          options.conversationKey,
          "conversation",
        ),
        workspaceScope: workspaceScope,
      },
    );
    reservedSandboxesReleased += await releaseReservedSandboxes(
      options.accountId,
      [namespace],
    );
    const target = await resolveS3ReadTarget(
      workspaceReadContext(record.config.storage, namespace),
    );
    deleted += await deleteS3Prefix(
      target.bucket,
      target.prefix,
      target.access,
    );
  }

  logInfo("Channel workspace scoped cleanup completed", {
    accountId: options.accountId,
    channelName: options.channelName,
    conversationKey: options.conversationKey,
    deleted: deleted,
    reservedSandboxesReleased: reservedSandboxesReleased,
  });
}

function isChannelWorkspaceScope(
  value: unknown,
): value is AgentChannelWorkspaceScope {
  if (!isPlainObject(value)) return false;
  if (value.level === "channel") return value.alias === undefined;

  return value.level === "conversation" && typeof value.alias === "string";
}

// Attaches an onMessageReceived hook's opaque metadata to the newest user
// ingress event; the session persists it and re-exposes it on hook payloads.
export function attachMetadataToLatestUserIngress(
  events: ConversationIngressEvent[],
  metadata: unknown,
): ConversationIngressEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.role !== "user") continue;
    const next = [...events];
    next[i] = { ...event, metadata: metadata };

    return next;
  }

  return events;
}

async function processChannelMessage(
  event: ChannelInboundEvent,
  handlers: IntegrationHandlers,
): Promise<void> {
  const previousObservabilityContext = getObservabilityContext();
  const hasDeploymentScope = Boolean(
    event.accountId &&
    event.agentId &&
    event.endpointId &&
    event.projectSlug &&
    event.stageSlug,
  );
  if (hasDeploymentScope) {
    setObservabilityContext({
      accountId: event.accountId!,
      project: event.projectSlug!,
      stage: event.stageSlug!,
      endpointId: event.endpointId!,
      agentId: event.agentId!,
      conversationKey: event.conversationKey,
      traceId: mintTraceId(),
      otelContext: otelContextApi.active(),
      secretValues: collectSecretValues(event.agentConfig),
    });
  }

  try {
    logInfo("Channel message processing started", {
      channel: event.channelName,
      accountId: event.accountId,
      agentId: event.agentId,
      eventId: event.eventId,
      conversationKey: event.conversationKey,
      source: event.source,
    });

    // An onMessageReceived hook may drop or rewrite the inbound message before it
    // reaches the agent (spam filter, redaction). Cheap when unused: the
    // dispatcher is a no-op unless the agent configured code hooks.
    let content = event.content;
    let events = event.events;
    if (event.agentConfig) {
      const hooks = await createAgentHookDispatcher(
        event.accountId,
        event.agentConfig,
      );
      const mutation = await hooks.runMutation("channel.message.received", {
        channel: event.channelName,
        text: extractText(event.content),
        // Channel-specific routing data (e.g. Pancake `tagIds`) so a hook can
        // key on it — the replacement for the old baked-in tag skip.
        source: toLifecycleValue(event.source),
      });
      if (mutation?.drop === true) {
        logInfo("Channel message dropped by onMessageReceived hook", {
          channel: event.channelName,
          eventId: event.eventId,
          conversationKey: event.conversationKey,
        });

        return;
      }
      if (typeof mutation?.text === "string") {
        content = rewriteUserContentText(content, mutation.text);
        // The turn is persisted and built from the ingress events, not from
        // `content` (handler.ts appendIngressEvents) — a rewrite that only
        // touches `content` is computed and then dropped.
        events = rewriteLatestUserIngressText(events, mutation.text);
      }
      if (mutation !== undefined && mutation.metadata !== undefined) {
        events = attachMetadataToLatestUserIngress(events, mutation.metadata);
      }
    }

    event.channel.sendTyping().catch(() => {});
    event.channel.reactToMessage().catch(() => {});

    await handlers.handleChannelRequest({
      ...event,
      content: content,
      events: events,
      commandToken:
        resolveCommandToken(content, event.source, event.channelName) ??
        undefined,
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
      error: error,
    });
    await event.channel
      .sendText(formatChannelErrorText(error))
      .catch((sendErr) => {
        logError("Failed to send channel error message", {
          channel: event.channelName,
          eventId: event.eventId,
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
      });
  } finally {
    if (hasDeploymentScope) {
      setObservabilityContext(previousObservabilityContext);
    }
  }
}

/**
 * Applies a channel.message.received text rewrite to the ingress events that
 * actually reach the session. The newest user event is the inbound message the
 * hook saw; earlier events (context, prior turns a channel may batch) are kept.
 */
export function rewriteLatestUserIngressText(
  events: ConversationIngressEvent[],
  text: string,
): ConversationIngressEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.role !== "user") continue;
    const next = [...events];
    next[i] = { ...event, content: rewriteUserContentText(event.content, text) };

    return next;
  }

  return events;
}

// A hook rewrites text only, so any image or file the channel delivered stays on
// the message — otherwise redacting the caption drops the attachment with it.
function rewriteUserContentText(
  content: UserContent,
  text: string,
): UserContent {
  if (typeof content === "string") {

    return text;
  }
  const attachments = content.filter((part) => part.type !== "text");

  return attachments.length > 0
    ? [{ type: "text", text: text }, ...attachments]
    : text;
}

function resolveCommandToken(
  content: UserContent,
  source: Record<string, unknown>,
  channelName: string,
): string | null {
  if (typeof source.commandToken === "string") {
    return parseCommand(source.commandToken);
  }

  if (!supportsInlineCommands(channelName)) {
    return null;
  }

  const inlineCommand = parseCommand(extractText(content));
  if (inlineCommand) {
    return inlineCommand;
  }

  return null;
}

function supportsInlineCommands(channelName: string): boolean {
  return (
    channelName === "discord" ||
    channelName === "slack" ||
    channelName === "telegram"
  );
}

function toResponse(response: ChannelResponse): Response {
  return new Response(response.body ?? "", {
    status: response.statusCode ?? 200,
    headers: response.headers ?? {},
  });
}

function integrationNotConfigured(name: string): Response {
  return errorResponse(503, `${name} integration is not configured`);
}

function directApiDisabledResponse(): Response {
  return errorResponse(404, "Direct API is disabled");
}

function createChannelRegistry(config: AgentConfig): ChannelRegistry {
  const telegramChannel = createTelegramChannelFromConfig(config);
  const githubChannel = createGitHubChannelFromConfig(config);
  const slackChannel = createSlackChannelFromConfig(config);
  const discordChannel = createDiscordChannelFromConfig(config);
  const pancakeChannel = createPancakeChannelFromConfig(config);
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

export function channelActionsFromConfig(
  config: AgentConfig,
  channelName: string,
  source: Record<string, unknown>,
): ChannelActions | null {
  const adapter = createChannelRegistry(config).webhookChannels.find(
    (candidate) => candidate.name === channelName,
  );
  if (!adapter) {
    return null;
  }

  return adapter.actions({
    eventId: "",
    conversationKey: "",
    channelName: channelName,
    content: "",
    source: source,
  });
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
  channelName: string;
  source: Record<string, unknown>;
  text: string;
  // When set, `text` becomes the image caption instead of its own message.
  imageUrl?: string;
}): Promise<void> {
  const registry = createChannelRegistry(options.config);
  const adapter = registry.webhookChannels.find(
    (channel) => channel.name === options.channelName,
  );
  if (!adapter) {
    throw new Error(
      `Channel ${options.channelName} is not configured for this agent`,
    );
  }

  // Outbound policy applies to delayed replies too, not just the sync path.
  const hooks = await createAgentHookDispatcher(
    options.accountId,
    options.config,
  );
  const text = await applyMessageSendingHook(
    hooks,
    options.channelName,
    options.text,
  );
  if (text === null) {
    logInfo("Channel reply dropped by onMessageSending hook", {
      channel: options.channelName,
    });

    return;
  }

  const message: InboundMessage = {
    eventId: "",
    conversationKey: "",
    channelName: options.channelName,
    content: text,
    source: options.source,
  };
  const actions = adapter.actions(message);
  if (options.imageUrl) {
    if (!actions.sendImage) {
      throw new Error(
        `Channel ${options.channelName} cannot send images; send a link instead`,
      );
    }
    await actions.sendImage(options.imageUrl, text || undefined);

    return;
  }
  await actions.sendText(text);
}

function parsePublicEndpointPath(rawPath: string): PublicEndpointPath | null {
  const scoped = rawPath.match(
    /^\/v1\/([^/]+)\/agents\/([^/]+)\/([^/]+)(?:\/(async))?$/,
  );
  if (scoped?.[1] && scoped[2] && scoped[3]) {
    return {
      projectSlug: decodeURIComponent(scoped[1]),
      stageSlug: decodeURIComponent(scoped[2]),
      endpointId: decodeURIComponent(scoped[3]),
      mode: scoped[4] === "async" ? "async" : "sync",
    };
  }

  const unscoped = rawPath.match(/^\/v1\/agents\/([^/]+)(?:\/(async))?$/);
  if (unscoped?.[1]) {
    return {
      endpointId: decodeURIComponent(unscoped[1]),
      mode: unscoped[2] === "async" ? "async" : "sync",
    };
  }

  return null;
}

function deploymentMatchesPath(
  auth: Extract<AuthContext, { kind: "deployment" }>,
  endpoint: PublicEndpointPath,
): boolean {
  return (
    auth.endpointId === endpoint.endpointId &&
    (endpoint.projectSlug === undefined ||
      auth.projectSlug === endpoint.projectSlug) &&
    (endpoint.stageSlug === undefined || auth.stageSlug === endpoint.stageSlug)
  );
}

function publicDeploymentIngress(
  auth: Extract<AuthContext, { kind: "deployment" }>,
): PublicDeploymentIngress {
  return {
    accountId: auth.account.accountId,
    endpointId: auth.endpointId,
    stageSlug: auth.stageSlug,
    projectSlug: auth.projectSlug,
  };
}

async function parseDirectPayload(
  bodyText: string,
  headers: Record<string, string>,
  account: AccountRecord,
  agentLoader: (
    accountId: string,
    agentId: string,
  ) => Promise<AgentRecord | null>,
): Promise<DirectInboundEvent> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    throw new Error(
      `Invalid request JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error("Request body must be a JSON object");
  }

  const record = parsed;
  if (
    typeof record.eventId !== "string" ||
    typeof record.conversationKey !== "string"
  ) {
    throw new Error("Request body must include eventId and conversationKey");
  }

  if (
    typeof record.agentId !== "string" ||
    record.agentId.trim().length === 0
  ) {
    throw new Error("Request body must include agentId");
  }
  const agentId = normalizeDirectIdentifier("agentId", record.agentId);
  const agent = await agentLoader(account.accountId, agentId);
  if (!agent || agent.status !== "active") {
    throw new DirectNotFoundError("Agent not found");
  }

  const rawEventId = assertValidPublicEventId(record.eventId as string);
  const rawConversationKey = assertValidPublicConversationKey(
    record.conversationKey as string,
  );

  const events = parseDirectIngressEvents(record);
  if (events.length === 0) {
    throw new Error("Request body must include a non-empty events array");
  }
  if (
    record.webhookUrl !== undefined ||
    headers["x-webhook-secret"] !== undefined
  ) {
    throw new Error(
      "Per-request webhook callbacks are no longer supported; configure config.hooks.webhook on the agent",
    );
  }

  const overrides = parseRunOverrides(record);
  const connectionId =
    typeof record.connectionId === "string" &&
    record.connectionId.trim().length > 0
      ? record.connectionId.trim()
      : undefined;
  // Steer is the default: a busy conversation absorbs the request at the next
  // step boundary (or FIFO-follows up); callers opt into reject explicitly.
  const requestedMode = parseIngressMode(record.mode) ?? "steer";
  const idempotencyKey =
    record.idempotencyKey === undefined
      ? rawEventId
      : normalizeDirectIdentifier(
          "idempotencyKey",
          String(record.idempotencyKey),
        );

  return {
    accountId: account.accountId,
    agentId: agent.agentId,
    agentConfig: applyRunOverrides(
      toRuntimeAgentConfig(agent.config),
      overrides,
    ),
    eventId: scopedDirectEventId(account.accountId, agent.agentId, rawEventId),
    publicEventId: rawEventId,
    conversationKey: scopedDirectConversationKey(
      account.accountId,
      agent.agentId,
      rawConversationKey,
    ),
    publicConversationKey: rawConversationKey,
    events: events,
    requestedMode: requestedMode,
    idempotencyKey: idempotencyKey,
    ...(connectionId ? { connectionId: connectionId } : {}),
    ...(overrides?.system ? { ephemeralSystem: overrides.system } : {}),
  };
}

/** Validates the optional public ingress mode. */
function parseIngressMode(value: unknown): IngressMode | undefined {
  if (value === undefined) return undefined;
  if (
    value === "reject" ||
    value === "followup" ||
    value === "collect" ||
    value === "steer"
  ) {
    return value;
  }
  throw new Error("mode must be reject, followup, collect, or steer");
}

/**
 * Validates optional per-run overrides from a request body. `model` rejects the
 * reserved identity/credential keys (RUN_OVERRIDE_RESERVED_MODEL_KEYS), rejects unsupported
 * keys, and forwards AI SDK call settings/providerOptions to the same
 * model path as the stored config. Returns undefined when absent.
 */
export function parseRunOverrides(
  record: Record<string, unknown>,
): RunOverrides | undefined {
  if (record.params !== undefined) {
    throw new Error(
      "Request body params is not supported; use top-level system and model",
    );
  }
  const overrides: RunOverrides = {};

  if (record.system !== undefined) {
    overrides.system = parseSystemOverride(record.system);
  }

  if (record.model !== undefined) {
    if (
      typeof record.model !== "object" ||
      record.model === null ||
      Array.isArray(record.model)
    ) {
      throw new Error("model must be an object");
    }
    const reserved = new Set<string>(RUN_OVERRIDE_RESERVED_MODEL_KEYS);
    const supportedSettings = new Set<string>(MODEL_CONFIG_SETTING_KEYS);
    const model: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record.model)) {
      if (reserved.has(key)) {
        throw new Error(`model.${key} cannot be overridden per run`);
      }
      if (!supportedSettings.has(key)) {
        throw new Error(
          `model.${key} is not supported; use model.providerOptions for provider-specific settings`,
        );
      }
      model[key] = value;
    }
    if (Object.keys(model).length > 0) {
      overrides.model = model;
    }
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function parseSystemOverride(raw: unknown): SystemModelMessage[] {
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length === 0) {
    throw new Error("system must include at least one SystemModelMessage");
  }

  return values.map((value) => {
    const parsed = systemModelMessageSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `system must be a SystemModelMessage or array of SystemModelMessage: ${
          parsed.error.issues[0]?.message ?? "invalid system message"
        }`,
      );
    }

    return parsed.data;
  });
}

function parseStatusPath(
  rawPath: string,
  rawQueryString: string,
  account: AccountRecord,
): StatusInboundEvent {
  const match = rawPath.match(/^\/status\/([^/]+)$/);
  const rawEventId = match?.[1] ? decodeURIComponent(match[1]) : "";
  const publicEventId = assertValidPublicStatusEventId(rawEventId);

  const params = new URLSearchParams(rawQueryString);
  const rawAgentId = params.get("agentId");
  if (!rawAgentId) {
    throw new Error("agentId query parameter is required");
  }
  const agentId = normalizeDirectIdentifier("agentId", rawAgentId);

  return {
    accountId: account.accountId,
    agentId: agentId,
    eventId: scopedDirectEventId(account.accountId, agentId, publicEventId),
    publicEventId: publicEventId,
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
    throw new Error(
      `Invalid request JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error("Async tool completion body must be an object");
  }

  const record = parsed;
  if (record.status !== "completed" && record.status !== "failed") {
    throw new Error("Async tool completion status must be completed or failed");
  }

  if (record.status === "failed" && typeof record.error !== "string") {
    throw new Error(
      "Async tool completion error must be a string when status is failed",
    );
  }

  return {
    accountId: account.accountId,
    resultId: decodeURIComponent(rawResultId),
    status: record.status,
    ...(record.response !== undefined
      ? { response: record.response as JSONValue }
      : {}),
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
    throw new Error(
      "Background job completion requires the x-job-token header",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    throw new Error(
      `Invalid request JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error("Background job completion body must be an object");
  }

  const record = parsed;
  if (record.status !== "completed" && record.status !== "failed") {
    throw new Error(
      "Background job completion status must be completed or failed",
    );
  }

  return {
    resultId: decodeURIComponent(rawResultId),
    token: token,
    status: record.status,
    ...(record.response !== undefined
      ? { response: record.response as JSONValue }
      : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}

function isObservabilityScopePath(rawPath: string): boolean {
  return rawPath === "/v1/internal/observability-scope";
}

// A malformed escape makes `decodeURIComponent` throw, which would surface as a
// 500 on a path the router should simply decline.
function decodePathSegments(segments: string[]): string[] | null {
  try {
    return segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

// The `dev` marker keeps the stage form at four segments, so the retired
// three-segment agent form still reaches its own 404 instead of a stage lookup.
function matchWebhookPath(rawPath: string): WebhookRoute | null {
  const stageMatch = rawPath.match(
    /^\/webhooks\/([^/]+)\/dev\/([^/]+)\/([^/]+)$/,
  );
  if (stageMatch?.[1] && stageMatch[2] && stageMatch[3]) {
    const decoded = decodePathSegments([
      stageMatch[1],
      stageMatch[2],
      stageMatch[3],
    ]);

    return decoded
      ? {
          accountId: decoded[0]!,
          channelName: decoded[2]!,
          endpointId: decoded[1]!,
        }
      : null;
  }

  const accountMatch = rawPath.match(/^\/webhooks\/([^/]+)\/([^/]+)$/);
  if (accountMatch?.[1] && accountMatch[2]) {
    const decoded = decodePathSegments([accountMatch[1], accountMatch[2]]);

    return decoded
      ? { accountId: decoded[0]!, channelName: decoded[1]! }
      : null;
  }

  return null;
}

function unauthorizedResponse(): Response {
  return errorResponse(401, "Unauthorized");
}

function badRequestResponse(err: unknown): Response {
  if (err instanceof DirectNotFoundError) {
    return errorResponse(404, err.message);
  }
  if (err instanceof StatusUrlConfigError) {
    return errorResponse(500, err.message);
  }

  return errorResponse(
    400,
    err instanceof Error ? err.message : "Invalid request",
  );
}

function notFoundResponse(): Response {
  return errorResponse(404, "Not found");
}

function isAsyncPath(rawPath: string): boolean {
  return rawPath === "/async";
}

function isStatusPath(rawPath: string): boolean {
  return rawPath.startsWith("/status/");
}

function buildStatusUrl(publicEventId: string, agentId: string): string | null {
  const baseUrl = getHarnessPublicUrl();
  if (!baseUrl) {
    throw new StatusUrlConfigError("PUBLIC_BASE_URL is not configured");
  }

  return `${baseUrl}/status/${encodeURIComponent(publicEventId)}?agentId=${encodeURIComponent(agentId)}`;
}

function parseDirectIngressEvents(
  record: Record<string, unknown>,
): DirectIngressEvent[] {
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
      throw new Error(
        `Invalid direct event: ${parsedUser.error.issues[0]?.message ?? "must match UserModelMessage"}`,
      );
    }

    return parsedUser.data;
  }

  if (candidate.role === "tool") {
    const parsedTool = toolModelMessageSchema.safeParse(candidate);
    if (!parsedTool.success) {
      throw new Error(
        `Invalid direct event: ${parsedTool.error.issues[0]?.message ?? "must match ToolModelMessage"}`,
      );
    }
    if (
      parsedTool.data.content.length === 0 ||
      !parsedTool.data.content.every(
        (part) => part.type === "tool-approval-response",
      )
    ) {
      throw new Error(
        "Direct API tool events may include only tool-approval-response parts",
      );
    }

    return parsedTool.data;
  }

  if (candidate.role !== "system") {
    throw new Error(
      "Direct API accepts only user, tool approval, and ephemeral system events",
    );
  }

  if (persist === true) {
    throw new Error("Direct API system events cannot be persisted");
  }

  const parsedSystem = systemModelMessageSchema.safeParse(candidate);
  if (!parsedSystem.success) {
    throw new Error(
      `Invalid direct event: ${parsedSystem.error.issues[0]?.message ?? "must match SystemModelMessage"}`,
    );
  }

  return {
    ...parsedSystem.data,
    persist: false,
  };
}

function createTelegramChannelFromConfig(
  config: AgentConfig,
): ChannelAdapter | null {
  const channel = config.channels?.telegram;
  if (!channel?.botToken || !channel.webhookSecret || !channel.allowedChatIds) {
    return null;
  }

  return createTelegramChannel(
    channel.botToken,
    channel.webhookSecret,
    new Set(channel.allowedChatIds),
    channel.reactionEmoji ?? "👀",
    channel.apiUrl,
  );
}

function createGitHubChannelFromConfig(
  config: AgentConfig,
): ChannelAdapter | null {
  const channel = config.channels?.github;
  if (!channel?.webhookSecret || !channel.appId || !channel.privateKey) {
    return null;
  }

  return createGitHubChannel(
    channel.webhookSecret,
    channel.appId,
    channel.privateKey,
    channel.allowedRepos ? new Set(channel.allowedRepos) : null,
    channel.apiUrl,
    channel.userName,
    channel.botUserId,
    {
      triggerOnIssueOpen: channel.triggerOnIssueOpen,
      triggerOnPROpen: channel.triggerOnPROpen,
    },
  );
}

function createSlackChannelFromConfig(
  config: AgentConfig,
): ChannelAdapter | null {
  const channel = config.channels?.slack;
  if (!channel?.botToken || !channel.signingSecret) {
    return null;
  }

  return createSlackChannel(
    channel.botToken,
    channel.signingSecret,
    channel.allowedChannelIds ? new Set(channel.allowedChannelIds) : null,
    channel.reactionEmoji ?? "eyes",
    channel.apiUrl,
  );
}

function createDiscordChannelFromConfig(
  config: AgentConfig,
): ChannelAdapter | null {
  const channel = config.channels?.discord;
  if (!channel?.botToken || !channel.publicKey) {
    return null;
  }

  return createDiscordChannel(
    channel.botToken,
    channel.publicKey,
    channel.allowedGuildIds ? new Set(channel.allowedGuildIds) : null,
    channel.apiUrl,
    {
      ...(channel.botUserId ? { botUserId: channel.botUserId } : {}),
      ...(channel.mentionRoleIds
        ? { mentionRoleIds: channel.mentionRoleIds }
        : {}),
    },
  );
}

function createPancakeChannelFromConfig(
  config: AgentConfig,
): ChannelAdapter | null {
  const channel = config.channels?.pancake;
  if (!channel?.pageId || !channel.pageAccessToken || !channel.webhookSecret) {
    return null;
  }

  return createPancakeChannel(
    channel.pageId,
    channel.pageAccessToken,
    channel.webhookSecret,
    channel.senderId,
  );
}

function createZaloChannelFromConfig(
  config: AgentConfig,
): ChannelAdapter | null {
  const channel = config.channels?.zalo;
  if (!channel?.botToken || !channel.webhookSecret) {
    return null;
  }

  return createZaloChannel(channel.botToken, channel.webhookSecret, {
    ...(channel.allowedUserIds?.length
      ? { allowedUserIds: new Set(channel.allowedUserIds) }
      : {}),
    ...(channel.allowedGroupIds?.length
      ? { allowedGroupIds: new Set(channel.allowedGroupIds) }
      : {}),
  });
}
