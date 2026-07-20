/**
 * Harness-processing request handler for the Bun container runtime.
 * Keep request orchestration, session setup, and response shaping here.
 */

import type { JSONValue, SystemModelMessage, ToolModelMessage } from "ai";
import { extractBearerToken, timingSafeStringEqual } from "../shared/auth.ts";
import { markHandlerEntry } from "../shared/cold-start.ts";
import { extractText, formatChannelErrorText } from "../shared/channels.ts";
import { executeCommand } from "../shared/commands.ts";
import { runtime } from "../shared/convex/runtime.ts";
import { getStorage } from "../shared/storage.ts";
import { toRuntimeAgentConfig } from "../shared/domain/agent-config.ts";
import type { CronRecord } from "../shared/domain/cron.ts";
import {
  booleanEnv,
  getHarnessPublicUrl,
  optionalEnv,
  positiveIntegerEnv,
} from "../shared/env.ts";
import {
  errorResponse,
  jsonResponse,
  parseJsonBody,
  type CoreRequest,
  type RequestContext,
} from "../shared/http.ts";
import { logError, logInfo, logWarn } from "../shared/log.ts";
import { LiveNatsPublisher, type NatsPublisher } from "../shared/nats.ts";
import { runWithObservabilityScope } from "../shared/otel.ts";
import {
  publicConversationKeyFromScoped,
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../shared/runtime-keys.ts";
import { runAgentLoop, type ToolApprovalSummary } from "./harness.ts";
import {
  applyMessageSendingHook,
  createAgentHookDispatcher,
  type HookDispatcher,
} from "./hook-dispatcher.ts";
import {
  routeIncomingEvent,
  rewriteLatestUserIngressText,
  sendChannelReply,
  type AsyncDirectInboundEvent,
  type AsyncToolCompletionInboundEvent,
  type ChannelContextEvent,
  type ChannelInboundEvent,
  type DirectInboundEvent,
  type SandboxJobCompletionInboundEvent,
  type StatusInboundEvent,
} from "./integrations.ts";
import { Session, type ConversationIngressEvent } from "./session.ts";
import {
  createPendingAsyncAgentResult,
  getAsyncAgentResult,
  markAsyncAgentResultAwaitingApproval,
  markAsyncAgentResultCompleted,
  markAsyncAgentResultFailed,
} from "./async-agent-result.ts";
import { SubagentCoordinator } from "./subagents.ts";
import {
  AsyncToolCoordinator,
  completionToParentMessage,
} from "./async-tools.ts";
import {
  getDetachedAsyncToolGroup,
  getAsyncToolResult,
  listAsyncToolResultsByParentEvent,
  sealDetachedAsyncToolGroup,
  settleAsyncToolResultFromCallback,
  type AsyncToolDelivery,
  type AsyncToolResultRecord,
  verifyAsyncToolCompletionToken,
} from "./async-tool-result.ts";
import {
  acceptIngress,
  getIngressStatus,
  type AppliedIngress,
  type IngressAdmission,
  type IngressDelivery,
} from "./ingress.ts";

type AgentLoopStream = Awaited<ReturnType<typeof runAgentLoop>>;
type ContinuationOutcome =
  | { kind: "pending"; pendingCount: number }
  | { kind: "ready"; invoked: boolean; publicEventId: string }
  | { kind: "skip" };
type InProcessWorkerRun = (
  payload: AsyncWorkerInvocation | NatsWorkerInvocation,
  context: RequestContext,
) => Promise<unknown>;

interface AsyncWorkerInvocation {
  kind: "direct-api-async-worker";
  event: DirectInboundEvent;
}

interface NatsWorkerInvocation {
  kind: "nats-worker";
  event: DirectInboundEvent;
}

interface CronInvocation {
  kind: "cron";
  accountId: string;
  cronId: string;
}

interface DirectTurn {
  session: Session;
  turnContext: Awaited<ReturnType<Session["createTurnContext"]>>;
}

interface ParentContinuationResult {
  didFail: boolean;
  failureText: string | null;
  finalResponse?: JSONValue;
  traceId?: string;
  approvals: ToolApprovalSummary[];
  hasDetachedCallbacks: boolean;
}

const AGENT_PROCESSING_FAILED = "Agent processing failed";
const CONVERSATION_BUSY =
  "Conversation is already processing another turn. Try again when the current turn finishes.";
const CHANNEL_APPROVAL_DENIAL_REASON =
  "Tool approval is only supported through the direct API.";
const ENABLE_DIRECT_API = booleanEnv("ENABLE_DIRECT_API", true);
const ENABLE_WEBSOCKET = booleanEnv("ENABLE_WEBSOCKET", false);
const LAMBDA_TIMEOUT_SAFETY_MS = 5 * 60 * 1000;
const DEFAULT_PARENT_WAIT_MS = 8 * 60 * 1000;
const DEFAULT_DASHBOARD_URL = "https://dashboard.broods.app";
const MAX_INPROCESS_WORKERS = positiveIntegerEnv("MAX_INPROCESS_WORKERS", 8);
const WORKER_TIMEOUT_BUDGET_MS = positiveIntegerEnv(
  "WORKER_TIMEOUT_BUDGET_MS",
  10 * 60 * 1000,
);
const WORKER_SLOT_GRACE_MS = 5_000;
const MAX_PENDING_WORKER_PAYLOADS = 1000;
const textEncoder = new TextEncoder();
const inProcessWorkers = new Set<Promise<void>>();
const pendingWorkerPayloads: [
  AsyncWorkerInvocation | NatsWorkerInvocation,
  InProcessWorkerRun,
][] = [];

let activeInProcessWorkers = 0;

export async function handler(
  event:
    | CoreRequest
    | AsyncWorkerInvocation
    | NatsWorkerInvocation
    | CronInvocation,
  context?: RequestContext,
): Promise<Response> {
  // Each HTTP request or in-process worker gets a request-private observability
  // scope so concurrent tenants in the shared container process cannot clobber
  // each other's log redaction secrets or NATS routing tags.
  return runWithObservabilityScope(() => handleRequest(event, context));
}

async function handleRequest(
  event:
    | CoreRequest
    | AsyncWorkerInvocation
    | NatsWorkerInvocation
    | CronInvocation,
  context?: RequestContext,
): Promise<Response> {
  // First entry in this execution environment marks the end of the cold-start
  // init window so the first agent run can surface it as a phase span.
  markHandlerEntry(Date.now());

  if (isAsyncWorkerInvocation(event)) {
    await handleAsyncWorkerRequest(event.event, context);
    return new Response(null, { status: 204 });
  }

  if (isNatsWorkerInvocation(event)) {
    await handleNatsWorkerRequest(event.event, context);
    return new Response(null, { status: 204 });
  }

  if (isCronInvocation(event)) {
    await handleScheduledCron(event);
    return new Response(null, { status: 204 });
  }

  if (event.path === "/v1/cron-runs") {
    return handleCronHttpRequest(event);
  }

  return routeIncomingEvent(
    event,
    {
      handleDirectRequest: (directEvent) =>
        handleDirectRequest(directEvent, context),
      handleAsyncRequest,
      handleStatusRequest,
      handleAsyncToolCompletionRequest,
      handleSandboxJobCompletionRequest,
      handleChannelRequest: (channelEvent) =>
        handleChannelRequest(channelEvent, context),
      handleChannelContext,
    },
    {
      directApiEnabled: ENABLE_DIRECT_API,
      ...(context?.waitUntil ? { waitUntil: context.waitUntil } : {}),
    },
  );
}

async function handleCronHttpRequest(request: CoreRequest): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(405, "Method not allowed", {
      method: request.method,
      allowedMethods: ["POST"],
    });
  }

  const serviceSecret = optionalEnv("SERVICE_AUTH_SECRET");
  const token = extractBearerToken(request.headers.authorization);
  if (
    !serviceSecret ||
    !token ||
    !timingSafeStringEqual(token, serviceSecret)
  ) {
    return errorResponse(401, "Unauthorized");
  }

  let payload: unknown;
  try {
    payload = parseJsonBody(request);
  } catch (err) {
    return errorResponse(
      400,
      err instanceof Error ? err.message : "Invalid request JSON",
    );
  }
  if (!isCronInvocation(payload)) {
    return errorResponse(400, "Invalid cron invocation");
  }

  await handleScheduledCron(payload);
  return new Response(null, { status: 204 });
}

/**
 * Handle scheduled cron jobs invoked by EventBridge Scheduler.
 */
async function handleScheduledCron(event: CronInvocation): Promise<void> {
  const crons = getStorage().crons;
  const job = await crons.getById(event.accountId, event.cronId);
  if (!job) {
    logInfo("Cron job skipped because it no longer exists", {
      accountId: event.accountId,
      cronId: event.cronId,
    });
    return;
  }
  if (job.status !== "active") {
    logInfo("Cron job skipped because it is paused", {
      accountId: event.accountId,
      cronId: event.cronId,
    });
    return;
  }

  await crons.markStarted(job.accountId, job.cronId);

  try {
    const result = await startScheduledAgentRun(job);
    logInfo("Cron agent run invoked", {
      accountId: job.accountId,
      cronId: job.cronId,
      agentId: job.agentId,
      eventId: result.eventId,
      conversationKey: result.conversationKey,
    });
    await crons.markCompleted(job.accountId, job.cronId);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logError("Cron agent run failed", {
      accountId: job.accountId,
      cronId: job.cronId,
      agentId: job.agentId,
      error,
    });
    await crons.markFailed(job.accountId, job.cronId, error);
    throw err;
  }
}

/**
 * Handle the account-auth async tool result completion request.
 * Requires account-scoped authentication and agent validation.
 */
async function handleAsyncToolCompletionRequest(
  event: AsyncToolCompletionInboundEvent,
): Promise<Response> {
  // Check for existing
  const existing = await getAsyncToolResult(event.resultId);
  if (!existing) {
    return jsonResponse(404, { error: "Async tool result not found" });
  }

  // Check the event is for the same account and agent
  const agentId = agentIdFromScopedKey(existing.parentEventId, event.accountId);
  if (
    !agentId ||
    !isAccountScopedKey(existing.conversationKey, event.accountId, agentId)
  ) {
    return jsonResponse(404, { error: "Async tool result not found" });
  }

  // Check if the result is already processed
  if (existing.status !== "processing") {
    return jsonResponse(409, {
      error: "Async tool result is already settled",
      status: existing.status,
    });
  }

  // Check if agent is valid
  const agent = await getStorage().agents.getById(event.accountId, agentId);
  if (!agent || agent.status !== "active") {
    return jsonResponse(404, { error: "Agent not found" });
  }

  // Settle the tool result
  const settled = await settleAsyncToolResultFromCallback({
    resultId: event.resultId,
    status: event.status,
    ...(event.response !== undefined ? { response: event.response } : {}),
    ...(event.error ? { error: event.error } : {}),
  });
  if (!settled) {
    return jsonResponse(409, { error: "Async tool result settled got error" });
  }

  return continuationResponse(
    settled,
    await continueAfterAsyncToolSettlement(settled),
  );
}

