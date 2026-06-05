/**
 * Main Lambda handling logic for harness-processing.
 * Keep request orchestration, session setup, and response shaping here.
 */

import { timingSafeEqual } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { ToolModelMessage, JSONValue, UserModelMessage } from "ai";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { formatChannelErrorText } from "../_shared/channels.ts";
import { executeCommand } from "../_shared/commands.ts";
import { toRuntimeAgentConfig } from "../_shared/storage/index.ts";
import { getStorage, type CronJobRecord } from "../_shared/storage/index.ts";
import { booleanEnv, requireEnv } from "../_shared/env.ts";
import { jsonResponse } from "../_shared/http.ts";
import { logError, logInfo } from "../_shared/log.ts";
import { LiveNatsPublisher, type NatsPublisher } from "../_shared/nats.ts";
import type { LambdaInvocation, LambdaResponse } from "../_shared/runtime.ts";
import {
  publicConversationKeyFromScoped,
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../_shared/runtime-keys.ts";
import { runAgentLoop, type ToolApprovalSummary } from "./harness.ts";
import {
  routeIncomingEvent,
  sendChannelReply,
  type AsyncDirectInboundEvent,
  type AsyncToolCompletionInboundEvent,
  type ChannelInboundEvent,
  type DirectInboundEvent,
  type SandboxJobCompletionInboundEvent,
  type StatusInboundEvent,
} from "./integrations.ts";
import { Session } from "./session.ts";
import {
  createPendingAsyncAgentResult,
  getAsyncAgentResult,
  markAsyncAgentResultAwaitingApproval,
  markAsyncAgentResultCompleted,
  markAsyncAgentResultFailed,
} from "./async-agent-result.ts";
import { SubagentCoordinator } from "./subagents.ts";
import { AsyncToolCoordinator, completionToParentMessage, type AsyncToolExecutionMode } from "./async-tools.ts";
import {
  getAsyncToolCompletionToken,
  getExternalAsyncToolDispatchGroup,
  getAsyncToolResult,
  listAsyncToolResultsByParentEvent,
  sealExternalAsyncToolDispatchGroup,
  settleExternalAsyncToolResult,
  type AsyncToolDelivery,
  type AsyncToolResultRecord,
} from "./async-tool-result.ts";

type AgentLoopStream = Awaited<ReturnType<typeof runAgentLoop>>;

const CONVERSATIONS_TABLE_NAME = requireEnv("CONVERSATIONS_TABLE_NAME");
const AGENT_PROCESSING_FAILED = "Agent processing failed";
const CHANNEL_APPROVAL_DENIAL_REASON = "Tool approval is only supported through the direct API.";
const ENABLE_DIRECT_API = booleanEnv("ENABLE_DIRECT_API", true);
const ENABLE_WEBSOCKET = booleanEnv("ENABLE_WEBSOCKET", false);
const LAMBDA_TIMEOUT_SAFETY_MS = 5 * 60 * 1000;
const DEFAULT_PARENT_WAIT_MS = 8 * 60 * 1000;
const DETACHED_REQUEST_ASYNC_TOOL_MODES = new Set<AsyncToolExecutionMode>(["same-invocation", "external-dispatch"]);
const textEncoder = new TextEncoder();
const lambda = new LambdaClient({ region: process.env.AWS_REGION });

interface AsyncWorkerInvocation {
  kind: "direct-api-async-worker";
  event: DirectInboundEvent;
}

interface NatsWorkerInvocation {
  kind: "nats-worker";
  event: DirectInboundEvent;
}

interface CronJobInvocation {
  kind: "cron-job";
  accountId: string;
  cronJobId: string;
}

interface DirectTurn {
  session: Session;
  turnContext: Awaited<ReturnType<Session["createTurnContext"]>>;
}

interface ParentContinuationResult {
  didFail: boolean;
  failureText: string | null;
  finalResponse?: JSONValue;
  approvals: ToolApprovalSummary[];
  hasExternalDispatches: boolean;
}

export async function handler(
  event: LambdaFunctionURLEvent | AsyncWorkerInvocation | NatsWorkerInvocation | CronJobInvocation,
  context?: LambdaInvocation,
): Promise<LambdaResponse> {
  if (isAsyncWorkerInvocation(event)) {
    await handleAsyncWorkerRequest(event.event, context);
    return { statusCode: 204 };
  }

  if (isNatsWorkerInvocation(event)) {
    await handleNatsWorkerRequest(event.event, context);
    return { statusCode: 204 };
  }

  if (isCronJobInvocation(event)) {
    await handleScheduledCronJob(event);
    return { statusCode: 204 };
  }

  return routeIncomingEvent(event, {
    handleDirectRequest: (directEvent) => handleDirectRequest(directEvent, context),
    handleAsyncRequest,
    handleStatusRequest,
    handleAsyncToolCompletionRequest,
    handleSandboxJobCompletionRequest,
    handleChannelRequest: (channelEvent) => handleChannelRequest(channelEvent, context),
  }, {
    directApiEnabled: ENABLE_DIRECT_API,
  });
}

/**
 * Handle scheduled cron jobs invoked by EventBridge Scheduler.
 */
async function handleScheduledCronJob(event: CronJobInvocation): Promise<void> {
  const cronJobs = getStorage().cronJobs;
  const job = await cronJobs.getById(event.accountId, event.cronJobId);
  if (!job) {
    logInfo("Cron job skipped because it no longer exists", {
      accountId: event.accountId,
      cronJobId: event.cronJobId,
    });
    return;
  }
  if (job.status !== "active") {
    logInfo("Cron job skipped because it is paused", {
      accountId: event.accountId,
      cronJobId: event.cronJobId,
    });
    return;
  }

  await cronJobs.markStarted(job.accountId, job.cronJobId);

  try {
    const result = await startScheduledAgentRun(job);
    logInfo("Cron agent run invoked", {
      accountId: job.accountId,
      cronJobId: job.cronJobId,
      agentId: job.agentId,
      eventId: result.eventId,
      conversationKey: result.conversationKey,
    });
    await cronJobs.markCompleted(job.accountId, job.cronJobId);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logError("Cron agent run failed", {
      accountId: job.accountId,
      cronJobId: job.cronJobId,
      agentId: job.agentId,
      error,
    });
    await cronJobs.markFailed(job.accountId, job.cronJobId, error);
    throw err;
  }
}

/**
 * Handle the async tool result completion request from external source.
 * Requires account-scoped authentication and agent validation.
 */
async function handleAsyncToolCompletionRequest(event: AsyncToolCompletionInboundEvent): Promise<LambdaResponse> {
  // Check for existing
  const existing = await getAsyncToolResult(event.resultId);
  if (!existing) {
    return jsonResponse(404, { error: "Async tool result not found" });
  }

  // Check the event is for the same account and agent
  const agentId = agentIdFromScopedKey(existing.parentEventId, event.accountId);
  if (!agentId || !isAccountScopedKey(existing.conversationKey, event.accountId, agentId)) {
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
  const settled = await settleExternalAsyncToolResult({
    resultId: event.resultId,
    status: event.status,
    ...(event.response !== undefined ? { response: event.response } : {}),
    ...(event.error ? { error: event.error } : {}),
  });
  if (!settled) {
    return jsonResponse(409, { error: "Async tool result settled got error" });
  }

  return continuationResponse(settled, await continueAfterAsyncToolSettlement(settled));
}

/**
 * Handle a background-job completion posted by the detached job itself.
 * Authenticated by the per-job token (matched against the stored row), so the
 * sandbox never needs an account secret. Reuses the same settle → continuation
 * path as the external async-tool completion endpoint.
 */
async function handleSandboxJobCompletionRequest(event: SandboxJobCompletionInboundEvent): Promise<LambdaResponse> {
  const existing = await getAsyncToolResult(event.resultId);
  if (!existing) {
    return jsonResponse(404, { error: "Background job result not found" });
  }
  if (existing.status !== "processing") {
    return jsonResponse(409, { error: "Background job result is already settled", status: existing.status });
  }

  const token = await getAsyncToolCompletionToken(event.resultId);
  // Missing/mismatched token reads as not-found so the endpoint is not a token oracle.
  if (!token || !timingSafeStringEqual(event.token, token)) {
    return jsonResponse(404, { error: "Background job result not found" });
  }

  const settled = await settleExternalAsyncToolResult({
    resultId: event.resultId,
    status: event.status,
    ...(event.response !== undefined ? { response: event.response } : {}),
    ...(event.error ? { error: event.error } : {}),
  });
  if (!settled) {
    return jsonResponse(409, { error: "Background job result is already settled" });
  }

  return continuationResponse(settled, await continueAfterAsyncToolSettlement(settled));
}

type ContinuationOutcome =
  | { kind: "pending"; pendingCount: number }
  | { kind: "ready"; invoked: boolean; publicEventId: string }
  | { kind: "skip" };

/**
 * After a tool row settles, resume the conversation once every result in its
 * dispatch group is in. Derives the account/agent from the (scoped) parentEventId
 * so it serves both the account-authed and token-authed completion paths.
 */
async function continueAfterAsyncToolSettlement(settled: AsyncToolResultRecord): Promise<ContinuationOutcome> {
  const toolResults = await listCurrentParentToolResults(settled);
  const dispatchGroup = await getExternalAsyncToolDispatchGroup(settled.parentEventId);
  const missingCount = Math.max((dispatchGroup?.resultIds.length ?? 0) - toolResults.length, 0);
  const pendingCount = toolResults.filter((result) => result.status === "processing").length + missingCount;
  if (!dispatchGroup?.sealed || pendingCount > 0) {
    return { kind: "pending", pendingCount: dispatchGroup?.sealed ? pendingCount : Math.max(pendingCount, 1) };
  }

  const scope = parseAccountAgentFromScopedKey(settled.parentEventId);
  if (!scope) {
    return { kind: "skip" };
  }
  const agent = await getStorage().agents.getById(scope.accountId, scope.agentId);
  if (!agent || agent.status !== "active") {
    return { kind: "skip" };
  }

  const continuationEvent = {
    accountId: scope.accountId,
    agentId: scope.agentId,
    agentConfig: toRuntimeAgentConfig(agent.config),
    eventId: asyncToolContinuationEventId(settled.parentEventId),
    ...(settled.delivery?.kind === "async" ? { asyncResultEventId: settled.parentEventId } : {}),
    ...(settled.delivery?.kind === "channel"
      ? { replyTarget: { channelName: settled.delivery.channelName, source: settled.delivery.source } }
      : {}),
    publicEventId: `async-tools-${settled.resultId}`,
    conversationKey: settled.conversationKey,
    publicConversationKey: eventPublicConversationKey(settled.conversationKey, scope.accountId, scope.agentId),
    events: settledToolResultsToParentMessages(toolResults),
  } satisfies DirectInboundEvent;

  const created = await createPendingAsyncAgentResult({
    eventId: continuationEvent.eventId,
    conversationKey: continuationEvent.conversationKey,
  });
  if (created) {
    await invokeAsyncToolContinuationWorker(continuationEvent, settled);
  }
  return { kind: "ready", invoked: created, publicEventId: continuationEvent.publicEventId };
}

function continuationResponse(settled: AsyncToolResultRecord, outcome: ContinuationOutcome): LambdaResponse {
  if (outcome.kind === "pending") {
    return jsonResponse(202, {
      status: "waiting_for_async_tools",
      resultId: settled.resultId,
      pendingCount: outcome.pendingCount,
    });
  }
  if (outcome.kind === "skip") {
    return jsonResponse(202, { status: "accepted", resultId: settled.resultId, invoked: false });
  }
  return jsonResponse(202, {
    status: "accepted",
    resultId: settled.resultId,
    eventId: outcome.publicEventId,
    invoked: outcome.invoked,
  });
}

/**
 * Handle the direct SSE request invoke to the Lambda function.
 */
async function handleDirectRequest(event: DirectInboundEvent, context?: LambdaInvocation): Promise<LambdaResponse> {
  if (!hasRunnableDirectEvents(event)) {
    return emptySseResponse();
  }

  try {
    const turn = await prepareDirectTurn(event);
    if (!turn) {
      return emptySseResponse();
    }

    const { session, turnContext } = turn;
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      return emptySseResponse();
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: createDirectContinuationSseBody(event, session, turnContext, context),
    };
  } catch (err) {
    logError("Direct request pre-processing failed", {
      eventId: event.eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Handle the direct Async request invoke to the Lambda function.
 * Return a 204 Accepted response and trigger AsyncWorkerRequest.
 */
async function handleAsyncRequest(event: AsyncDirectInboundEvent): Promise<LambdaResponse> {
  if (!hasRunnableDirectEvents(event)) {
    await createPendingAsyncAgentResult({
      eventId: event.eventId,
      conversationKey: event.conversationKey,
    });
    await markAsyncAgentResultFailed({
      eventId: event.eventId,
      error: "Request must include at least one user event or tool approval response",
    });
    return acceptedAsyncResponse(event.statusUrl);
  }

  const created = await createPendingAsyncAgentResult({
    eventId: event.eventId,
    conversationKey: event.conversationKey,
  });

  if (created) {
    try {
      await invokeAsyncWorker(event);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start async worker";
      logError("Failed to invoke async worker", {
        eventId: event.eventId,
        error: message,
      });
      await settleAsyncFailure(event, message);
    }
  }

  return acceptedAsyncResponse(event.statusUrl);
}

/**
 * Handle the AsyncWorkerRequest invoke to the Lambda function.
 * Publish the final result into DynamoDB.
 */
async function handleAsyncWorkerRequest(event: DirectInboundEvent, context?: LambdaInvocation): Promise<void> {
  try {
    await createPendingAsyncAgentResult({
      eventId: event.asyncResultEventId ?? event.eventId,
      conversationKey: event.conversationKey,
    });

    const turn = await prepareDirectTurn(event);
    if (!turn) {
      return;
    }

    const { session, turnContext } = turn;
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      await settleAsyncFailure(event, "Request did not produce pending model input");
      return;
    }

    let didSettle = false;
    const result = await runAgentLoopUntilSubagentsIdle(session, turnContext, event.agentConfig, context, {
      onFinalText: async (response) => {
        didSettle = true;
        await Promise.all(asyncResultEventIds(event).map((eventId) =>
          markAsyncAgentResultCompleted({
            eventId: eventId,
            response: response,
          })
        ));
        await pushReplyToChannel(event, typeof response === "string" ? response : JSON.stringify(response, null, 2));
      },
      onErrorText: async (error) => {
        didSettle = true;
        await settleAsyncFailure(event, error);
        await pushReplyToChannel(event, formatChannelErrorText(error));
      },
      onApprovalRequired: async (approvals) => {
        await Promise.all(asyncResultEventIds(event).map((eventId) =>
          markAsyncAgentResultAwaitingApproval({
            eventId,
            approvals,
          })
        ));
        didSettle = true;
      },
    });

    if (result.didFail && !didSettle) {
      await settleAsyncFailure(event, result.failureText ?? AGENT_PROCESSING_FAILED);
    }
    if (result.hasExternalDispatches) {
      await continueExternalAsyncToolsIfReady(event, event.agentConfig);
    }
  } catch (err) {
    logError("Async direct request processing failed", {
      eventId: event.eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    await settleAsyncFailure(event, err instanceof Error ? err.message : "Async request failed");
    throw err;
  }
}

/**
 * Handle the NatsWorkerRequest invoke to the Lambda function.
 * Publish the streaming event to NATS subject.
 */
async function handleNatsWorkerRequest(event: DirectInboundEvent, context?: LambdaInvocation): Promise<void> {
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

  try {
    const turn = await prepareDirectTurn(event);
    if (!turn) {
      return;
    }

    const { session, turnContext } = turn;
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      return;
    }

    try {
      const subagentCoordinator = new SubagentCoordinator(session, event.agentConfig, waitUntilMs(context));
      // Define the async tool mode application map.
      const asyncToolCoordinator = new AsyncToolCoordinator(session, waitUntilMs(context), DETACHED_REQUEST_ASYNC_TOOL_MODES, {
        kind: "nats",
        connectionId,
        publicEventId: event.publicEventId,
        publicConversationKey: event.publicConversationKey,
      });

      await runParentContinuationLoop({
        session: session,
        subagentCoordinator: subagentCoordinator,
        asyncToolCoordinator: asyncToolCoordinator,
        initialTurnContext: turnContext,
        agentConfig: event.agentConfig,
        consumeStream: (stream) => pipeAgentNatsStream(stream, publisher),
        onLoopErrorText: async (error) => {
          publisher.publish({ type: "error", error }).catch(() => { });
        },
        onApprovalRequired: async (approvals) => {
          // The event also sends additional tool-approval-request so that the websocket gateway can easily
          // extract this data and do sth with it.
          // This is intentional (the user will receive the tool-approval-request event separately)
          publisher.publish({ type: "tool-approval-request", approvals }).catch(() => { });
        },
        onHeartbeat: (pendingCount) => {
          publisher.publish({
            type: "waiting",
            reason: "in-process-async-work",
            pendingCount,
          }).catch(() => { });
        },
      });

      if (asyncToolCoordinator.hasExternalDispatches) {
        await sealExternalAsyncToolDispatchGroup(event.eventId);
        await continueExternalAsyncToolsIfReady(event, event.agentConfig);
        await publisher.publish({
          type: "waiting",
          reason: "external-async-tools",
        });
      } else {
        await publisher.publish({ type: "done" });
      }
    } finally {
      await publisher.close();
    }
  } catch (err) {
    logError("NATS worker processing failed", {
      eventId: event.eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Handle the integration channel webhook request to the Lambda function.
 * Publish the final result back to the channel integration sendText() function.
 */
async function handleChannelRequest(event: ChannelInboundEvent, context?: LambdaInvocation): Promise<void> {
  const session = new Session(
    event.eventId,
    event.conversationKey,
    event.accountId,
    event.agentId,
    event.agentConfig ?? {},
    // A background job launched from this turn delivers its result back to the
    // same chat (rebuilt from {channelName, source} when it settles later).
    { kind: "channel", channelName: event.channelName, source: event.source },
  );
  logInfo("Channel session received", {
    channel: event.channelName,
    accountId: event.accountId,
    agentId: event.agentId,
    eventId: session.eventId,
    conversationKey: session.conversationKey,
  });

  if (!(await claimSession(session))) {
    logInfo("Channel session already claimed", {
      channel: event.channelName,
      accountId: event.accountId,
      agentId: event.agentId,
      eventId: session.eventId,
      conversationKey: session.conversationKey,
    });
    return;
  }

  if (event.commandToken) {
    logInfo("Channel command executing", {
      channel: event.channelName,
      accountId: event.accountId,
      agentId: event.agentId,
      eventId: session.eventId,
      conversationKey: session.conversationKey,
      commandToken: event.commandToken,
    });
    await executeCommand(event.commandToken, {
      conversationKey: event.conversationKey,
      conversationsTableName: CONVERSATIONS_TABLE_NAME,
      channel: event.channel,
    });
    return;
  }

  try {
    await session.appendIngressEvents(event.events);
    logInfo("Channel ingress events persisted", {
      channel: event.channelName,
      accountId: event.accountId,
      agentId: event.agentId,
      eventId: session.eventId,
      conversationKey: session.conversationKey,
      eventCount: event.events.length,
    });
  } catch (err) {
    logError("Channel request pre-processing failed", {
      eventId: session.eventId,
      conversationKey: session.conversationKey,
      error: err instanceof Error ? err.message : String(err),
    });
    await session.release().catch(() => { });
    throw err;
  }

  if (!(await session.acquireConversationLease())) {
    logInfo("Conversation already processing; event queued", {
      conversationKey: session.conversationKey,
      eventId: session.eventId,
    });
    return;
  }

  try {
    while (true) {
      const turnContext = await session.createTurnContext();
      if (!isRunnableModelInput(turnContext.messages.at(-1))) {
        return;
      }

      const result = await runAgentLoopUntilSubagentsIdle(session, turnContext, event.agentConfig ?? {}, context, {
        // Sending prettify JSON if json, else string
        onFinalText: async (response) => {
          const text = typeof response === "string" ? response : JSON.stringify(response, null, 2);
          logInfo("Channel reply sending", {
            channel: event.channelName,
            accountId: event.accountId,
            agentId: event.agentId,
            eventId: session.eventId,
            conversationKey: session.conversationKey,
            textLength: text.length,
          });
          await event.channel.sendText(text);
          logInfo("Channel reply sent", {
            channel: event.channelName,
            accountId: event.accountId,
            agentId: event.agentId,
            eventId: session.eventId,
            conversationKey: session.conversationKey,
          });
        },
        onErrorText: async (error) => {
          const text = formatChannelErrorText(error);
          logInfo("Channel error reply sending", {
            channel: event.channelName,
            accountId: event.accountId,
            agentId: event.agentId,
            eventId: session.eventId,
            conversationKey: session.conversationKey,
            textLength: text.length,
          });
          await event.channel.sendText(text);
          logInfo("Channel error reply sent", {
            channel: event.channelName,
            accountId: event.accountId,
            agentId: event.agentId,
            eventId: session.eventId,
            conversationKey: session.conversationKey,
          });
        },
        onApprovalRequired: async (approvals) => {
          logInfo("Channel tool approval denied", {
            channel: event.channelName,
            accountId: event.accountId,
            agentId: event.agentId,
            eventId: session.eventId,
            conversationKey: session.conversationKey,
            approvalCount: approvals.length,
          });
          await session.persistModelMessages([createChannelApprovalDenial(approvals)]);
        },
      });

      if (result.didFail) {
        logError("Channel agent loop failed", {
          channel: event.channelName,
          accountId: event.accountId,
          agentId: event.agentId,
          eventId: session.eventId,
          conversationKey: session.conversationKey,
          error: result.failureText ?? AGENT_PROCESSING_FAILED,
        });
        return;
      }
    }
  } finally {
    logInfo("Channel conversation lease releasing", {
      channel: event.channelName,
      accountId: event.accountId,
      agentId: event.agentId,
      eventId: session.eventId,
      conversationKey: session.conversationKey,
    });
    await session.releaseConversationLease().catch(() => { });
  }
}

/**
 * Handle the status request invoke to the Lambda function.
 */
async function handleStatusRequest(event: StatusInboundEvent): Promise<LambdaResponse> {
  const result = await getAsyncAgentResult(event.eventId);
  if (!result) {
    return jsonResponse(404, {
      eventId: event.publicEventId,
      status: "not_found",
    });
  }

  return jsonResponse(200, {
    eventId: event.publicEventId,
    conversationKey: eventPublicConversationKey(result.conversationKey, event.accountId, event.agentId),
    status: result.status,
    ...(result.response !== undefined ? { response: result.response } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.approvals ? { approvals: result.approvals } : {}),
  });
}

async function prepareDirectTurn(event: DirectInboundEvent): Promise<DirectTurn | null> {
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
  const session = new Session(event.eventId, event.conversationKey, event.accountId, event.agentId, event.agentConfig, delivery);
  if (!(await claimSession(session))) {
    return null;
  }

  try {
    const ephemeralSystem = await session.appendIngressEvents(event.events);
    const turnContext = await session.createTurnContext(ephemeralSystem);
    return { session, turnContext };
  } catch (err) {
    await session.release().catch(() => { });
    throw err;
  }
}

async function claimSession(session: Session): Promise<boolean> {
  if (!(await session.claim())) {
    logInfo("Duplicate event skipped", { eventId: session.eventId });
    return false;
  }

  return true;
}

async function settleAsyncFailure(event: DirectInboundEvent, error: string): Promise<void> {
  await Promise.all(asyncResultEventIds(event).map((eventId) =>
    markAsyncAgentResultFailed({
      eventId,
      error,
    })
  ));
}

/**
 * Push a continuation's final text back to the chat channel it came from (a
 * background job launched from Telegram/Slack/etc.). Best-effort: the row is
 * already settled, so a delivery failure is logged, not thrown.
 */
async function pushReplyToChannel(event: DirectInboundEvent, text: string): Promise<void> {
  if (!event.replyTarget) {
    return;
  }
  try {
    await sendChannelReply({
      config: event.agentConfig,
      accountId: event.accountId,
      agentId: event.agentId,
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
 * Invokes the harness-processing Lambda asynchronously to process a direct API async request.
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
 * Invokes the harness-processing Lambda asynchronously to handle NATS-based WebSocket streaming.
 * Used for real-time streaming responses to connected clients.
 */
async function invokeNatsWorker(event: DirectInboundEvent): Promise<void> {
  await invokeHarnessWorker({
    kind: "nats-worker",
    event,
  } satisfies NatsWorkerInvocation);
}

/**
 * Generic worker invocation helper that sends an event to the harness-processing Lambda.
 * Uses Event invocation type to run the worker asynchronously.
 */
async function invokeHarnessWorker(payload: AsyncWorkerInvocation | NatsWorkerInvocation): Promise<void> {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) {
    throw new Error("Missing AWS_LAMBDA_FUNCTION_NAME for worker invocation");
  }

  await lambda.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: "Event",
    Payload: textEncoder.encode(JSON.stringify(payload)),
  }));
}

async function continueExternalAsyncToolsIfReady(
  event: DirectInboundEvent,
  agentConfig: DirectInboundEvent["agentConfig"],
): Promise<boolean> {
  const dispatchGroup = await getExternalAsyncToolDispatchGroup(event.eventId);
  if (!dispatchGroup?.sealed) {
    return false;
  }

  const toolResults = (await Promise.all(dispatchGroup.resultIds.map((resultId) => getAsyncToolResult(resultId))))
    .filter((result): result is AsyncToolResultRecord => result?.parentEventId === event.eventId);
  if (
    toolResults.length !== dispatchGroup.resultIds.length ||
    toolResults.some((result) => result.status === "processing")
  ) {
    return false;
  }

  const continuationEvent = {
    ...event,
    agentConfig,
    eventId: asyncToolContinuationEventId(event.eventId),
    ...(event.connectionId ? {} : { asyncResultEventId: event.asyncResultEventId ?? event.eventId }),
    events: settledToolResultsToParentMessages(toolResults),
  } satisfies DirectInboundEvent;

  const created = await createPendingAsyncAgentResult({
    eventId: continuationEvent.eventId,
    conversationKey: continuationEvent.conversationKey,
  });
  if (!created) {
    return false;
  }

  if (continuationEvent.connectionId) {
    await invokeNatsWorker(continuationEvent);
  } else {
    await invokeAsyncWorker(continuationEvent);
  }
  return true;
}

function asyncToolContinuationEventId(parentEventId: string): string {
  return `${parentEventId}:async-tools`;
}

async function startScheduledAgentRun(job: CronJobRecord): Promise<{ eventId: string; conversationKey: string }> {
  const event = await createCronDirectEvent(job);
  await invokeAsyncWorker(event);

  return {
    eventId: event.publicEventId,
    conversationKey: event.publicConversationKey,
  };
}

async function createCronDirectEvent(job: CronJobRecord): Promise<DirectInboundEvent> {
  const agent = await getStorage().agents.getById(job.accountId, job.agentId);
  if (!agent || agent.status !== "active") {
    throw new Error(`Agent not found: ${job.agentId}`);
  }

  const publicEventId = `${job.cronJobId}-${crypto.randomUUID()}`;
  const publicConversationKey = job.conversationKey ?? `cron:${job.cronJobId}`;
  return {
    accountId: job.accountId,
    agentId: job.agentId,
    agentConfig: toRuntimeAgentConfig(agent.config),
    eventId: scopedDirectEventId(job.accountId, job.agentId, publicEventId),
    publicEventId,
    conversationKey: scopedDirectConversationKey(job.accountId, job.agentId, publicConversationKey),
    publicConversationKey,
    events: [{
      role: "user",
      content: [{ type: "text", text: job.prompt }],
    }],
  } satisfies DirectInboundEvent;
}

async function listCurrentParentToolResults(settled: AsyncToolResultRecord): Promise<AsyncToolResultRecord[]> {
  const dispatchGroup = await getExternalAsyncToolDispatchGroup(settled.parentEventId);
  const queried = dispatchGroup?.sealed
    ? (await Promise.all(dispatchGroup.resultIds.map((resultId) => getAsyncToolResult(resultId))))
      .filter((result): result is AsyncToolResultRecord => result?.parentEventId === settled.parentEventId)
    : await listAsyncToolResultsByParentEvent(settled.parentEventId);
  const byResultId = new Map(queried.map((result) => [result.resultId, result]));
  byResultId.set(settled.resultId, settled);

  const refreshed = await Promise.all([...byResultId.values()].map(async (result) => {
    if (result.status !== "processing") {
      return result;
    }

    const latest = await getAsyncToolResult(result.resultId);
    return latest?.parentEventId === settled.parentEventId ? latest : result;
  }));

  return refreshed;
}

function settledToolResultsToParentMessages(results: AsyncToolResultRecord[]): DirectInboundEvent["events"] {
  return results
    .filter((result) => result.status === "completed" || result.status === "failed")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((result) => completionToParentMessage({
      resultId: result.resultId,
      toolName: result.toolName,
      toolCallId: result.toolCallId,
      input: result.input,
      status: result.status === "completed" ? "completed" : "failed",
      ...(result.response !== undefined ? { response: result.response } : {}),
      ...(result.error ? { error: result.error } : {}),
    }));
}

function createDirectContinuationSseBody(
  event: DirectInboundEvent,
  session: Session,
  initialTurnContext: DirectTurn["turnContext"],
  context?: LambdaInvocation,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const subagentCoordinator = new SubagentCoordinator(session, event.agentConfig, waitUntilMs(context));
      const asyncToolCoordinator = new AsyncToolCoordinator(session, waitUntilMs(context), new Set(["same-invocation"] as const));

      try {
        await runParentContinuationLoop({
          session: session,
          subagentCoordinator: subagentCoordinator,
          asyncToolCoordinator: asyncToolCoordinator,
          initialTurnContext: initialTurnContext,
          agentConfig: event.agentConfig,
          consumeStream: (stream) => pipeAgentSseStream(stream, controller),
          onHeartbeat: (pendingCount) => controller.enqueue(textEncoder.encode(`: waiting for async work pending=${pendingCount}\n\n`))
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logError("Direct continuation stream failed", {
          eventId: event.eventId,
          error,
        });
        controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({ type: "error", error })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
}

async function runAgentLoopUntilSubagentsIdle(
  session: Session,
  initialTurnContext: DirectTurn["turnContext"],
  agentConfig: DirectInboundEvent["agentConfig"],
  context: LambdaInvocation | undefined,
  reply: {
    onFinalText(response: JSONValue): Promise<void>;
    onErrorText(error: string): Promise<void>;
    onApprovalRequired?(approvals: ToolApprovalSummary[]): Promise<void>;
  },
): Promise<{ didFail: boolean; failureText: string | null; hasExternalDispatches: boolean }> {
  const subagentCoordinator = new SubagentCoordinator(session, agentConfig, waitUntilMs(context));
  const asyncToolCoordinator = new AsyncToolCoordinator(session, waitUntilMs(context), DETACHED_REQUEST_ASYNC_TOOL_MODES, { kind: "async" });
  const result = await runParentContinuationLoop({
    session: session,
    subagentCoordinator: subagentCoordinator,
    asyncToolCoordinator: asyncToolCoordinator,
    initialTurnContext: initialTurnContext,
    agentConfig: agentConfig,
    consumeStream: async (stream) => {
      await stream.consumeStream();
    },
  });
  const hasExternalDispatches = asyncToolCoordinator.hasExternalDispatches;
  if (hasExternalDispatches) {
    await sealExternalAsyncToolDispatchGroup(session.eventId);
  }

  if (result.approvals.length > 0) {
    await reply.onApprovalRequired?.(result.approvals);
    return { didFail: false, failureText: null, hasExternalDispatches };
  }

  if (result.didFail) {
    await reply.onErrorText(result.failureText ?? AGENT_PROCESSING_FAILED);
    return { didFail: true, failureText: result.failureText, hasExternalDispatches };
  }

  if (hasExternalDispatches) {
    return { didFail: false, failureText: null, hasExternalDispatches };
  }

  if (result.finalResponse !== undefined) {
    await reply.onFinalText(result.finalResponse);
  }

  return { didFail: false, failureText: null, hasExternalDispatches };
}

/**
 * Runs parent model passes until there is no runnable injected work.
 *
 * Heartbeats are emitted only while this Lambda waits on in-process subagents
 * or same-invocation async tools. External-dispatch async tools do not add
 * pending work here, so the Lambda can exit after sealing the dispatch group.
 */
async function runParentContinuationLoop(options: {
  session: Session;
  subagentCoordinator: SubagentCoordinator;
  asyncToolCoordinator: AsyncToolCoordinator;
  initialTurnContext: DirectTurn["turnContext"];
  agentConfig: DirectInboundEvent["agentConfig"];
  consumeStream(stream: AgentLoopStream): Promise<void>;
  onLoopErrorText?(error: string): Promise<void>;
  onApprovalRequired?(approvals: ToolApprovalSummary[]): Promise<void>;
  onHeartbeat?(pendingCount: number): void;
}): Promise<ParentContinuationResult> {
  let turnContext = options.initialTurnContext;
  let finalResponse: JSONValue | undefined;

  while (true) {
    let approvals: ToolApprovalSummary[] = [];
    const stream = await runAgentLoop(options.session, turnContext, options.agentConfig, {
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
    }, {
      dispatchSubagents: options.subagentCoordinator.dispatch,
      dispatchAsyncTools: options.asyncToolCoordinator.dispatch,
    });

    await options.consumeStream(stream);
    if (approvals.length > 0) {
      return {
        didFail: false,
        failureText: null,
        ...(finalResponse !== undefined ? { finalResponse } : {}),
        approvals,
        hasExternalDispatches: options.asyncToolCoordinator.hasExternalDispatches,
      };
    }
    if (stream.didFail()) {
      return {
        didFail: true,
        failureText: stream.failureText(),
        ...(finalResponse !== undefined ? { finalResponse } : {}),
        approvals: [],
        hasExternalDispatches: options.asyncToolCoordinator.hasExternalDispatches,
      };
    }

    // Wait for any injected subagents or internal async tools to complete.
    const injected = await waitAndDrainAsyncWork(options.subagentCoordinator, options.asyncToolCoordinator, {
      onHeartbeat: options.onHeartbeat,
    });
    if (injected === 0) {
      return {
        didFail: false,
        failureText: null,
        ...(finalResponse !== undefined ? { finalResponse } : {}),
        approvals: [],
        hasExternalDispatches: options.asyncToolCoordinator.hasExternalDispatches,
      };
    }

    turnContext = await options.session.createTurnContext();
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      return {
        didFail: false,
        failureText: null,
        ...(finalResponse !== undefined ? { finalResponse } : {}),
        approvals: [],
        hasExternalDispatches: options.asyncToolCoordinator.hasExternalDispatches,
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
 * parent-visible completions plus timeout notices near the Lambda deadline.
 * External-dispatch async tools do not add in-memory pending work, so waiting
 * here only holds the Lambda for subagents and same-invocation async tools.
 */
async function waitAndDrainAsyncWork(
  subagentCoordinator: SubagentCoordinator,
  asyncToolCoordinator: AsyncToolCoordinator,
  options: {
    onHeartbeat?: (pendingCount: number) => void;
  } = {},
): Promise<number> {
  if (subagentCoordinator.pendingCount === 0 && asyncToolCoordinator.pendingCount === 0) {
    const [subagentCount, asyncToolCount] = await Promise.all([
      subagentCoordinator.drainCompletionsToParent(),
      asyncToolCoordinator.drainCompletionsToParent(),
    ]);
    return subagentCount + asyncToolCount;
  }

  const [subagentStatus, asyncToolStatus] = await Promise.all([
    subagentCoordinator.waitForIdle({
      onHeartbeat: () => options.onHeartbeat?.(subagentCoordinator.pendingCount + asyncToolCoordinator.pendingCount),
    }),
    asyncToolCoordinator.waitForIdle({
      onHeartbeat: () => options.onHeartbeat?.(subagentCoordinator.pendingCount + asyncToolCoordinator.pendingCount),
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
): Promise<void> {
  let emittedErrorChunk = false;
  const reader = stream.fullStream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (isErrorStreamChunk(value)) {
      emittedErrorChunk = true;
    }
    controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(value)}\n\n`));
  }

  const failureText = stream.failureText();
  if (failureText && !emittedErrorChunk) {
    controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({
      type: "error",
      error: failureText,
    })}\n\n`));
  }
  const finalResponse = stream.finalResponse();
  if (stream.hasStructuredOutput() && finalResponse !== undefined) {
    controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({
      type: "structured-output",
      output: finalResponse,
    })}\n\n`));
  }
}

async function pipeAgentNatsStream(
  stream: AgentLoopStream,
  publisher: NatsPublisher,
): Promise<void> {
  const reader = stream.fullStream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    publisher.publish(value as Record<string, unknown>).catch(() => { });
  }
  const finalResponse = stream.finalResponse();
  if (stream.hasStructuredOutput() && finalResponse !== undefined) {
    await publisher.publish({
      type: "structured-output",
      output: finalResponse,
    });
  }
}

function waitUntilMs(context: LambdaInvocation | undefined): number {
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

function emptySseResponse(): LambdaResponse {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/event-stream" },
    body: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  };
}

function createChannelApprovalDenial(approvals: ToolApprovalSummary[]): ToolModelMessage {
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

function acceptedAsyncResponse(statusUrl: string): LambdaResponse {
  return jsonResponse(202, { statusUrl });
}

function eventPublicConversationKey(conversationKey: string, accountId: string, agentId?: string): string {
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

function isAccountScopedKey(value: string, accountId: string, agentId: string): boolean {
  return value.startsWith(`acct:${accountId}:agent:${agentId}:`);
}

function parseAccountAgentFromScopedKey(value: string): { accountId: string; agentId: string } | null {
  const match = value.match(/^acct:([^:]+):agent:([^:]+):/);
  return match ? { accountId: match[1]!, agentId: match[2]! } : null;
}

function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isAsyncWorkerInvocation(event: unknown): event is AsyncWorkerInvocation {
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

function isCronJobInvocation(event: unknown): event is CronJobInvocation {
  return Boolean(
    event &&
    typeof event === "object" &&
    (event as { kind?: unknown }).kind === "cron-job" &&
    typeof (event as { accountId?: unknown }).accountId === "string" &&
    typeof (event as { cronJobId?: unknown }).cronJobId === "string"
  );
}

function hasRunnableDirectEvents(event: DirectInboundEvent): boolean {
  return event.events.some(isRunnableModelInput);
}

// A persisted tool result is history, not new model input. Only user turns and
// AI SDK approval responses should start or resume a model run.
function isRunnableModelInput(message: DirectInboundEvent["events"][number] | DirectTurn["turnContext"]["messages"][number] | undefined): boolean {
  return message?.role === "user" ||
    (message?.role === "tool" &&
      message.content.length > 0 &&
      message.content.every((part) => part.type === "tool-approval-response"));
}

function asyncResultEventIds(event: DirectInboundEvent): string[] {
  return [...new Set([event.asyncResultEventId ?? event.eventId, event.eventId])];
}
