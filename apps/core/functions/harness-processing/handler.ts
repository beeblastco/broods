/**
 * Main Lambda handling logic for harness-processing.
 * Keep request orchestration, session setup, and response shaping here.
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { ToolModelMessage, JSONValue, UserModelMessage } from "ai";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { fromFullStream } from "chat";
import { timingSafeStringEqual } from "../_shared/auth.ts";
import { markHandlerEntry } from "../_shared/cold-start.ts";
import { formatChannelErrorText } from "../_shared/channels.ts";
import { executeCommand } from "../_shared/commands.ts";
import { toRuntimeAgentConfig } from "../_shared/storage/index.ts";
import { getStorage, type CronRecord } from "../_shared/storage/index.ts";
import { booleanEnv, requireEnv } from "../_shared/env.ts";
import { jsonResponse } from "../_shared/http.ts";
import { logError, logInfo, logWarn } from "../_shared/log.ts";
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
import { Session, type ConversationIngressEvent } from "./session.ts";
import {
  createPendingAsyncAgentResult,
  getAsyncAgentResult,
  markAsyncAgentResultAwaitingApproval,
  markAsyncAgentResultCompleted,
  markAsyncAgentResultFailed,
} from "./async-agent-result.ts";
import { SubagentCoordinator } from "./subagents.ts";
import { AsyncToolCoordinator, completionToParentMessage } from "./async-tools.ts";
import {
  getAsyncToolCompletionToken,
  getDetachedAsyncToolGroup,
  getAsyncToolResult,
  listAsyncToolResultsByParentEvent,
  sealDetachedAsyncToolGroup,
  settleAsyncToolResultFromCallback,
  type AsyncToolDelivery,
  type AsyncToolResultRecord,
} from "./async-tool-result.ts";

type AgentLoopStream = Awaited<ReturnType<typeof runAgentLoop>>;

const CONVERSATIONS_TABLE_NAME = requireEnv("CONVERSATIONS_TABLE_NAME");
const AGENT_PROCESSING_FAILED = "Agent processing failed";
const CONVERSATION_BUSY = "Conversation is already processing another turn. Try again when the current turn finishes.";
const CHANNEL_APPROVAL_DENIAL_REASON = "Tool approval is only supported through the direct API.";
const ENABLE_DIRECT_API = booleanEnv("ENABLE_DIRECT_API", true);
const ENABLE_WEBSOCKET = booleanEnv("ENABLE_WEBSOCKET", false);
const LAMBDA_TIMEOUT_SAFETY_MS = 5 * 60 * 1000;
const DEFAULT_PARENT_WAIT_MS = 8 * 60 * 1000;
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
  approvals: ToolApprovalSummary[];
  hasDetachedCallbacks: boolean;
}

class ConversationBusyError extends Error {
  constructor() {
    super(CONVERSATION_BUSY);
    this.name = "ConversationBusyError";
  }
}

export async function handler(
  event: LambdaFunctionURLEvent | AsyncWorkerInvocation | NatsWorkerInvocation | CronInvocation,
  context?: LambdaInvocation,
): Promise<LambdaResponse> {
  // First entry in this execution environment marks the end of the cold-start
  // init window so the first agent run can surface it as a phase span.
  markHandlerEntry(Date.now());

  if (isAsyncWorkerInvocation(event)) {
    await handleAsyncWorkerRequest(event.event, context);
    return { statusCode: 204 };
  }

  if (isNatsWorkerInvocation(event)) {
    await handleNatsWorkerRequest(event.event, context);
    return { statusCode: 204 };
  }

  if (isCronInvocation(event)) {
    await handleScheduledCron(event);
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
  const settled = await settleAsyncToolResultFromCallback({
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
 * path as the account-auth async-tool completion endpoint.
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

  const settled = await settleAsyncToolResultFromCallback({
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
  const dispatchGroup = await getDetachedAsyncToolGroup(settled.parentEventId);
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
    ...(settled.delivery?.kind === "async" ? { asyncResultEventId: settled.parentEventId } : {}),
    ...(settled.delivery?.kind === "channel"
      ? { replyTarget: { channelName: settled.delivery.channelName, source: settled.delivery.source } }
      : {}),
    publicEventId: `async-tools-${settled.resultId}`,
    conversationKey: settled.conversationKey,
    publicConversationKey: eventPublicConversationKey(settled.conversationKey, scope.accountId, scope.agentId),
    events,
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
  if (event.connectionId) {
    await invokeNatsWorker(event);

    return jsonResponse(202, {
      eventId: event.publicEventId,
      conversationKey: event.publicConversationKey,
      nats: {
        accountId: event.accountId,
        agentId: event.agentId,
        conversationKey: event.publicConversationKey,
      },
    });
  }

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
      await session.releaseConversationLease().catch(() => { });
      return emptySseResponse();
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: createDirectContinuationSseBody(event, session, turnContext, context),
    };
  } catch (err) {
    if (err instanceof ConversationBusyError) {
      return errorSseResponse(CONVERSATION_BUSY, 409);
    }

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
      await session.releaseConversationLease().catch(() => { });
      return;
    }

    let didSettle = false;
    let result: Awaited<ReturnType<typeof runAgentLoopUntilSubagentsIdle>>;
    try {
      result = await runAgentLoopUntilSubagentsIdle(session, turnContext, event.agentConfig, context, {
        onFinalText: async (response) => {
          didSettle = true;
          await Promise.all(asyncResultEventIds(event).map((eventId) =>
            markAsyncAgentResultCompleted({
              eventId: eventId,
              response: response,
            })
          ));
          if (event.cronRun) {
            await getStorage().crons.completeRun(event.accountId, event.cronRun.cronId, event.cronRun.runId, response);
          }
          await pushReplyToChannel(event, typeof response === "string" ? response : JSON.stringify(response, null, 2));
        },
        onErrorText: async (error) => {
          didSettle = true;
          await settleAsyncFailure(event, error);
          if (event.cronRun) {
            await getStorage().crons.failRun(event.accountId, event.cronRun.cronId, event.cronRun.runId, error);
          }
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
    } finally {
      await session.releaseConversationLease().catch(() => { });
    }

    if (result.didFail && !didSettle) {
      await settleAsyncFailure(event, result.failureText ?? AGENT_PROCESSING_FAILED);
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
      }
    } catch (err) {
      if (err instanceof ConversationBusyError) {
        logInfo("Async direct request rejected while conversation is busy", {
          eventId: event.eventId,
          conversationKey: event.conversationKey,
        });
        await settleAsyncFailure(event, CONVERSATION_BUSY);
        return;
      }

      logError("Async direct request processing failed", {
        eventId: event.eventId,
        error: err instanceof Error ? err.message : String(err),
    });
    await settleAsyncFailure(event, err instanceof Error ? err.message : "Async request failed");
    if (event.cronRun) {
      await getStorage().crons.failRun(
        event.accountId,
        event.cronRun.cronId,
        event.cronRun.runId,
        err instanceof Error ? err.message : "Async request failed",
      );
    }
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
      await session.releaseConversationLease().catch(() => { });
      return;
    }

    try {
      const subagentCoordinator = new SubagentCoordinator(session, event.agentConfig, waitUntilMs(context));
      // Define the async tool mode application map.
      const asyncToolCoordinator = new AsyncToolCoordinator(session, waitUntilMs(context), {
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

      if (asyncToolCoordinator.hasDetachedCallbacks) {
        await sealDetachedAsyncToolGroup(event.eventId);
        await continueDetachedAsyncToolsIfReady(event, event.agentConfig);
        await publisher.publish({
          type: "waiting",
          reason: "detached-async-tools",
        });
      } else {
        await publisher.publish({ type: "done" });
        // Turn is finished and persisted to the conversation DB, so the JetStream
        // resume buffer is no longer needed — a later reconnect reads the saved
        // turn from the DB. Purge it to free space (best-effort).
        await publisher.purge();
      }
    } finally {
      await session.releaseConversationLease().catch(() => { });
      await publisher.close();
    }
  } catch (err) {
    if (err instanceof ConversationBusyError) {
      logInfo("NATS worker rejected while conversation is busy", {
        eventId: event.eventId,
        conversationKey: event.conversationKey,
      });
      await publisher.publish({ type: "error", error: CONVERSATION_BUSY }).catch(() => { });
      await publisher.publish({ type: "done" }).catch(() => { });
      await publisher.close().catch(() => { });
      return;
    }

    await publisher.close().catch(() => { });
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
    event.endpointId,
    event.projectSlug,
    event.environmentSlug,
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
    try {
      await executeCommand(event.commandToken, {
        conversationKey: event.conversationKey,
        conversationsTableName: CONVERSATIONS_TABLE_NAME,
        channel: event.channel,
      });
    } catch (err) {
      await session.release().catch(() => { });
      throw err;
    }
    return;
  }

  // Acquire the conversation lease before writing this message to history. If a
  // turn is already running for this conversation, buffer the message so the lease
  // holder answers it after its current reply (in order) instead of dropping it.
  // The typing/reaction ack already fired upstream, so the user still sees that
  // the message was received. This applies to every channel, since all channel
  // webhooks funnel through here.
  let ownEvents: ConversationIngressEvent[] = event.events;
  let leaseAcquired = await session.acquireConversationLease();
  if (!leaseAcquired) {
    await session.enqueuePendingIngress(ownEvents);
    // The holder may have released right after our first attempt; retry once so a
    // message queued at that boundary is drained now, not stranded until the next
    // inbound message.
    leaseAcquired = await session.acquireConversationLease();
    if (!leaseAcquired) {
      logInfo("Conversation busy; channel message queued for drain", {
        conversationKey: session.conversationKey,
        eventId: session.eventId,
      });
      return;
    }
    // We are the drainer now; this message lives in the pending buffer and is
    // picked up by takePendingIngress in the loop below.
    ownEvents = [];
  }

  try {
    // Run turns until history has no runnable input and no queued follow-ups
    // remain. A message that arrives mid-turn is buffered (above) and appended
    // here — after the in-flight reply — so a fast follow-up is answered in order.
    let incoming: ConversationIngressEvent[] = ownEvents;
    while (true) {
      if (incoming.length > 0) {
        try {
          await session.appendIngressEvents(incoming);
          logInfo("Channel ingress events persisted", {
            channel: event.channelName,
            accountId: event.accountId,
            agentId: event.agentId,
            eventId: session.eventId,
            conversationKey: session.conversationKey,
            eventCount: incoming.length,
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
        incoming = [];
      }

      const turnContext = await session.createTurnContext();
      if (!isRunnableModelInput(turnContext.messages.at(-1))) {
        // History is fully answered — drain anything queued during the reply.
        incoming = await session.takePendingIngress();
        if (incoming.length === 0) {
          break;
        }
        logInfo("Draining channel messages queued during the previous turn", {
          channel: event.channelName,
          conversationKey: session.conversationKey,
          eventId: session.eventId,
          queuedCount: incoming.length,
        });
        continue;
      }

      let streamed = false;
      const streamWarn = (error: unknown) => logWarn("Channel SDK stream failed; falling back to final sendText", {
        channel: event.channelName,
        eventId: session.eventId,
        error: error instanceof Error ? error.message : String(error),
      });

      const result = await runAgentLoopUntilSubagentsIdle(session, turnContext, event.agentConfig ?? {}, context, {
        ...(event.channel.stream
          ? {
            streamMessage: async (stream) => {
              try {
                const result = await event.channel.stream!(fromFullStream(readAgentFullStream(stream)));
                streamed = Boolean(result);
                if (!streamed) {
                  await stream.consumeStream();
                }
              } catch (error) {
                streamWarn(error);
                if (!streamed) {
                  try {
                    await stream.consumeStream();
                  } catch {
                    // The final error path below will send the channel error reply.
                  }
                }
              }
            },
          }
          : {}),
        onFinalText: async (response) => {
          if (streamed && typeof response === "string") {
            return;
          }
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
        // A failed turn ends the drain: leave any queued follow-ups in the buffer
        // for the next inbound message rather than replaying a broken conversation.
        break;
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
  const session = new Session(event.eventId, event.conversationKey, event.accountId, event.agentId, event.agentConfig, delivery, event.endpointId, event.projectSlug, event.environmentSlug);
  if (!(await claimSession(session))) {
    return null;
  }

  let leaseAcquired = false;
  try {
    if (!(await session.acquireConversationLease())) {
      logInfo("Conversation already processing; direct event rejected", {
        conversationKey: session.conversationKey,
        eventId: session.eventId,
      });

      throw new ConversationBusyError();
    }
    leaseAcquired = true;
    const ephemeralSystem = await session.appendIngressEvents(event.events);
    if (event.ephemeralSystem) {
      ephemeralSystem.push(...event.ephemeralSystem);
    }
    const turnContext = await session.createTurnContext(ephemeralSystem);
    return { session, turnContext };
  } catch (err) {
    if (leaseAcquired) {
      await session.releaseConversationLease().catch(() => { });
    }
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

async function continueDetachedAsyncToolsIfReady(
  event: DirectInboundEvent,
  agentConfig: DirectInboundEvent["agentConfig"],
): Promise<boolean> {
  const dispatchGroup = await getDetachedAsyncToolGroup(event.eventId);
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
    ...(event.connectionId ? {} : { asyncResultEventId: event.asyncResultEventId ?? event.eventId }),
    events,
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

async function startScheduledAgentRun(job: CronRecord): Promise<{ eventId: string; conversationKey: string }> {
  const event = await createCronDirectEvent(job);
  const run = await getStorage().crons.createRun({
    accountId: job.accountId,
    cronId: job.cronId,
    eventId: event.publicEventId,
    conversationKey: event.publicConversationKey,
  });
  event.cronRun = { cronId: job.cronId, runId: run.runId };
  try {
    await invokeAsyncWorker(event);
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

async function createCronDirectEvent(job: CronRecord): Promise<DirectInboundEvent> {
  const agent = await getStorage().agents.getById(job.accountId, job.agentId);
  if (!agent || agent.status !== "active") {
    throw new Error(`Agent not found: ${job.agentId}`);
  }
  const deployment = await getStorage().agentDeployments.getByAgentId?.(job.accountId, job.agentId);

  const publicEventId = `${job.cronId}-${crypto.randomUUID()}`;
  const publicConversationKey = job.conversationKey ?? `cron:${job.cronId}`;
  return {
    accountId: job.accountId,
    agentId: job.agentId,
    agentConfig: toRuntimeAgentConfig(agent.config),
    eventId: scopedDirectEventId(job.accountId, job.agentId, publicEventId),
    publicEventId,
    conversationKey: scopedDirectConversationKey(job.accountId, job.agentId, publicConversationKey),
    publicConversationKey,
    events: job.events as DirectInboundEvent["events"],
    ...(deployment
      ? {
        endpointId: deployment.endpointId,
        projectSlug: deployment.projectSlug,
        environmentSlug: deployment.environmentSlug,
      }
      : {}),
  } satisfies DirectInboundEvent;
}

async function listCurrentParentToolResults(settled: AsyncToolResultRecord): Promise<AsyncToolResultRecord[]> {
  const dispatchGroup = await getDetachedAsyncToolGroup(settled.parentEventId);
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
    // Skip results the model already pulled via async_status — re-injecting them
    // would make the model answer the same completion twice.
    .filter((result) => (result.status === "completed" || result.status === "failed") && result.observed !== true)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((result) => completionToParentMessage({
      resultId: result.resultId,
      toolName: result.toolName,
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
      const asyncToolCoordinator = new AsyncToolCoordinator(session, waitUntilMs(context));

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
        await session.releaseConversationLease().catch(() => { });
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
    streamMessage?(stream: AgentLoopStream): Promise<void>;
  },
): Promise<{ didFail: boolean; failureText: string | null; hasDetachedCallbacks: boolean }> {
  const subagentCoordinator = new SubagentCoordinator(session, agentConfig, waitUntilMs(context));
  const asyncToolCoordinator = new AsyncToolCoordinator(session, waitUntilMs(context), session.delivery ?? { kind: "async" });
  const result = await runParentContinuationLoop({
    session: session,
    subagentCoordinator: subagentCoordinator,
    asyncToolCoordinator: asyncToolCoordinator,
    initialTurnContext: initialTurnContext,
    agentConfig: agentConfig,
    consumeStream: reply.streamMessage ?? (async (stream) => {
      await stream.consumeStream();
    }),
  });
  const hasDetachedCallbacks = asyncToolCoordinator.hasDetachedCallbacks;
  if (hasDetachedCallbacks) {
    await sealDetachedAsyncToolGroup(session.eventId);
  }

  if (result.approvals.length > 0) {
    await reply.onApprovalRequired?.(result.approvals);
    return { didFail: false, failureText: null, hasDetachedCallbacks };
  }

  if (result.didFail) {
    await reply.onErrorText(result.failureText ?? AGENT_PROCESSING_FAILED);
    return { didFail: true, failureText: result.failureText, hasDetachedCallbacks };
  }

  if (hasDetachedCallbacks) {
    return { didFail: false, failureText: null, hasDetachedCallbacks };
  }

  if (result.finalResponse !== undefined) {
    await reply.onFinalText(result.finalResponse);
  }

  return { didFail: false, failureText: null, hasDetachedCallbacks };
}

/**
 * Runs parent model passes until there is no runnable injected work.
 *
 * Heartbeats are emitted only while this Lambda waits on in-process subagents,
 * built-in async tools, or uploaded async tools on SSE. Detached uploaded async
 * tools do not add pending work here, so the Lambda can exit after sealing the
 * group.
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
        hasDetachedCallbacks: options.asyncToolCoordinator.hasDetachedCallbacks,
      };
    }
    if (stream.didFail()) {
      // A failed parent pass may have already dispatched subagents in an earlier
      // step that are still running in the background. Wait for them to settle
      // before returning so each child finalizes — publishing AND flushing its
      // terminal span. Otherwise the abandoned children spin "running" forever in
      // the dashboard: their running span was stored durably, but the Lambda froze
      // before the terminal one was ever flushed. Bounded by the same deadline
      // budget as the success path.
      if (options.subagentCoordinator.pendingCount > 0) {
        await options.subagentCoordinator.waitForIdle({ onHeartbeat: options.onHeartbeat });
      }

      return {
        didFail: true,
        failureText: stream.failureText(),
        ...(finalResponse !== undefined ? { finalResponse } : {}),
        approvals: [],
        hasDetachedCallbacks: options.asyncToolCoordinator.hasDetachedCallbacks,
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
        hasDetachedCallbacks: options.asyncToolCoordinator.hasDetachedCallbacks,
      };
    }

    turnContext = await options.session.createTurnContext();
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      return {
        didFail: false,
        failureText: null,
        ...(finalResponse !== undefined ? { finalResponse } : {}),
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
 * parent-visible completions plus timeout notices near the Lambda deadline.
 * Detached uploaded async tools do not add in-memory pending work, so waiting
 * here only holds the Lambda for subagents, built-in async tools, and uploaded
 * async tools on SSE.
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
    publisher.publish(value as Record<string, unknown>).catch(() => { });
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

async function* readAgentFullStream(stream: AgentLoopStream): AsyncIterable<unknown> {
  const reader = stream.fullStream.getReader();
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

function errorSseResponse(error: string, statusCode = 200): LambdaResponse {
  return {
    statusCode,
    headers: { "Content-Type": "text/event-stream" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({ type: "error", error })}\n\n`));
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

function isCronInvocation(event: unknown): event is CronInvocation {
  return Boolean(
    event &&
    typeof event === "object" &&
    (event as { kind?: unknown }).kind === "cron" &&
    typeof (event as { accountId?: unknown }).accountId === "string" &&
    typeof (event as { cronId?: unknown }).cronId === "string"
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