/**
 * Handle a background-job completion posted by the detached job itself.
 * Authenticated by the per-job token (matched against the stored row), so the
 * sandbox never needs an account secret. Reuses the same settle → continuation
 * path as the account-auth async-tool completion endpoint.
 */
async function handleSandboxJobCompletionRequest(
  event: SandboxJobCompletionInboundEvent,
): Promise<Response> {
  const existing = await getAsyncToolResult(event.resultId);
  if (!existing) {
    return jsonResponse(404, { error: "Background job result not found" });
  }
  if (existing.status !== "processing") {
    return jsonResponse(409, {
      error: "Background job result is already settled",
      status: existing.status,
    });
  }

  // Missing/mismatched token reads as not-found so the endpoint is not a token oracle.
  if (!(await verifyAsyncToolCompletionToken(event.resultId, event.token))) {
    return jsonResponse(404, { error: "Background job result not found" });
  }

  const settled = await settleAsyncToolResultFromCallback({
    resultId: event.resultId,
    status: event.status,
    ...(event.response !== undefined ? { response: event.response } : {}),
    ...(event.error ? { error: event.error } : {}),
  });
  if (!settled) {
    return jsonResponse(409, {
      error: "Background job result is already settled",
    });
  }

  return continuationResponse(
    settled,
    await continueAfterAsyncToolSettlement(settled),
  );
}

/**
 * After a tool row settles, resume the conversation once every result in its
 * dispatch group is in. Derives the account/agent from the (scoped) parentEventId
 * so it serves both the account-authed and token-authed completion paths.
 */
async function continueAfterAsyncToolSettlement(
  settled: AsyncToolResultRecord,
): Promise<ContinuationOutcome> {
  const toolResults = await listCurrentParentToolResults(settled);
  const dispatchGroup = await getDetachedAsyncToolGroup(settled.parentEventId);
  const missingCount = Math.max(
    (dispatchGroup?.resultIds.length ?? 0) - toolResults.length,
    0,
  );
  const pendingCount =
    toolResults.filter((result) => result.status === "processing").length +
    missingCount;
  if (!dispatchGroup?.sealed || pendingCount > 0) {
    return {
      kind: "pending",
      pendingCount: dispatchGroup?.sealed
        ? pendingCount
        : Math.max(pendingCount, 1),
    };
  }

  const scope = parseAccountAgentFromScopedKey(settled.parentEventId);
  if (!scope) {
    return { kind: "skip" };
  }
  const agent = await getStorage().agents.getById(
    scope.accountId,
    scope.agentId,
  );
  if (!agent || agent.status !== "active") {
    return { kind: "skip" };
  }

  // Drop results the model already pulled via async_status; if everything in the
  // group was observed, there is nothing to deliver and no continuation to run.
  const events = settledToolResultsToParentMessages(toolResults);
  if (events.length === 0) {
    return { kind: "skip" };
  }

  const continuationEvent = {
    accountId: scope.accountId,
    agentId: scope.agentId,
    agentConfig: toRuntimeAgentConfig(agent.config),
    eventId: asyncToolContinuationEventId(settled.parentEventId),
    ...(settled.delivery?.kind === "async"
      ? { asyncResultEventId: settled.parentEventId }
      : {}),
    ...(settled.delivery?.kind === "channel"
      ? {
          replyTarget: {
            channelName: settled.delivery.channelName,
            source: settled.delivery.source,
          },
        }
      : {}),
    publicEventId: `async-tools-${settled.resultId}`,
    conversationKey: settled.conversationKey,
    publicConversationKey: eventPublicConversationKey(
      settled.conversationKey,
      scope.accountId,
      scope.agentId,
    ),
    events,
    requestedMode: "followup",
    idempotencyKey: asyncToolContinuationEventId(settled.parentEventId),
  } satisfies DirectInboundEvent;

  const ownedContinuation = await admitInternalContinuation(
    continuationEvent,
    continuationDelivery(continuationEvent),
  );
  if (!ownedContinuation) {
    return {
      kind: "ready",
      invoked: false,
      publicEventId: continuationEvent.publicEventId,
    };
  }
  await createPendingAsyncAgentResult({
    eventId: ownedContinuation.eventId,
    conversationKey: ownedContinuation.conversationKey,
  });
  await invokeAsyncToolContinuationWorker(ownedContinuation, settled);

  return {
    kind: "ready",
    invoked: true,
    publicEventId: continuationEvent.publicEventId,
  };
}

function continuationResponse(
  settled: AsyncToolResultRecord,
  outcome: ContinuationOutcome,
): Response {
  if (outcome.kind === "pending") {
    return jsonResponse(202, {
      status: "waiting_for_async_tools",
      resultId: settled.resultId,
      pendingCount: outcome.pendingCount,
    });
  }
  if (outcome.kind === "skip") {
    return jsonResponse(202, {
      status: "accepted",
      resultId: settled.resultId,
      invoked: false,
    });
  }
  return jsonResponse(202, {
    status: "accepted",
    resultId: settled.resultId,
    eventId: outcome.publicEventId,
    invoked: outcome.invoked,
  });
}

/**
 * Handle a direct SSE request.
 */
async function handleDirectRequest(
  event: DirectInboundEvent,
  context?: RequestContext,
): Promise<Response> {
  if (!hasRunnableDirectEvents(event)) {
    return emptySseResponse();
  }

  const delivery: IngressDelivery = event.connectionId
    ? {
        kind: "websocket",
        publicEventId: event.publicEventId,
        publicConversationKey: event.publicConversationKey,
        connectionId: event.connectionId,
        ...(directStatusUrl(event)
          ? { statusUrl: directStatusUrl(event)! }
          : {}),
      }
    : {
        kind: "http",
        publicEventId: event.publicEventId,
        publicConversationKey: event.publicConversationKey,
        ...(directStatusUrl(event)
          ? { statusUrl: directStatusUrl(event)! }
          : {}),
      };
  const admission = await acceptIngress({
    accountId: event.accountId,
    agentId: event.agentId,
    eventId: event.eventId,
    conversationKey: event.conversationKey,
    events: event.events,
    requestedMode: event.requestedMode,
    idempotencyKey: event.idempotencyKey,
    delivery: delivery,
    agentConfig: event.agentConfig,
    ...(event.ephemeralSystem
      ? { ephemeralSystem: event.ephemeralSystem }
      : {}),
  });
  await dispatchRecoveredIngress(event, admission);
  if (admission.outcome !== "owner") {
    return directAdmissionResponse(
      event,
      admission,
      Boolean(event.connectionId),
    );
  }
  const ownedEvent = {
    ...event,
    ownerGeneration: admission.ownerGeneration,
  };

  if (event.connectionId) {
    try {
      await invokeNatsWorker(ownedEvent);
    } catch (error) {
      await failOwnedIngress(
        ownedEvent,
        error instanceof Error
          ? error.message
          : "Failed to start WebSocket worker",
      );
      throw error;
    }

    return jsonResponse(202, {
      eventId: event.publicEventId,
      conversationKey: event.publicConversationKey,
      status: "processing",
      requestedMode: event.requestedMode,
      ...(directStatusUrl(event) ? { statusUrl: directStatusUrl(event) } : {}),
      nats: {
        accountId: event.accountId,
        agentId: event.agentId,
        conversationKey: event.publicConversationKey,
      },
    });
  }

  try {
    const turn = await prepareDirectTurn(ownedEvent);
    if (!turn) {
      return emptySseResponse();
    }

    const { session, turnContext } = turn;
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      await session
        .settleIngress("failed", {
          error: "Request did not produce pending model input",
        })
        .catch(() => {});
      await session.releaseConversationLease().catch(() => {});
      return emptySseResponse();
    }

    return new Response(
      createDirectContinuationSseBody(
        ownedEvent,
        session,
        turnContext,
        context,
      ),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  } catch (err) {
    logError("Direct request pre-processing failed", {
      eventId: event.eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Handle a direct async request.
 * Return a 202 Accepted response and trigger an in-process async worker.
 */
async function handleAsyncRequest(
  event: AsyncDirectInboundEvent,
): Promise<Response> {
  if (!hasRunnableDirectEvents(event)) {
    return errorResponse(
      400,
      "Request must include at least one user event or tool approval response",
    );
  }

  const admission = await acceptIngress({
    accountId: event.accountId,
    agentId: event.agentId,
    eventId: event.eventId,
    conversationKey: event.conversationKey,
    events: event.events,
    requestedMode: event.requestedMode,
    idempotencyKey: event.idempotencyKey,
    delivery: {
      kind: "async",
      publicEventId: event.publicEventId,
      publicConversationKey: event.publicConversationKey,
      statusUrl: event.statusUrl,
    },
    agentConfig: event.agentConfig,
    ...(event.ephemeralSystem
      ? { ephemeralSystem: event.ephemeralSystem }
      : {}),
  });
  await dispatchRecoveredIngress(event, admission);
  if (admission.outcome !== "owner") {
    return asyncAdmissionResponse(event, admission);
  }
  const ownedEvent = {
    ...event,
    ownerGeneration: admission.ownerGeneration,
  };

  const created = await createPendingAsyncAgentResult({
    eventId: event.eventId,
    conversationKey: event.conversationKey,
  });

  if (created) {
    try {
      await invokeAsyncWorker(ownedEvent);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start async worker";
      logError("Failed to invoke async worker", {
        eventId: event.eventId,
        error: message,
      });
      await settleAsyncFailure(event, message);
      await failOwnedIngress(ownedEvent, message);
    }
  }

  return acceptedAsyncResponse(event.statusUrl, event, "processing");
}

/**
 * Handle an in-process async worker request.
 * Publish the final result into storage.
 */
async function handleAsyncWorkerRequest(
  event: DirectInboundEvent,
  context?: RequestContext,
): Promise<void> {
  let session: Session | undefined;
  let transferred = false;
  try {
    await createPendingAsyncAgentResult({
      eventId: event.asyncResultEventId ?? event.eventId,
      conversationKey: event.conversationKey,
    });

    const turn = await prepareDirectTurn(event);
    if (!turn) {
      return;
    }

    ({ session } = turn);
    const { turnContext } = turn;
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      await settleAsyncFailure(
        event,
        "Request did not produce pending model input",
      );
      await session.settleIngress("failed", {
        error: "Request did not produce pending model input",
      });
      transferred = await dispatchNextIngress(session, event);
      return;
    }

    let didSettle = false;
    let terminalSettled = false;
    let result: Awaited<ReturnType<typeof runAgentLoopUntilSubagentsIdle>>;
    result = await runAgentLoopUntilSubagentsIdle(
      session,
      turnContext,
      event.agentConfig,
      context,
      {
        onFinalText: async (response, traceId) => {
          didSettle = true;
          terminalSettled = true;
          await session!.settleIngress("completed", { result: response });
          await Promise.all(
            asyncResultEventIds(event).map((eventId) =>
              markAsyncAgentResultCompleted({
                eventId: eventId,
                response: response,
              }),
            ),
          );
          if (event.cronRun) {
            await getStorage().crons.completeRun(
              event.accountId,
              event.cronRun.cronId,
              event.cronRun.runId,
              response,
            );
          }
          await pushReplyToChannel(
            session!,
            event,
            formatChannelFinalText(
              typeof response === "string"
                ? response
                : JSON.stringify(response, null, 2),
              traceId,
              event,
            ),
          );
        },
        onErrorText: async (error, traceId) => {
          didSettle = true;
          terminalSettled = true;
          await session!.settleIngress("failed", { error: error });
          await settleAsyncFailure(event, error);
          if (event.cronRun) {
            await getStorage().crons.failRun(
              event.accountId,
              event.cronRun.cronId,
              event.cronRun.runId,
              error,
            );
          }
          await pushReplyToChannel(
            session!,
            event,
            formatChannelFinalText(
              formatChannelErrorText(error),
              traceId,
              event,
            ),
          );
        },
        onApprovalRequired: async (approvals) => {
          await Promise.all(
            asyncResultEventIds(event).map((eventId) =>
              markAsyncAgentResultAwaitingApproval({
                eventId,
                approvals,
              }),
            ),
          );
          didSettle = true;
          terminalSettled = true;
          await session!.settleIngress("completed", {
            result: { status: "awaiting_approval", approvals },
          });
        },
      },
    );

    if (result.didFail && !didSettle) {
      terminalSettled = true;
      await session
        .settleIngress("failed", {
          error: result.failureText ?? AGENT_PROCESSING_FAILED,
        })
        .catch(() => {});
      await settleAsyncFailure(
        event,
        result.failureText ?? AGENT_PROCESSING_FAILED,
      );
      if (event.cronRun) {
        await getStorage().crons.failRun(
          event.accountId,
          event.cronRun.cronId,
          event.cronRun.runId,
          result.failureText ?? AGENT_PROCESSING_FAILED,
        );
      }
    }
    if (result.hasDetachedCallbacks) {
      await continueDetachedAsyncToolsIfReady(event, event.agentConfig);
      await session.settleIngress("completed", {
        result: { status: "waiting_for_async_tools" },
      });
      transferred = await dispatchNextIngress(session, event);
    } else if (terminalSettled) {
      transferred = await dispatchNextIngress(session, event);
    }
  } catch (err) {
    if (session) {
      const error = err instanceof Error ? err.message : "Async request failed";
      await session.settleIngress("failed", { error: error }).catch(() => {});
      transferred = await dispatchNextIngress(session, event).catch(
        () => false,
      );
    }

    logError("Async direct request processing failed", {
      eventId: event.eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    await settleAsyncFailure(
      event,
      err instanceof Error ? err.message : "Async request failed",
    );
    if (event.cronRun) {
      await getStorage().crons.failRun(
        event.accountId,
        event.cronRun.cronId,
        event.cronRun.runId,
        err instanceof Error ? err.message : "Async request failed",
      );
    }
    throw err;
  } finally {
    if (session && !transferred) {
      await session.releaseConversationLease().catch(() => {});
    }
  }
}

/**
 * Handle an in-process NATS worker request.
 * Publish the streaming event to NATS subject.
 */
async function handleNatsWorkerRequest(
  event: DirectInboundEvent,
  context?: RequestContext,
): Promise<void> {
  if (!hasRunnableDirectEvents(event)) {
    return;
  }
  if (!ENABLE_WEBSOCKET) {
    throw new Error("NATS worker requires ENABLE_WEBSOCKET=true");
  }
  const connectionId = event.connectionId?.trim();
  if (!connectionId) {
    throw new Error("NATS worker event must include connectionId");
  }
  const natsUrl = process.env.NATS_URL?.trim();
  if (!natsUrl) {
    throw new Error("NATS worker requires NATS_URL");
  }
  const natsToken = process.env.NATS_TOKEN?.trim() || undefined;

  const publisher = new LiveNatsPublisher(
    natsUrl,
    {
      accountId: event.accountId,
      agentId: event.agentId,
      conversationKey: event.publicConversationKey,
      eventId: event.publicEventId,
      connectionId,
    },
    natsToken,
  );

  let session: Session | undefined;
  let transferred = false;
  try {
    const turn = await prepareDirectTurn(event);
    if (!turn) {
      return;
    }

    ({ session } = turn);
    const { turnContext } = turn;
    const fencedPublisher: NatsPublisher = {
      publish: async (data) => {
        await session!.assertCurrentOwner();
        await publisher.publish(data);
      },
      close: () => publisher.close(),
    };
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      await session
        .settleIngress("failed", {
          error: "Request did not produce pending model input",
        })
        .catch(() => {});
      await session.releaseConversationLease().catch(() => {});
      return;
    }

    try {
      const subagentCoordinator = new SubagentCoordinator(
        session,
        event.agentConfig,
        waitUntilMs(context),
      );
      // Define the async tool mode application map.
      const asyncToolCoordinator = new AsyncToolCoordinator(
        session,
        waitUntilMs(context),
        {
          kind: "nats",
          connectionId,
          publicEventId: event.publicEventId,
          publicConversationKey: event.publicConversationKey,
        },
      );

      const result = await runParentContinuationLoop({
        session: session,
        subagentCoordinator: subagentCoordinator,
        asyncToolCoordinator: asyncToolCoordinator,
        initialTurnContext: turnContext,
        agentConfig: event.agentConfig,
        consumeStream: (stream) => pipeAgentNatsStream(stream, fencedPublisher),
        onLoopErrorText: async (error) => {
          fencedPublisher.publish({ type: "error", error }).catch(() => {});
        },
        onApprovalRequired: async (approvals) => {
          // The event also sends additional tool-approval-request so that the websocket gateway can easily
          // extract this data and do sth with it.
          // This is intentional (the user will receive the tool-approval-request event separately)
          fencedPublisher
            .publish({ type: "tool-approval-request", approvals })
            .catch(() => {});
        },
        onHeartbeat: (pendingCount) => {
          fencedPublisher
            .publish({
              type: "waiting",
              reason: "in-process-async-work",
              pendingCount,
            })
            .catch(() => {});
        },
      });

      if (result.didFail) {
        await session.settleIngress("failed", {
          error: result.failureText ?? AGENT_PROCESSING_FAILED,
        });
      } else if (
        result.approvals.length === 0 &&
        !asyncToolCoordinator.hasDetachedCallbacks
      ) {
        await session.settleIngress("completed", {
          ...(result.finalResponse !== undefined
            ? { result: result.finalResponse }
            : {}),
        });
      }

      if (asyncToolCoordinator.hasDetachedCallbacks) {
        await sealDetachedAsyncToolGroup(event.eventId);
        await continueDetachedAsyncToolsIfReady(event, event.agentConfig);
        await session.settleIngress("completed", {
          result: { status: "waiting_for_async_tools" },
        });
        await fencedPublisher.publish({
          type: "waiting",
          reason: "detached-async-tools",
        });
        transferred = await dispatchNextIngress(session, event);
      } else {
        if (result.approvals.length > 0) {
          await session.settleIngress("completed", {
            result: {
              status: "awaiting_approval",
              approvals: result.approvals,
            },
          });
        }
        await fencedPublisher.publish({ type: "done" });
        transferred = await dispatchNextIngress(session, event);
      }
      // Release here, not in the finally: the crash path must settle the
      // envelope first, and settling requires still holding the lease.
      if (!transferred) {
        await session.releaseConversationLease().catch(() => {});
      }
    } finally {
      await publisher.close();
    }
  } catch (err) {
    await publisher.close().catch(() => {});
    // Terminal settlement on the crash path: without it the envelope stays
    // processing and the queue never drains for this conversation.
    if (session && !transferred) {
      const error =
        err instanceof Error ? err.message : "NATS worker processing failed";
      await session.settleIngress("failed", { error: error }).catch(() => {});
      transferred = await dispatchNextIngress(session, event).catch(
        () => false,
      );
      if (!transferred) {
        await session.releaseConversationLease().catch(() => {});
      }
    }
    logError("NATS worker processing failed", {
      eventId: event.eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Handle an integration channel webhook request.
 * Publish the final result back to the channel integration sendText() function.
 */
async function handleChannelRequest(
  event: ChannelInboundEvent,
  context?: RequestContext,
): Promise<void> {
  if (event.commandToken) {
    const queueMessageText =
      event.commandToken === "/queue"
        ? extractText(event.content)
            .replace(/^\/queue(?:\s+|$)/i, "")
            .trim()
        : "";
    if (event.commandToken === "/steer") {
      const text = extractText(event.content)
        .replace(/^\/steer(?:\s+|$)/i, "")
        .trim();
      if (!text) {
        await event.channel.sendText("Usage: /steer <message>");
        return;
      }
      event = {
        ...event,
        content: text,
        events: rewriteLatestUserIngressText(event.events, text),
      };
    } else if (queueMessageText) {
      event = {
        ...event,
        content: queueMessageText,
        events: rewriteLatestUserIngressText(event.events, queueMessageText),
      };
    } else {
      logInfo("Channel command executing", {
        channel: event.channelName,
        accountId: event.accountId,
        agentId: event.agentId,
        eventId: event.eventId,
        conversationKey: event.conversationKey,
        commandToken: event.commandToken,
      });
      await executeCommand(event.commandToken, {
        conversationKey: event.conversationKey,
        channel: event.channel,
        accountId: event.accountId,
        agentId: event.agentId,
        eventId: event.eventId,
        text: commandText(event.commandToken, extractText(event.content)),
      });
      return;
    }
  }

  if (!event.accountId || !event.agentId) {
    throw new Error("Channel ingress requires account and agent scope");
  }
  const requestedMode = event.commandToken === "/queue" ? "followup" : "steer";
  const admission = await acceptIngress({
    accountId: event.accountId,
    agentId: event.agentId,
    eventId: event.eventId,
    conversationKey: event.conversationKey,
    events: event.events,
    requestedMode: requestedMode,
    idempotencyKey: event.eventId,
    delivery: {
      kind: "channel",
      channel: event.channelName,
      source: event.source,
    },
    agentConfig: event.agentConfig ?? {},
  });
  await dispatchRecoveredIngress(
    {
      accountId: event.accountId,
      agentId: event.agentId,
      agentConfig: event.agentConfig ?? {},
      conversationKey: event.conversationKey,
      publicConversationKey: eventPublicConversationKey(
        event.conversationKey,
        event.accountId,
        event.agentId,
      ),
      endpointId: event.endpointId,
      projectSlug: event.projectSlug,
      environmentSlug: event.environmentSlug,
    },
    admission,
  );
  if (admission.outcome === "rejected") {
    await event.channel.sendText(CONVERSATION_BUSY);
    return;
  }
  if (admission.outcome === "capacity") {
    await event.channel.sendText(
      "The conversation queue is full. Please try again later.",
    );
    return;
  }
  if (admission.outcome === "conflict") {
    await event.channel.sendText(
      "This message conflicts with an earlier delivery identity.",
    );
    return;
  }
  if (admission.outcome === "duplicate" || admission.outcome === "queued") {
    logInfo("Channel ingress durably queued", {
      channel: event.channelName,
      eventId: admission.eventId ?? event.eventId,
      conversationKey: event.conversationKey,
      requestedMode: requestedMode,
      status: admission.status ?? "queued",
    });
    return;
  }
  if (admission.ownerGeneration === undefined) {
    throw new Error("Channel admission did not return an owner generation");
  }

  let session = new Session(
    event.eventId,
    event.conversationKey,
    event.accountId,
    event.agentId,
    event.agentConfig ?? {},
    { kind: "channel", channelName: event.channelName, source: event.source },
    event.endpointId,
    event.projectSlug,
    event.environmentSlug,
    admission.ownerGeneration,
  );
  let incoming: ConversationIngressEvent[] = event.events;
  let incomingEphemeral: SystemModelMessage[] = [];
  let activeConfig = event.agentConfig ?? {};
  let released = false;
  const hooks = await createAgentHookDispatcher(
    event.accountId,
    event.agentConfig ?? {},
  );

  try {
    while (true) {
      // A thrown turn must still settle its envelope terminally before the
      // queue drains on; otherwise accepted work is stranded in processing.
      try {
        const ephemeralSystem = await session.appendIngressEvents(incoming);
        ephemeralSystem.push(...incomingEphemeral);
        const turnContext = await session.createTurnContext(ephemeralSystem);
        if (!isRunnableModelInput(turnContext.messages.at(-1))) {
          await session.settleIngress("failed", {
            error: "Request did not produce pending model input",
          });
        } else {
          let terminal: "completed" | "failed" | null = null;
          let finalResult: JSONValue | undefined;
          let approvalRequired = false;
          let streamed = false;
          const result = await runAgentLoopUntilSubagentsIdle(
            session,
            turnContext,
            activeConfig,
            context,
            {
              ...(event.channel.stream
                ? {
                    streamMessage: async (stream) => {
                      await session.assertCurrentOwner();
                      const streamedResult = await event.channel.stream!(
                        readAgentFullStream(stream),
                      );
                      streamed = Boolean(streamedResult);
                      if (!streamed) await stream.consumeStream();
                    },
                  }
                : {}),
              onFinalText: async (response, traceId) => {
                await session.assertCurrentOwner();
                terminal = "completed";
                finalResult = response;
                if (streamed && typeof response === "string") return;
                const formatted = formatChannelFinalText(
                  typeof response === "string"
                    ? response
                    : JSON.stringify(response, null, 2),
                  traceId,
                  event,
                );
                const text = await applyMessageSendingHook(
                  hooks,
                  event.channelName,
                  formatted,
                );
                if (text !== null) await event.channel.sendText(text);
              },
              onErrorText: async (error, traceId) => {
                await session.assertCurrentOwner();
                terminal = "failed";
                await event.channel.sendText(
                  formatChannelFinalText(
                    formatChannelErrorText(error),
                    traceId,
                    event,
                  ),
                );
              },
              onApprovalRequired: async (approvals) => {
                approvalRequired = true;
                await session.persistModelMessages([
                  createChannelApprovalDenial(approvals),
                ]);
              },
            },
            hooks,
          );
          if (approvalRequired) {
            incoming = [];
            incomingEphemeral = [];
            continue;
          }
          if (result.didFail) terminal = "failed";
          if (terminal === "failed") {
            await session.settleIngress("failed", {
              error: result.failureText ?? AGENT_PROCESSING_FAILED,
            });
          } else if (terminal === "completed") {
            await session.settleIngress("completed", {
              ...(finalResult !== undefined ? { result: finalResult } : {}),
            });
          } else if (result.hasDetachedCallbacks) {
            await session.settleIngress("completed", {
              result: { status: "waiting_for_async_tools" },
            });
          }
        }
      } catch (err) {
        logError("Channel turn failed", {
          eventId: session.eventId,
          conversationKey: session.conversationKey,
          error: err instanceof Error ? err.message : String(err),
        });
        await session
          .settleIngress("failed", {
            error: err instanceof Error ? err.message : "Channel turn failed",
          })
          .catch(() => {});
      }

      const next = await session.takeNextIngress();
      if (!next) {
        await session.releaseConversationLease();
        released = true;
        return;
      }
      const source =
        next.delivery.kind === "channel"
          ? (next.delivery.source ?? event.source)
          : event.source;
      activeConfig = next.agentConfig ?? event.agentConfig ?? {};
      session = new Session(
        next.eventId,
        event.conversationKey,
        event.accountId,
        event.agentId,
        activeConfig,
        { kind: "channel", channelName: event.channelName, source: source },
        event.endpointId,
        event.projectSlug,
        event.environmentSlug,
        next.ownerGeneration,
      );
      incoming = next.events as ConversationIngressEvent[];
      incomingEphemeral = next.ephemeralSystem ?? [];
    }
  } finally {
    if (!released) {
      await session.releaseConversationLease().catch(() => {});
    }
  }
}

function commandText(commandToken: string, content: string): string {
  const trimmed = content.trim();
  return trimmed.toLowerCase().startsWith(commandToken.toLowerCase())
    ? trimmed
    : `${commandToken} ${trimmed}`.trim();
}

async function handleChannelContext(event: ChannelContextEvent): Promise<void> {
  const session = new Session(
    event.eventId,
    event.conversationKey,
    event.accountId,
    event.agentId,
    event.agentConfig ?? {},
    undefined,
    event.endpointId,
    event.projectSlug,
    event.environmentSlug,
  );
  logInfo("Channel context received", {
    channel: event.channelName,
    accountId: event.accountId,
    agentId: event.agentId,
    eventId: session.eventId,
    conversationKey: session.conversationKey,
    source: event.source,
  });

  if (!(await claimSession(session))) {
    logInfo("Channel context already claimed", {
      channel: event.channelName,
      accountId: event.accountId,
      agentId: event.agentId,
      eventId: session.eventId,
      conversationKey: session.conversationKey,
    });
    return;
  }

  await session.appendIngressEvents(event.events);
  logInfo("Channel context persisted", {
    channel: event.channelName,
    accountId: event.accountId,
    agentId: event.agentId,
    eventId: session.eventId,
    conversationKey: session.conversationKey,
  });
}

/**
 * Handle a status request.
 */
async function handleStatusRequest(
  event: StatusInboundEvent,
): Promise<Response> {
  const [result, asyncResult] = await Promise.all([
    getIngressStatus({
      accountId: event.accountId,
      agentId: event.agentId,
      eventId: event.eventId,
    }),
    getAsyncAgentResult(event.eventId),
  ]);
  if (!result && !asyncResult) {
    return jsonResponse(404, {
      eventId: event.publicEventId,
      status: "not_found",
    });
  }

  // The async agent record keeps the public approval contract: while it is
  // nonterminal its status (processing/awaiting_approval) overrides the
  // envelope's terminal settle so pollers keep waiting and see approvals
  // top-level, exactly as before durable ingress statuses existed.
  const status =
    asyncResult &&
    (asyncResult.status === "awaiting_approval" ||
      (asyncResult.status === "processing" && result?.status !== "failed"))
      ? asyncResult.status
      : (result?.status ?? asyncResult!.status);
  const conversationKey =
    result?.conversationKey ?? asyncResult!.conversationKey;

  return jsonResponse(200, {
    eventId: event.publicEventId,
    conversationKey: eventPublicConversationKey(
      conversationKey,
      event.accountId,
      event.agentId,
    ),
    status: status,
    ...(result?.requestedMode !== undefined
      ? { requestedMode: result.requestedMode }
      : {}),
    ...(result?.appliedMode !== undefined
      ? { appliedMode: result.appliedMode }
      : {}),
    ...(result?.appliedToEventId !== undefined
      ? {
          appliedToEventId: publicEventIdForScope(
            result.appliedToEventId,
            event.accountId,
            event.agentId,
            event.publicEventId,
          ),
        }
      : {}),
    ...(result?.result !== undefined ? { result: result.result } : {}),
    ...(asyncResult?.response !== undefined
      ? { response: asyncResult.response }
      : {}),
    ...(asyncResult?.approvals !== undefined
      ? { approvals: asyncResult.approvals }
      : {}),
    ...((result?.error ?? asyncResult?.error)
      ? { error: result?.error ?? asyncResult?.error }
      : {}),
  });
}

async function prepareDirectTurn(
  event: DirectInboundEvent,
): Promise<DirectTurn | null> {
  // A WebSocket-origin turn carries a connectionId; a background job it launches
  // republishes to the durable conversation stream so a reconnecting client
  // replays it. Plain direct/async API turns have no delivery target (poll only).
  const delivery: AsyncToolDelivery | undefined = event.connectionId
    ? {
        kind: "nats",
        connectionId: event.connectionId,
        publicEventId: event.publicEventId,
        publicConversationKey: event.publicConversationKey,
      }
    : undefined;
  if (event.ownerGeneration === undefined) {
    throw new Error("Direct turn is missing its durable owner generation");
  }
  const session = new Session(
    event.eventId,
    event.conversationKey,
    event.accountId,
    event.agentId,
    event.agentConfig,
    delivery,
    event.endpointId,
    event.projectSlug,
    event.environmentSlug,
    event.ownerGeneration,
  );
  try {
    const ephemeralSystem = await session.appendIngressEvents(event.events);
    if (event.ephemeralSystem) {
      ephemeralSystem.push(...event.ephemeralSystem);
    }
    const turnContext = await session.createTurnContext(ephemeralSystem);
    return { session, turnContext };
  } catch (err) {
    await session
      .settleIngress("failed", {
        error:
          err instanceof Error ? err.message : "Direct turn preparation failed",
      })
      .catch(() => {});
    await session.releaseConversationLease().catch(() => {});
    throw err;
  }
}

async function failOwnedIngress(
  event: DirectInboundEvent,
  error: string,
): Promise<void> {
  if (event.ownerGeneration === undefined) return;
  const session = new Session(
    event.eventId,
    event.conversationKey,
    event.accountId,
    event.agentId,
    event.agentConfig,
    event.connectionId
      ? {
          kind: "nats",
          connectionId: event.connectionId,
          publicEventId: event.publicEventId,
          publicConversationKey: event.publicConversationKey,
        }
      : undefined,
    event.endpointId,
    event.projectSlug,
    event.environmentSlug,
    event.ownerGeneration,
  );
  await session.settleIngress("failed", { error }).catch(() => {});
  await session.releaseConversationLease().catch(() => {});
}

async function claimSession(session: Session): Promise<boolean> {
  if (!(await session.claim())) {
    logInfo("Duplicate event skipped", { eventId: session.eventId });
    return false;
  }

  return true;
}

async function settleAsyncFailure(
  event: DirectInboundEvent,
  error: string,
): Promise<void> {
  await Promise.all(
    asyncResultEventIds(event).map((eventId) =>
      markAsyncAgentResultFailed({
        eventId,
        error,
      }),
    ),
  );
}

function formatChannelFinalText(
  text: string,
  traceId: string | undefined,
  event: Pick<
    DirectInboundEvent | ChannelInboundEvent,
    "projectSlug" | "environmentSlug"
  >,
): string {
  const link = dashboardTraceUrl(traceId, event);
  if (!link) {
    return text;
  }

  return `${text.trim()}\n\nTrace: ${link}`;
}

function dashboardTraceUrl(
  traceId: string | undefined,
  event: Pick<
    DirectInboundEvent | ChannelInboundEvent,
    "projectSlug" | "environmentSlug"
  >,
): string | null {
  if (!traceId || !event.projectSlug || !event.environmentSlug) {
    return null;
  }
  const dashboardUrl = (
    process.env.BROODS_DASHBOARD_URL ??
    process.env.DASHBOARD_URL ??
    DEFAULT_DASHBOARD_URL
  ).replace(/\/+$/, "");
  const params = new URLSearchParams({
    project: event.projectSlug,
    env: event.environmentSlug,
    tab: "tracing",
    trace: traceId,
  });

  return `${dashboardUrl}?${params.toString()}`;
}

/**
 * Push a continuation's final text back to the chat channel it came from (a
 * background job launched from Telegram/Slack/etc.). Best-effort: the row is
 * already settled, so a delivery failure is logged, not thrown.
 */
async function pushReplyToChannel(
  session: Session,
  event: DirectInboundEvent,
  text: string,
): Promise<void> {
  if (!event.replyTarget) {
    return;
  }
  try {
    await session.assertCurrentOwner();
    await sendChannelReply({
      config: event.agentConfig,
      accountId: event.accountId,
      channelName: event.replyTarget.channelName,
      source: event.replyTarget.source,
      text,
    });
  } catch (err) {
    logError("Background job channel reply failed", {
      eventId: event.eventId,
      channelName: event.replyTarget.channelName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Dispatches an in-process harness worker for a direct API async request.
 * Used for background processing of non-streaming requests.
 */
async function invokeAsyncWorker(event: DirectInboundEvent): Promise<void> {
  await invokeHarnessWorker({
    kind: "direct-api-async-worker",
    event,
  } satisfies AsyncWorkerInvocation);
}

/**
 * Invokes the appropriate worker (NATS or async) to continue processing after async tool completion.
 * Routes to NATS worker if the original request was a WebSocket connection, otherwise uses async worker.
 */
async function invokeAsyncToolContinuationWorker(
  event: DirectInboundEvent,
  settled: AsyncToolResultRecord,
): Promise<void> {
  if (settled.delivery?.kind === "nats") {
    await invokeNatsWorker({
      ...event,
      publicEventId: settled.delivery.publicEventId,
      publicConversationKey: settled.delivery.publicConversationKey,
      connectionId: settled.delivery.connectionId,
    });
    return;
  }

  await invokeAsyncWorker(event);
}

/**
 * Dispatches an in-process harness worker for NATS-based WebSocket streaming.
 * Used for real-time streaming responses to connected clients.
 */
async function invokeNatsWorker(event: DirectInboundEvent): Promise<void> {
  await invokeHarnessWorker({
    kind: "nats-worker",
    event,
  } satisfies NatsWorkerInvocation);
}

/** Transfers the fenced owner to the next durable FIFO application and schedules it. */
async function dispatchNextIngress(
  session: Session,
  previous: DirectInboundEvent,
): Promise<boolean> {
  const next = await session.takeNextIngress();
  if (!next) return false;
  await dispatchAppliedIngress(previous, next);

  return true;
}

/**
 * Schedules one durably applied envelope on its worker. The envelope's own
 * persisted agentConfig/ephemeralSystem win over the base event's so a queued
 * request never inherits a previous request's overrides.
 */
async function dispatchAppliedIngress(
  base: Pick<
    DirectInboundEvent,
    | "accountId"
    | "agentId"
    | "agentConfig"
    | "conversationKey"
    | "publicConversationKey"
    | "endpointId"
    | "projectSlug"
    | "environmentSlug"
  >,
  next: AppliedIngress,
): Promise<void> {
  const delivery = next.delivery;
  const publicEventId =
    delivery.kind === "channel" ? next.eventId : delivery.publicEventId;
  const publicConversationKey =
    delivery.kind === "channel"
      ? base.publicConversationKey
      : delivery.publicConversationKey;
  const event: DirectInboundEvent = {
    accountId: base.accountId,
    agentId: base.agentId,
    agentConfig: next.agentConfig ?? base.agentConfig,
    conversationKey: base.conversationKey,
    endpointId: base.endpointId,
    projectSlug: base.projectSlug,
    environmentSlug: base.environmentSlug,
    eventId: next.eventId,
    publicEventId: publicEventId,
    publicConversationKey: publicConversationKey,
    events: next.events as DirectInboundEvent["events"],
    requestedMode: next.requestedMode,
    idempotencyKey: next.eventId,
    ownerGeneration: next.ownerGeneration,
    ...(next.ephemeralSystem ? { ephemeralSystem: next.ephemeralSystem } : {}),
    ...(delivery.kind === "websocket"
      ? { connectionId: delivery.connectionId }
      : {}),
    ...(delivery.kind === "channel"
      ? {
          replyTarget: {
            channelName: delivery.channel,
            source: delivery.source ?? {},
          },
        }
      : {}),
  };
  try {
    if (delivery.kind === "websocket") {
      await invokeNatsWorker(event);
    } else {
      await createPendingAsyncAgentResult({
        eventId: event.eventId,
        conversationKey: event.conversationKey,
      });
      await invokeAsyncWorker(event);
    }
  } catch (error) {
    await failOwnedIngress(
      event,
      error instanceof Error
        ? error.message
        : "Failed to schedule queued ingress",
    );
    throw error;
  }
  logInfo("Queued ingress transferred to follow-up worker", {
    conversationKey: event.conversationKey,
    eventId: event.eventId,
    requestedMode: next.requestedMode,
    appliedMode: next.appliedMode,
    contributorCount: next.contributingEventIds.length,
  });
}

/**
 * Best-effort dispatch of an application that admission recovered from an
 * expired owner. Never throws: the caller's own admission response must win.
 */
async function dispatchRecoveredIngress(
  base: Parameters<typeof dispatchAppliedIngress>[0],
  admission: IngressAdmission,
): Promise<void> {
  if (!admission.recovered) return;
  try {
    await dispatchAppliedIngress(base, admission.recovered);
  } catch (error) {
    logError("Recovered ingress dispatch failed", {
      conversationKey: base.conversationKey,
      eventId: admission.recovered.eventId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Durably admits an internally generated continuation before scheduling it. */
async function admitInternalContinuation(
  event: DirectInboundEvent,
  delivery: IngressDelivery,
): Promise<DirectInboundEvent | null> {
  const admission = await acceptIngress({
    accountId: event.accountId,
    agentId: event.agentId,
    eventId: event.eventId,
    conversationKey: event.conversationKey,
    events: event.events,
    requestedMode: event.requestedMode,
    idempotencyKey: event.idempotencyKey,
    delivery: delivery,
    agentConfig: event.agentConfig,
    ...(event.ephemeralSystem
      ? { ephemeralSystem: event.ephemeralSystem }
      : {}),
  });
  await dispatchRecoveredIngress(event, admission);
  if (admission.outcome !== "owner") return null;
  if (admission.ownerGeneration === undefined) {
    throw new Error(
      "Continuation admission did not return an owner generation",
    );
  }

  return { ...event, ownerGeneration: admission.ownerGeneration };
}

/** Maps an existing run's delivery target onto the durable ingress envelope. */
function continuationDelivery(event: DirectInboundEvent): IngressDelivery {
  if (event.connectionId) {
    return {
      kind: "websocket",
      publicEventId: event.publicEventId,
      publicConversationKey: event.publicConversationKey,
      connectionId: event.connectionId,
      ...(directStatusUrl(event) ? { statusUrl: directStatusUrl(event)! } : {}),
    };
  }
  if (event.replyTarget) {
    return {
      kind: "channel",
      channel: event.replyTarget.channelName,
      source: event.replyTarget.source,
    };
  }
  const statusUrl =
    directStatusUrl(event) ??
    `/status/${encodeURIComponent(event.publicEventId)}?agentId=${encodeURIComponent(event.agentId)}`;

  return {
    kind: "async",
    publicEventId: event.publicEventId,
    publicConversationKey: event.publicConversationKey,
    statusUrl: statusUrl,
  };
}

/**
 * Dispatch a worker payload as fire-and-forget in-process background work — the
 * async fan-out runs in this process, not via a Lambda self-invoke.
 */
async function invokeHarnessWorker(
  payload: AsyncWorkerInvocation | NatsWorkerInvocation,
): Promise<void> {
  dispatchInProcessWorker(payload);
}

export function dispatchInProcessWorker(
  payload: AsyncWorkerInvocation | NatsWorkerInvocation,
  run: InProcessWorkerRun = handler,
): void {
  if (activeInProcessWorkers >= MAX_INPROCESS_WORKERS) {
    if (pendingWorkerPayloads.length >= MAX_PENDING_WORKER_PAYLOADS) {
      // Load-shed like a failed Lambda Event invoke: the awaiting caller
      // surfaces the error instead of the queue growing without bound.
      throw new Error("In-process worker queue is full");
    }
    pendingWorkerPayloads.push([payload, run]);
    return;
  }

  activeInProcessWorkers += 1;
  const execution = run(payload, {
    requestId: crypto.randomUUID(),
    deadlineMs: Date.now() + WORKER_TIMEOUT_BUDGET_MS,
    // Workers run detached; they never emit an HTTP response, so there is no
    // post-response tail to defer.
    waitUntil: () => {},
  }).then(
    () => undefined,
    (err) => {
      logError("In-process worker failed", {
        kind: payload.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );
  // Reclaim the slot when the worker finishes OR overruns its deadline. Unlike
  // Lambda, nothing here kills a hung model stream/tool, so without this a few
  // stuck workers would pin every slot and wedge async processing for all
  // tenants on the pod. An overrun leaves the underlying work running but frees
  // the slot (and unblocks shutdown drain).
  let slotTimer: ReturnType<typeof setTimeout> | undefined;
  const guarded = Promise.race([
    execution,
    new Promise<void>((resolve) => {
      slotTimer = setTimeout(() => {
        logError("In-process worker exceeded deadline; reclaiming slot", {
          kind: payload.kind,
          budgetMs: WORKER_TIMEOUT_BUDGET_MS,
        });
        resolve();
      }, WORKER_TIMEOUT_BUDGET_MS + WORKER_SLOT_GRACE_MS);
      slotTimer.unref?.();
    }),
  ]);
  const worker: Promise<void> = guarded.finally(() => {
    if (slotTimer) clearTimeout(slotTimer);
    activeInProcessWorkers -= 1;
    inProcessWorkers.delete(worker);
    const next = pendingWorkerPayloads.shift();
    if (next) {
      dispatchInProcessWorker(next[0], next[1]);
    }
  });
  inProcessWorkers.add(worker);
}

/** Awaited by the container bootstrap on shutdown so queued work is not lost. */
export async function drainInProcessWorkers(): Promise<void> {
  while (inProcessWorkers.size > 0) {
    await Promise.allSettled([...inProcessWorkers]);
  }
}

async function continueDetachedAsyncToolsIfReady(
  event: DirectInboundEvent,
  agentConfig: DirectInboundEvent["agentConfig"],
): Promise<boolean> {
  const dispatchGroup = await getDetachedAsyncToolGroup(event.eventId);
  if (!dispatchGroup?.sealed) {
    return false;
  }

  const toolResults = (
    await Promise.all(
      dispatchGroup.resultIds.map((resultId) => getAsyncToolResult(resultId)),
    )
  ).filter(
    (result): result is AsyncToolResultRecord =>
      result?.parentEventId === event.eventId,
  );
  if (
    toolResults.length !== dispatchGroup.resultIds.length ||
    toolResults.some((result) => result.status === "processing")
  ) {
    return false;
  }

  // Every result the model already saw via async_status is dropped here; if that
  // leaves nothing, there is no continuation to run (avoids a duplicate answer).
  const events = settledToolResultsToParentMessages(toolResults);
  if (events.length === 0) {
    return false;
  }

  const continuationEvent = {
    ...event,
    agentConfig,
    eventId: asyncToolContinuationEventId(event.eventId),
    ownerGeneration: undefined,
    requestedMode: "followup",
    idempotencyKey: asyncToolContinuationEventId(event.eventId),
    ...(event.connectionId
      ? {}
      : { asyncResultEventId: event.asyncResultEventId ?? event.eventId }),
    events,
  } satisfies DirectInboundEvent;

  const ownedContinuation = await admitInternalContinuation(
    continuationEvent,
    continuationDelivery(continuationEvent),
  );
  if (!ownedContinuation) {
    return false;
  }
  await createPendingAsyncAgentResult({
    eventId: ownedContinuation.eventId,
    conversationKey: ownedContinuation.conversationKey,
  });

  if (ownedContinuation.connectionId) {
    await invokeNatsWorker(ownedContinuation);
  } else {
    await invokeAsyncWorker(ownedContinuation);
  }
  return true;
}

function asyncToolContinuationEventId(parentEventId: string): string {
  return `${parentEventId}:async-tools`;
}

async function startScheduledAgentRun(
  job: CronRecord,
): Promise<{ eventId: string; conversationKey: string }> {
  const event = await createCronDirectEvent(job);
  const run = await getStorage().crons.createRun({
    accountId: job.accountId,
    cronId: job.cronId,
    eventId: event.publicEventId,
    conversationKey: event.publicConversationKey,
  });
  event.cronRun = { cronId: job.cronId, runId: run.runId };
  try {
    const ownedEvent = await admitInternalContinuation(
      event,
      continuationDelivery(event),
    );
    if (!ownedEvent) {
      throw new Error("Cron conversation is already processing another turn");
    }
    await createPendingAsyncAgentResult({
      eventId: ownedEvent.eventId,
      conversationKey: ownedEvent.conversationKey,
    });
    await invokeAsyncWorker(ownedEvent);
  } catch (err) {
    await getStorage().crons.failRun(
      job.accountId,
      job.cronId,
      run.runId,
      err instanceof Error ? err.message : "Failed to start cron async worker",
    );
    throw err;
  }

  return {
    eventId: event.publicEventId,
    conversationKey: event.publicConversationKey,
  };
}

async function createCronDirectEvent(
  job: CronRecord,
): Promise<DirectInboundEvent> {
  const agent = await getStorage().agents.getById(job.accountId, job.agentId);
  if (!agent || agent.status !== "active") {
    throw new Error(`Agent not found: ${job.agentId}`);
  }
  const deployment = await getStorage().agentDeployments.getByAgentId?.(
    job.accountId,
    job.agentId,
  );

  const publicEventId = `${job.cronId}-${crypto.randomUUID()}`;
  const publicConversationKey = job.conversationKey ?? `cron:${job.cronId}`;
  return {
    accountId: job.accountId,
    agentId: job.agentId,
    agentConfig: toRuntimeAgentConfig(agent.config),
    eventId: scopedDirectEventId(job.accountId, job.agentId, publicEventId),
    publicEventId,
    conversationKey: scopedDirectConversationKey(
      job.accountId,
      job.agentId,
      publicConversationKey,
    ),
    publicConversationKey,
    events: job.events as DirectInboundEvent["events"],
    requestedMode: "reject",
    idempotencyKey: publicEventId,
    ...(deployment
      ? {
          endpointId: deployment.endpointId,
          projectSlug: deployment.projectSlug,
          environmentSlug: deployment.environmentSlug,
        }
      : {}),
  } satisfies DirectInboundEvent;
}

async function listCurrentParentToolResults(
  settled: AsyncToolResultRecord,
): Promise<AsyncToolResultRecord[]> {
  const dispatchGroup = await getDetachedAsyncToolGroup(settled.parentEventId);
  const queried = dispatchGroup?.sealed
    ? (
        await Promise.all(
          dispatchGroup.resultIds.map((resultId) =>
            getAsyncToolResult(resultId),
          ),
        )
      ).filter(
        (result): result is AsyncToolResultRecord =>
          result?.parentEventId === settled.parentEventId,
      )
    : await listAsyncToolResultsByParentEvent(settled.parentEventId);
  const byResultId = new Map(
    queried.map((result) => [result.resultId, result]),
  );
  byResultId.set(settled.resultId, settled);

  const refreshed = await Promise.all(
    [...byResultId.values()].map(async (result) => {
      if (result.status !== "processing") {
        return result;
      }

      const latest = await getAsyncToolResult(result.resultId);
      return latest?.parentEventId === settled.parentEventId ? latest : result;
    }),
  );

  return refreshed;
}

function settledToolResultsToParentMessages(
  results: AsyncToolResultRecord[],
): DirectInboundEvent["events"] {
  return (
    results
      // Skip results the model already pulled via async_status — re-injecting them
      // would make the model answer the same completion twice.
      .filter(
        (result) =>
          (result.status === "completed" || result.status === "failed") &&
          result.observed !== true,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((result) =>
        completionToParentMessage({
          resultId: result.resultId,
          toolName: result.toolName,
          input: result.input,
          status: result.status === "completed" ? "completed" : "failed",
          ...(result.response !== undefined
            ? { response: result.response }
            : {}),
          ...(result.error ? { error: result.error } : {}),
        }),
      )
  );
}

function createDirectContinuationSseBody(
  event: DirectInboundEvent,
  session: Session,
  initialTurnContext: DirectTurn["turnContext"],
  context?: RequestContext,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    // This callback runs during stream consumption, after handler() has already
    // returned and its observability scope has closed, so open a fresh one here
    // to keep the continuation's redaction/routing tenant-private.
    start(controller) {
      return runWithObservabilityScope(async () => {
        const subagentCoordinator = new SubagentCoordinator(
          session,
          event.agentConfig,
          waitUntilMs(context),
        );
        const asyncToolCoordinator = new AsyncToolCoordinator(
          session,
          waitUntilMs(context),
        );
        let transferred = false;

        try {
          const result = await runParentContinuationLoop({
            session: session,
            subagentCoordinator: subagentCoordinator,
            asyncToolCoordinator: asyncToolCoordinator,
            initialTurnContext: initialTurnContext,
            agentConfig: event.agentConfig,
            consumeStream: (stream) =>
              pipeAgentSseStream(stream, controller, session),
            onHeartbeat: async (pendingCount) => {
              await session.assertCurrentOwner();
              controller.enqueue(
                textEncoder.encode(
                  `: waiting for async work pending=${pendingCount}\n\n`,
                ),
              );
            },
          });
          if (result.didFail) {
            await session.settleIngress("failed", {
              error: result.failureText ?? AGENT_PROCESSING_FAILED,
            });
            transferred = await dispatchNextIngress(session, event);
          } else if (
            result.approvals.length === 0 &&
            !result.hasDetachedCallbacks
          ) {
            await session.settleIngress("completed", {
              ...(result.finalResponse !== undefined
                ? { result: result.finalResponse }
                : {}),
            });
            transferred = await dispatchNextIngress(session, event);
          } else if (result.approvals.length > 0) {
            await session.settleIngress("completed", {
              result: {
                status: "awaiting_approval",
                approvals: result.approvals,
              },
            });
            transferred = await dispatchNextIngress(session, event);
          } else if (result.hasDetachedCallbacks) {
            await continueDetachedAsyncToolsIfReady(event, event.agentConfig);
            await session.settleIngress("completed", {
              result: { status: "waiting_for_async_tools" },
            });
            transferred = await dispatchNextIngress(session, event);
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          await session
            .settleIngress("failed", { error: error })
            .catch(() => {});
          logError("Direct continuation stream failed", {
            eventId: event.eventId,
            error,
          });
          await session
            .assertCurrentOwner()
            .then(() => {
              controller.enqueue(
                textEncoder.encode(
                  `data: ${JSON.stringify({ type: "error", error })}\n\n`,
                ),
              );
            })
            .catch(() => {});
        } finally {
          if (!transferred) {
            await session.releaseConversationLease().catch(() => {});
          }
          controller.close();
        }
      });
    },
  });
}

async function runAgentLoopUntilSubagentsIdle(
  session: Session,
  initialTurnContext: DirectTurn["turnContext"],
  agentConfig: DirectInboundEvent["agentConfig"],
  context: RequestContext | undefined,
  reply: {
    onFinalText(response: JSONValue, traceId?: string): Promise<void>;
    onErrorText(error: string, traceId?: string): Promise<void>;
    onApprovalRequired?(approvals: ToolApprovalSummary[]): Promise<void>;
    streamMessage?(stream: AgentLoopStream): Promise<void>;
  },
  hooks?: HookDispatcher,
): Promise<{
  didFail: boolean;
  failureText: string | null;
  hasDetachedCallbacks: boolean;
  traceId?: string;
}> {
  const subagentCoordinator = new SubagentCoordinator(
    session,
    agentConfig,
    waitUntilMs(context),
  );
  const asyncToolCoordinator = new AsyncToolCoordinator(
    session,
    waitUntilMs(context),
    session.delivery ?? { kind: "async" },
  );
  const result = await runParentContinuationLoop({
    session: session,
    subagentCoordinator: subagentCoordinator,
    asyncToolCoordinator: asyncToolCoordinator,
    initialTurnContext: initialTurnContext,
    agentConfig: agentConfig,
    ...(hooks ? { hooks } : {}),
    consumeStream:
      reply.streamMessage ??
      (async (stream) => {
        await stream.consumeStream();
      }),
  });
  const hasDetachedCallbacks = asyncToolCoordinator.hasDetachedCallbacks;
  if (hasDetachedCallbacks) {
    await sealDetachedAsyncToolGroup(session.eventId);
  }

  if (result.approvals.length > 0) {
    await reply.onApprovalRequired?.(result.approvals);
    return {
      didFail: false,
      failureText: null,
      hasDetachedCallbacks,
      ...(result.traceId ? { traceId: result.traceId } : {}),
    };
  }

  if (result.didFail) {
    await reply.onErrorText(
      result.failureText ?? AGENT_PROCESSING_FAILED,
      result.traceId,
    );
    return {
      didFail: true,
      failureText: result.failureText,
      hasDetachedCallbacks,
      ...(result.traceId ? { traceId: result.traceId } : {}),
    };
  }

  if (hasDetachedCallbacks) {
    return {
      didFail: false,
      failureText: null,
      hasDetachedCallbacks,
      ...(result.traceId ? { traceId: result.traceId } : {}),
    };
  }

  if (result.finalResponse !== undefined) {
    await reply.onFinalText(result.finalResponse, result.traceId);
  }

  return {
    didFail: false,
    failureText: null,
    hasDetachedCallbacks,
    ...(result.traceId ? { traceId: result.traceId } : {}),
  };
}

/**
 * Runs parent model passes until there is no runnable injected work.
 *
 * Heartbeats are emitted only while this request or worker waits on in-process
 * subagents, built-in async tools, or uploaded async tools on SSE. Detached
 * uploaded async tools do not add pending work here, so the request or worker can
 * return after sealing the group.
 */
async function runParentContinuationLoop(options: {
  session: Session;
  subagentCoordinator: SubagentCoordinator;
  asyncToolCoordinator: AsyncToolCoordinator;
  initialTurnContext: DirectTurn["turnContext"];
  agentConfig: DirectInboundEvent["agentConfig"];
  hooks?: HookDispatcher;
  consumeStream(stream: AgentLoopStream): Promise<void>;
  onLoopErrorText?(error: string): Promise<void>;
  onApprovalRequired?(approvals: ToolApprovalSummary[]): Promise<void>;
  onHeartbeat?(pendingCount: number): void;
}): Promise<ParentContinuationResult> {
  let turnContext = options.initialTurnContext;
  let finalResponse: JSONValue | undefined;
  let traceId: string | undefined;

  // One hook dispatcher for the whole parent request: every loop iteration and
  // the subagent-finish fire-points share a single ctx.state and one storage load.
  const hooks =
    options.hooks ??
    (await createAgentHookDispatcher(
      options.session.accountId,
      options.agentConfig,
    ));
  options.subagentCoordinator.attachHooks(hooks);

  while (true) {
    let approvals: ToolApprovalSummary[] = [];
    const stream = await runAgentLoop(
      options.session,
      turnContext,
      options.agentConfig,
      {
        onFinalText: async (response) => {
          finalResponse = response;
        },
        onErrorText: async (error) => {
          await options.onLoopErrorText?.(error);
        },
        onApprovalRequired: async (approvalSummaries) => {
          approvals = approvalSummaries;
          await options.onApprovalRequired?.(approvalSummaries);
        },
      },
      {
        dispatchSubagents: options.subagentCoordinator.dispatch,
        dispatchAsyncTools: options.asyncToolCoordinator.dispatch,
        hooks: hooks,
      },
    );
    traceId = stream.traceId();

    await options.consumeStream(stream);
    if (approvals.length > 0) {
      return {
        didFail: false,
        failureText: null,
        ...(finalResponse !== undefined ? { finalResponse } : {}),
        ...(traceId ? { traceId } : {}),
        approvals,
        hasDetachedCallbacks: options.asyncToolCoordinator.hasDetachedCallbacks,
      };
    }
    if (stream.didFail()) {
      // A failed parent pass may have already dispatched subagents in an earlier
      // step that are still running in the background. Wait for them to settle
      // before returning so each child finalizes — publishing AND flushing its
      // terminal span. Otherwise the abandoned children spin "running" forever in
      // the dashboard: their running span was stored durably, but the request or
      // worker returned before the terminal one was ever flushed. Bounded by the
      // same deadline budget as the success path.
      if (options.subagentCoordinator.pendingCount > 0) {
        await options.subagentCoordinator.waitForIdle({
          onHeartbeat: options.onHeartbeat,
        });
      }

      return {
        didFail: true,
        failureText: stream.failureText(),
        ...(finalResponse !== undefined ? { finalResponse } : {}),
        ...(traceId ? { traceId } : {}),
        approvals: [],
        hasDetachedCallbacks: options.asyncToolCoordinator.hasDetachedCallbacks,
      };
    }

    // Wait for any injected subagents or internal async tools to complete.
    const injected = await waitAndDrainAsyncWork(
      options.subagentCoordinator,
      options.asyncToolCoordinator,
      {
        onHeartbeat: options.onHeartbeat,
      },
    );
    if (injected === 0) {
      return {
        didFail: false,
        failureText: null,
        ...(finalResponse !== undefined ? { finalResponse } : {}),
        ...(traceId ? { traceId } : {}),
        approvals: [],
        hasDetachedCallbacks: options.asyncToolCoordinator.hasDetachedCallbacks,
      };
    }

    turnContext = await options.session.createTurnContext();
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      return {
        didFail: false,
        failureText: null,
        ...(finalResponse !== undefined ? { finalResponse } : {}),
        ...(traceId ? { traceId } : {}),
        approvals: [],
        hasDetachedCallbacks: options.asyncToolCoordinator.hasDetachedCallbacks,
      };
    }
  }
}

/**
 * Bridges one completed parent model pass to the next continuation pass.
 *
 * After the parent stream ends, subagent and async-tool results may already be
 * queued, still be running, or be absent. This helper waits for outstanding
 * in-process work, emits wait heartbeats while waiting, and injects
 * parent-visible completions plus timeout notices near the request or worker deadline.
 * Detached uploaded async tools do not add in-memory pending work, so waiting
 * here only holds the request or worker for subagents, built-in async tools, and uploaded
 * async tools on SSE.
 */
async function waitAndDrainAsyncWork(
  subagentCoordinator: SubagentCoordinator,
  asyncToolCoordinator: AsyncToolCoordinator,
  options: {
    onHeartbeat?: (pendingCount: number) => void;
  } = {},
): Promise<number> {
  if (
    subagentCoordinator.pendingCount === 0 &&
    asyncToolCoordinator.pendingCount === 0
  ) {
    const [subagentCount, asyncToolCount] = await Promise.all([
      subagentCoordinator.drainCompletionsToParent(),
      asyncToolCoordinator.drainCompletionsToParent(),
    ]);
    return subagentCount + asyncToolCount;
  }

  const [subagentStatus, asyncToolStatus] = await Promise.all([
    subagentCoordinator.waitForIdle({
      onHeartbeat: () =>
        options.onHeartbeat?.(
          subagentCoordinator.pendingCount + asyncToolCoordinator.pendingCount,
        ),
    }),
    asyncToolCoordinator.waitForIdle({
      onHeartbeat: () =>
        options.onHeartbeat?.(
          subagentCoordinator.pendingCount + asyncToolCoordinator.pendingCount,
        ),
    }),
  ]);

  if (subagentStatus === "idle" && asyncToolStatus === "idle") {
    const [subagentCount, asyncToolCount] = await Promise.all([
      subagentCoordinator.drainCompletionsToParent(),
      asyncToolCoordinator.drainCompletionsToParent(),
    ]);
    return subagentCount + asyncToolCount;
  }

  const [subagentCount, asyncToolCount] = await Promise.all([
    subagentStatus === "idle"
      ? subagentCoordinator.drainCompletionsToParent()
      : subagentCoordinator.drainCompletionsAndTimeoutsToParent(),
    asyncToolStatus === "idle"
      ? asyncToolCoordinator.drainCompletionsToParent()
      : asyncToolCoordinator.drainCompletionsAndTimeoutsToParent(),
  ]);
  return subagentCount + asyncToolCount;
}

async function pipeAgentSseStream(
  stream: AgentLoopStream,
  controller: ReadableStreamDefaultController<Uint8Array>,
  session: Session,
): Promise<void> {
  let emittedErrorChunk = false;
  const reader = stream.stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (isErrorStreamChunk(value)) {
      emittedErrorChunk = true;
    }
    await session.assertCurrentOwner();
    controller.enqueue(
      textEncoder.encode(`data: ${JSON.stringify(value)}\n\n`),
    );
  }

  const failureText = stream.failureText();
  if (failureText && !emittedErrorChunk) {
    await session.assertCurrentOwner();
    controller.enqueue(
      textEncoder.encode(
        `data: ${JSON.stringify({
          type: "error",
          error: failureText,
        })}\n\n`,
      ),
    );
  }
  const finalResponse = stream.finalResponse();
  if (stream.hasStructuredOutput() && finalResponse !== undefined) {
    await session.assertCurrentOwner();
    controller.enqueue(
      textEncoder.encode(
        `data: ${JSON.stringify({
          type: "structured-output",
          output: finalResponse,
        })}\n\n`,
      ),
    );
  }
}

async function pipeAgentNatsStream(
  stream: AgentLoopStream,
  publisher: NatsPublisher,
): Promise<void> {
  let emittedErrorChunk = false;
  const reader = stream.stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (isErrorStreamChunk(value)) {
      emittedErrorChunk = true;
    }
    publisher.publish(value as Record<string, unknown>).catch(() => {});
  }
  // Mirror the SSE path: surface a terminal failure as an in-stream error part so
  // WebSocket clients receive the same AI SDK stream parts as SSE clients.
  const failureText = stream.failureText();
  if (failureText && !emittedErrorChunk) {
    await publisher.publish({ type: "error", error: failureText });
  }
  const finalResponse = stream.finalResponse();
  if (stream.hasStructuredOutput() && finalResponse !== undefined) {
    await publisher.publish({
      type: "structured-output",
      output: finalResponse,
    });
  }
}

// Native channel SDKs consume async iterables, while the AI SDK exposes a Web
// ReadableStream. This adapter also finalizes tracing/usage when the channel
// drains the stream directly instead of calling stream.consumeStream().
async function* readAgentFullStream(
  stream: AgentLoopStream,
): AsyncIterable<unknown> {
  const reader = stream.stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    await stream.ensureFinalized();
  }
}

function waitUntilMs(context: RequestContext | undefined): number {
  if (context?.deadlineMs && Number.isFinite(context.deadlineMs)) {
    return Math.max(Date.now(), context.deadlineMs - LAMBDA_TIMEOUT_SAFETY_MS);
  }

  return Date.now() + DEFAULT_PARENT_WAIT_MS;
}

function isErrorStreamChunk(chunk: unknown): boolean {
  return Boolean(
    chunk &&
    typeof chunk === "object" &&
    (chunk as { type?: unknown }).type === "error",
  );
}

function emptySseResponse(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function errorSseResponse(error: string, statusCode = 200): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          textEncoder.encode(
            `data: ${JSON.stringify({ type: "error", error })}\n\n`,
          ),
        );
        controller.close();
      },
    }),
    { status: statusCode, headers: { "content-type": "text/event-stream" } },
  );
}

function createChannelApprovalDenial(
  approvals: ToolApprovalSummary[],
): ToolModelMessage {
  // TODO: Allow channel webhooks to complete approval requests instead of
  // auto-denying them once channel-safe approval UX is available.
  return {
    role: "tool",
    content: approvals.map((approval) => ({
      type: "tool-approval-response",
      approvalId: approval.approvalId,
      approved: false,
      reason: CHANNEL_APPROVAL_DENIAL_REASON,
    })),
  };
}

function acceptedAsyncResponse(
  statusUrl: string,
  event: Pick<
    DirectInboundEvent,
    "publicEventId" | "publicConversationKey" | "requestedMode"
  >,
  status: string,
): Response {
  return jsonResponse(202, {
    eventId: event.publicEventId,
    conversationKey: event.publicConversationKey,
    status: status,
    requestedMode: event.requestedMode,
    statusUrl: statusUrl,
  });
}

function directStatusUrl(
  event: Pick<DirectInboundEvent, "publicEventId" | "agentId">,
): string | null {
  const baseUrl = getHarnessPublicUrl();
  if (!baseUrl) return null;

  return `${baseUrl}/status/${encodeURIComponent(event.publicEventId)}?agentId=${encodeURIComponent(event.agentId)}`;
}

function publicEventIdFromScoped(
  value: string | undefined,
  event: DirectInboundEvent,
): string {
  return publicEventIdForScope(
    value,
    event.accountId,
    event.agentId,
    event.publicEventId,
  );
}

function publicEventIdForScope(
  value: string | undefined,
  accountId: string,
  agentId: string,
  fallback: string,
): string {
  if (!value) return fallback;
  const prefix = `acct:${accountId}:agent:${agentId}:api:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : fallback;
}

function directAdmissionResponse(
  event: DirectInboundEvent,
  admission: IngressAdmission,
  jsonOnly: boolean,
): Response {
  if (admission.outcome === "rejected") {
    return jsonOnly
      ? errorResponse(409, CONVERSATION_BUSY, { code: "conversation_busy" })
      : errorSseResponse(CONVERSATION_BUSY, 409);
  }
  if (admission.outcome === "capacity") {
    const message = "Conversation ingress queue is at capacity";
    return jsonOnly
      ? errorResponse(429, message, { code: "ingress_capacity" })
      : errorSseResponse(message, 429);
  }
  if (admission.outcome === "conflict") {
    const message =
      "Idempotency key is already bound to a different ingress payload";
    return jsonOnly
      ? errorResponse(409, message, { code: "idempotency_conflict" })
      : errorSseResponse(message, 409);
  }
  const publicEventId = publicEventIdFromScoped(admission.eventId, event);
  const statusUrl = directStatusUrl({
    publicEventId: publicEventId,
    agentId: event.agentId,
  });

  return jsonResponse(202, {
    eventId: publicEventId,
    conversationKey: event.publicConversationKey,
    status: admission.status ?? "queued",
    requestedMode: event.requestedMode,
    ...(statusUrl ? { statusUrl: statusUrl } : {}),
  });
}

function asyncAdmissionResponse(
  event: AsyncDirectInboundEvent,
  admission: IngressAdmission,
): Response {
  if (admission.outcome === "rejected") {
    return errorResponse(409, CONVERSATION_BUSY, { code: "conversation_busy" });
  }
  if (admission.outcome === "capacity") {
    return errorResponse(429, "Conversation ingress queue is at capacity", {
      code: "ingress_capacity",
    });
  }
  if (admission.outcome === "conflict") {
    return errorResponse(
      409,
      "Idempotency key is already bound to a different ingress payload",
      {
        code: "idempotency_conflict",
      },
    );
  }
  const publicEventId = publicEventIdFromScoped(admission.eventId, event);
  const statusUrl =
    directStatusUrl({ publicEventId: publicEventId, agentId: event.agentId }) ??
    event.statusUrl;

  return acceptedAsyncResponse(
    statusUrl,
    {
      publicEventId: publicEventId,
      publicConversationKey: event.publicConversationKey,
      requestedMode: event.requestedMode,
    },
    admission.status ?? "queued",
  );
}

function eventPublicConversationKey(
  conversationKey: string,
  accountId: string,
  agentId?: string,
): string {
  return publicConversationKeyFromScoped(conversationKey, accountId, agentId);
}

function agentIdFromScopedKey(value: string, accountId: string): string | null {
  const prefix = `acct:${accountId}:agent:`;
  if (!value.startsWith(prefix)) {
    return null;
  }

  const rest = value.slice(prefix.length);
  const separator = rest.indexOf(":");
  return separator > 0 ? rest.slice(0, separator) : null;
}

function isAccountScopedKey(
  value: string,
  accountId: string,
  agentId: string,
): boolean {
  return value.startsWith(`acct:${accountId}:agent:${agentId}:`);
}

function parseAccountAgentFromScopedKey(
  value: string,
): { accountId: string; agentId: string } | null {
  const match = value.match(/^acct:([^:]+):agent:([^:]+):/);
  return match ? { accountId: match[1]!, agentId: match[2]! } : null;
}

function isAsyncWorkerInvocation(
  event: unknown,
): event is AsyncWorkerInvocation {
  return Boolean(
    event &&
    typeof event === "object" &&
    (event as { kind?: unknown }).kind === "direct-api-async-worker",
  );
}

function isNatsWorkerInvocation(event: unknown): event is NatsWorkerInvocation {
  return Boolean(
    event &&
    typeof event === "object" &&
    (event as { kind?: unknown }).kind === "nats-worker",
  );
}

function isCronInvocation(event: unknown): event is CronInvocation {
  return Boolean(
    event &&
    typeof event === "object" &&
    (event as { kind?: unknown }).kind === "cron" &&
    typeof (event as { accountId?: unknown }).accountId === "string" &&
    typeof (event as { cronId?: unknown }).cronId === "string",
  );
}

function hasRunnableDirectEvents(event: DirectInboundEvent): boolean {
  return event.events.some(isRunnableModelInput);
}

// A persisted tool result is history, not new model input. Only user turns and
// AI SDK approval responses should start or resume a model run.
function isRunnableModelInput(
  message:
    | DirectInboundEvent["events"][number]
    | DirectTurn["turnContext"]["messages"][number]
    | undefined,
): boolean {
  return (
    message?.role === "user" ||
    (message?.role === "tool" &&
      message.content.length > 0 &&
      message.content.every((part) => part.type === "tool-approval-response"))
  );
}

function asyncResultEventIds(event: DirectInboundEvent): string[] {
  return [
    ...new Set([event.asyncResultEventId ?? event.eventId, event.eventId]),
  ];
}
