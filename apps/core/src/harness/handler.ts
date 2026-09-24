/**
 * Harness-processing request handler for the Bun container runtime.
 * Keep request orchestration, session setup, and response shaping here.
 */

import type { JSONValue, SystemModelMessage, ToolModelMessage } from "ai";
import type { TaskWaitingOn } from "../../../../packages/broods/src/observability-contracts.ts";
import { extractBearerToken, isServiceToken } from "../shared/auth.ts";
import { extractText, formatChannelErrorText } from "../shared/channels.ts";
import { markHandlerEntry } from "../shared/cold-start.ts";
import { executeCommand, resolveChannelCommand } from "../shared/commands.ts";
import {
  isChannelTraceEnabled,
  toRuntimeAgentConfig,
  type AgentConfig,
} from "../shared/domain/agent-config.ts";
import {
  isOneTimeSchedule,
  withScheduledRunContext,
  type CronRecord,
} from "../shared/domain/cron.ts";
import {
  booleanEnv,
  getHarnessPublicUrl,
  positiveIntegerEnv,
} from "../shared/env.ts";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  parseJsonBody,
  type CoreRequest,
  type RequestContext,
} from "../shared/http.ts";
import { logDebug, logError, logInfo, logWarn } from "../shared/log.ts";
import type { NatsPublisher } from "../shared/nats.ts";
import {
  getObservabilityContext,
  runWithObservabilityScope,
} from "../shared/otel.ts";
import {
  accountAgentScopedKey,
  createRunId,
  publicConversationKeyFromScoped,
  publicEventIdForScope,
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../shared/runtime-keys.ts";
import { getStorage } from "../shared/storage.ts";
import {
  createPendingAsyncAgentResult,
  getAsyncAgentResult,
  markAsyncAgentResultAwaitingApproval,
  markAsyncAgentResultAwaitingInput,
  markAsyncAgentResultCompleted,
  markAsyncAgentResultFailed,
} from "./async-agent-result.ts";
import {
  getAsyncToolResult,
  getDetachedAsyncToolGroup,
  listAsyncToolResultsByParentEvent,
  settleAsyncToolResultFromCallback,
  verifyAsyncToolCompletionToken,
  type AsyncToolDelivery,
  type AsyncToolResultRecord,
} from "./async-tool-result.ts";
import {
  AsyncToolCoordinator,
  completionToParentMessage,
} from "./async-tools.ts";
import {
  readAgentFullStream,
  runAgentLoop,
  type AgentLoopStream,
  type ToolApprovalSummary,
} from "./harness.ts";
import {
  applyMessageSendingHook,
  createAgentHookDispatcher,
  type HookDispatcher,
} from "./hook-dispatcher.ts";
import {
  acceptIngress,
  getConversationDispatchTarget,
  getIngressStatusByEventId,
  prepareSessionMessage,
  type AppliedIngress,
  type IngressAdmission,
  type IngressDelivery,
  type IngressSettlement,
  type SessionMessageInput,
  type SessionMessageResult,
} from "./ingress.ts";
import {
  channelActionsFromConfig,
  rewriteLatestUserIngressText,
  routeIncomingEvent,
  sendChannelReply,
  type AsyncDirectInboundEvent,
  type ChannelContextEvent,
  type ChannelInboundEvent,
  type DirectInboundEvent,
  type IngressDispatchScope,
  type SandboxJobCompletionInboundEvent,
  type StatusInboundEvent,
} from "./integrations.ts";
import { LiveNatsPublisher } from "./nats-publisher.ts";
import {
  admitRun,
  planRefusalResponse,
  type PlanRefusal,
} from "./plan-limits.ts";
import {
  ingestChannelAttachments,
  Session,
  type ConversationIngressEvent,
} from "./session.ts";
import {
  ASK_QUESTIONS_TOOL_NAME,
  answersFromChoice,
  answersFromText,
  listOpenQuestions,
  openQuestion,
  settleQuestion,
  type OpenQuestion,
  type PendingQuestionSummary,
  type QuestionAnswerResult,
} from "./questions.ts";
import { SubagentCoordinator } from "./subagents.ts";

// A queue at capacity drains on the order of seconds, not minutes.
const INGRESS_RETRY_HEADERS = { "Retry-After": "5" };
const AGENT_PROCESSING_FAILED = "Agent processing failed";
// The one user turn a "Continue" adds; the history it lands on already ends
// in the tool results of the cut-off step.
const CONTINUE_TURN_TEXT =
  "Your previous turn was cut off before it finished. Continue the task from where you left off.";
const CONVERSATION_BUSY =
  "Conversation is already processing another turn. Try again when the current turn finishes.";
const CHANNEL_APPROVAL_DENIAL_REASON =
  "Tool approval is only supported through the direct API.";
const ENABLE_DIRECT_API = booleanEnv("ENABLE_DIRECT_API", true);
const ENABLE_WEBSOCKET = booleanEnv("ENABLE_WEBSOCKET", false);
// What a subagent or async-tool wait leaves of the request budget, so the parent
// still has time for the turn that reads the results before the deadline.
const WAIT_DEADLINE_MARGIN_MS = 60 * 1000;
const DEFAULT_PARENT_WAIT_MS = 8 * 60 * 1000;
const DEFAULT_DASHBOARD_URL = "https://dashboard.broods.app";
const MAX_INPROCESS_WORKERS = positiveIntegerEnv("MAX_INPROCESS_WORKERS", 8);
const WORKER_TIMEOUT_BUDGET_MS = positiveIntegerEnv(
  "WORKER_TIMEOUT_BUDGET_MS",
  10 * 60 * 1000,
);
const WORKER_SLOT_GRACE_MS = 5_000;
// Well under the server's 255s idleTimeout and the gateway's own idle limit.
const SSE_KEEPALIVE_INTERVAL_MS = 30_000;
const MAX_PENDING_WORKER_RUNS = 1000;
// Chunks arrive faster than a Convex round trip, so a streamed chunk checks
// ownership on this clock. A frame the client acts on checks exactly: a stale
// run must not land one in a stream the next owner is writing to. `waiting` is
// the heartbeat: it fires on a timer, not per token, so exact costs nothing.
const OWNER_CHECK_INTERVAL_MS = 2_000;
const OWNER_CHECK_EXACT_FRAME_TYPES: ReadonlySet<string> = new Set([
  "done",
  "error",
  "question-request",
  "structured-output",
  "tool-approval-request",
  "waiting",
]);
const textEncoder = new TextEncoder();
const inProcessWorkers = new Set<Promise<void>>();
const pendingWorkerRuns: [kind: string, run: InProcessWorkerRun][] = [];

let activeInProcessWorkers = 0;

type ContinuationOutcome =
  | { kind: "pending"; pendingCount: number }
  | { kind: "ready"; invoked: boolean; publicEventId: string }
  | { kind: "skip" };
type InProcessWorkerRun = (context: RequestContext) => Promise<unknown>;

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
  // The dispatch instant, stamped by agent/crons.dispatch in Convex when the
  // schedule fires; the run framing tells the agent this is when it fired.
  scheduledTime?: string;
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
  questions: PendingQuestionSummary[];
}

/**
 * Runs one agent turn on the pod's worker pool, or queues it FIFO while every
 * slot is busy. Every background run goes through here, channel turns
 * included, so MAX_INPROCESS_WORKERS bounds what the pod runs at once.
 * @param kind a label for logs
 */
export function dispatchInProcessWorker(
  kind: string,
  run: InProcessWorkerRun,
): void {
  if (activeInProcessWorkers >= MAX_INPROCESS_WORKERS) {
    if (pendingWorkerRuns.length >= MAX_PENDING_WORKER_RUNS) {
      // Load-shed: the awaiting caller surfaces the error instead of the queue
      // growing without bound.
      throw new Error("In-process worker queue is full");
    }
    pendingWorkerRuns.push([kind, run]);

    return;
  }

  activeInProcessWorkers += 1;
  const execution = run({
    requestId: crypto.randomUUID(),
    deadlineMs: Date.now() + WORKER_TIMEOUT_BUDGET_MS,
    // Workers run detached; they never emit an HTTP response, so there is no
    // post-response tail to defer.
    waitUntil: () => {},
  }).then(
    () => undefined,
    (err) => {
      logError("In-process worker failed", {
        kind: kind,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );
  // Nothing here kills a hung model stream or tool, so a few
  // stuck workers would otherwise pin every slot for every tenant on the pod. An
  // overrun frees the slot but leaves the underlying work running.
  let slotTimer: ReturnType<typeof setTimeout> | undefined;
  const guarded = Promise.race([
    execution,
    new Promise<void>((resolve) => {
      slotTimer = setTimeout(() => {
        logError("In-process worker exceeded deadline; reclaiming slot", {
          kind: kind,
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
    const next = pendingWorkerRuns.shift();
    if (next) {
      dispatchInProcessWorker(next[0], next[1]);
    }
  });
  inProcessWorkers.add(worker);
}

/** Awaited by the container bootstrap on shutdown so queued work is not lost. */
export async function drainInProcessWorkers(): Promise<void> {
  while (inProcessWorkers.size > 0) {
    await Promise.allSettled(inProcessWorkers);
  }
}

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

/**
 * One per stream. The returned check runs before each frame goes out: exact
 * for `OWNER_CHECK_EXACT_FRAME_TYPES`, at most once per interval for the rest.
 */
export function ownerCheckForStream(
  session: Pick<Session, "assertCurrentOwner">,
): (frame: Record<string, unknown>) => Promise<void> {
  // performance.now() cannot step backwards the way Date.now() can.
  let checkedAt = Number.NEGATIVE_INFINITY;

  return async (frame): Promise<void> => {
    const exact =
      typeof frame.type === "string" &&
      OWNER_CHECK_EXACT_FRAME_TYPES.has(frame.type);
    if (!exact && performance.now() - checkedAt < OWNER_CHECK_INTERVAL_MS) {
      return;
    }
    await session.assertCurrentOwner();
    checkedAt = performance.now();
  };
}

/**
 * Records a cron run's outcome, and retires a one-time job with it: its
 * scheduled run is spent, so the row can never fire again.
 */
export async function settleCronRun(
  accountId: string,
  cronRun: DirectInboundEvent["cronRun"],
  outcome: { result: JSONValue } | { error: string },
): Promise<void> {
  if (!cronRun) return;
  const crons = getStorage().crons;
  if ("error" in outcome) {
    await crons.failRun(
      accountId,
      cronRun.cronId,
      cronRun.runId,
      outcome.error,
    );
  } else {
    await crons.completeRun(
      accountId,
      cronRun.cronId,
      cronRun.runId,
      outcome.result,
    );
  }
  if (cronRun.oneShot) await removeOneShotCron(accountId, cronRun.cronId);
}

export async function settleFailedIngressAndDrain(
  session: Pick<Session, "releaseConversationLease" | "settleIngress">,
  error: string,
  dispatchNext: () => Promise<boolean>,
): Promise<boolean> {
  await session.settleIngress("failed", { error: error }).catch(() => {});
  const transferred = await dispatchNext().catch(() => false);
  if (!transferred) {
    await session.releaseConversationLease().catch(() => {});
  }

  return transferred;
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
      handleAsyncRequest: handleAsyncRequest,
      handleStatusRequest: handleStatusRequest,
      handleSandboxJobCompletionRequest: handleSandboxJobCompletionRequest,
      handleChannelRequest: handleChannelRequest,
      handleChannelContext: handleChannelContext,
    },
    {
      directApiEnabled: ENABLE_DIRECT_API,
      ...(context?.waitUntil ? { waitUntil: context.waitUntil } : {}),
    },
  );
}

async function handleCronHttpRequest(request: CoreRequest): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const token = extractBearerToken(request.headers.authorization);
  if (!token || !isServiceToken(request.headers, token)) {
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

  const refusal = await handleScheduledCron(payload);

  return refusal
    ? planRefusalResponse(refusal)
    : new Response(null, { status: 204 });
}

/**
 * Handle scheduled cron jobs dispatched by the Convex crons component.
 * @returns the plan-limit refusal when the fire was not admitted, else null
 */
async function handleScheduledCron(
  event: CronInvocation,
): Promise<PlanRefusal | null> {
  const crons = getStorage().crons;
  const job = await crons.getById(event.accountId, event.cronId);
  if (!job) {
    logInfo("Cron job skipped because it no longer exists", {
      accountId: event.accountId,
      cronId: event.cronId,
    });

    return null;
  }
  if (job.status !== "active") {
    logInfo("Cron job skipped because it is paused", {
      accountId: event.accountId,
      cronId: event.cronId,
    });

    return null;
  }
  const { refusal } = await admitRun(job.accountId);
  if (refusal) {
    // A refused fire is spent like a failed one, one-shot included.
    await crons.markFailed(job.accountId, job.cronId, refusal.message);
    if (isOneTimeSchedule(job.scheduleExpression)) {
      await removeOneShotCron(job.accountId, job.cronId);
    }

    return refusal;
  }

  await crons.markStarted(job.accountId, job.cronId);
  const firedAt = scheduledFireTime(event.scheduledTime);

  try {
    const result = await startScheduledAgentRun(job, firedAt);
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
      error: error,
    });
    await crons.markFailed(job.accountId, job.cronId, error);
    // The schedule is spent whether or not the run started, so retire the job
    // here too. The settle path never reached it.
    if (isOneTimeSchedule(job.scheduleExpression)) {
      await removeOneShotCron(job.accountId, job.cronId);
    }
    throw err;
  }

  return null;
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
    return errorResponse(404, "Background job result not found", {
      code: "job_result_not_found",
    });
  }
  if (existing.status !== "processing") {
    return errorResponse(409, "Background job result is already settled", {
      code: "job_result_settled",
    });
  }

  // Missing/mismatched token reads as not-found so the endpoint is not a token oracle.
  if (!(await verifyAsyncToolCompletionToken(event.resultId, event.token))) {
    return errorResponse(404, "Background job result not found", {
      code: "job_result_not_found",
    });
  }

  const settled = await settleAsyncToolResultFromCallback({
    resultId: event.resultId,
    status: event.status,
    ...(event.response !== undefined ? { response: event.response } : {}),
    ...(event.error ? { error: event.error } : {}),
  });
  if (!settled) {
    return errorResponse(409, "Background job result is already settled", {
      code: "job_result_settled",
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
  if (!agent) {
    return { kind: "skip" };
  }

  // Drop results the model already pulled via async_status; if everything in the
  // group was observed, there is nothing to deliver and no continuation to run.
  const events = settledToolResultsToParentMessages(toolResults);
  if (events.length === 0) {
    return { kind: "skip" };
  }
  const publicConversationKey = eventPublicConversationKey(
    settled.conversationKey,
    scope.accountId,
    scope.agentId,
  );
  // A channel session resumes on its record-narrowed config, as a cron does.
  const target = await resolveReentryTarget({
    accountId: scope.accountId,
    agentId: scope.agentId,
    publicConversationKey: publicConversationKey,
    agentConfig: toRuntimeAgentConfig(agent.config),
  });

  const continuationEvent: DirectInboundEvent = {
    accountId: scope.accountId,
    agentId: scope.agentId,
    runId: createRunId(),
    agentConfig: target.agentConfig,
    eventId: asyncToolContinuationEventId(settled.parentEventId),
    ...(settled.delivery?.kind === "async"
      ? { asyncResultEventId: settled.parentEventId }
      : {}),
    ...(settled.delivery?.kind === "channel"
      ? {
          replyTarget: {
            channelName: settled.delivery.channelName,
            ...(settled.delivery.identity
              ? { identity: settled.delivery.identity }
              : {}),
            source: settled.delivery.source,
          },
        }
      : {}),
    publicEventId: `async-tools-${settled.resultId}`,
    conversationKey: settled.conversationKey,
    publicConversationKey: publicConversationKey,
    events: events,
    // An answer joins a live run at its next step boundary; a finished job
    // waits its turn behind the current one.
    requestedMode:
      settled.toolName === ASK_QUESTIONS_TOOL_NAME ? "steer" : "followup",
    idempotencyKey: asyncToolContinuationEventId(settled.parentEventId),
  };

  const { owned: ownedContinuation } = await admitInternalContinuation(
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

/** The 202 a socket turn gets: the NATS scope the gateway streams the run from. */
function natsStartResponse(
  event: DirectInboundEvent,
  publicEventId: string,
  statusUrl: string | null,
): Response {
  return jsonResponse(202, {
    eventId: publicEventId,
    // Always sent, so the gateway can poll status in-cluster even when no
    // public statusUrl exists (PUBLIC_BASE_URL unset).
    runId: event.runId,
    conversationKey: event.publicConversationKey,
    status: "processing",
    requestedMode: event.requestedMode,
    ...(statusUrl ? { statusUrl: statusUrl } : {}),
    nats: {
      accountId: event.accountId,
      agentId: event.agentId,
      conversationKey: event.publicConversationKey,
    },
  });
}

/**
 * Settle open ask_questions prompts from a direct API body and resume the
 * conversation, answering with the last continuation's outcome.
 */
async function handleDirectAnswers(
  event: DirectInboundEvent,
): Promise<Response> {
  const answers = event.answers ?? [];
  const open = await Promise.all(
    answers.map(async (answer): Promise<OpenQuestion | undefined> =>
      openQuestion(
        await getAsyncToolResult(answer.statusId),
        event.conversationKey,
      ),
    ),
  );
  const missing = open.findIndex((question) => question === undefined);
  if (missing >= 0) {
    return errorResponse(
      404,
      `No open question ${answers[missing]!.statusId} on this conversation`,
      { code: "question_not_found", param: "statusId" },
    );
  }
  const settled = await Promise.all(
    open.map((question, index) =>
      settleQuestion(question!.record, {
        status: "answered",
        answers: answers[index]!.answers,
      }),
    ),
  );
  let last: AsyncToolResultRecord | null = null;
  let outcome: ContinuationOutcome = { kind: "skip" };
  for (const row of settled) {
    if (!row) continue;
    last = row;
    outcome = await continueAfterAsyncToolSettlement(row);
  }
  const alreadyAnswered = open
    .filter((_question, index) => settled[index] === null)
    .map((question) => question!.record.resultId);
  if (alreadyAnswered.length > 0) {
    return errorResponse(
      409,
      `Questions already answered: ${alreadyAnswered.join(", ")}`,
      { code: "question_already_answered", param: "answers" },
    );
  }

  // A socket turn needs a stream to follow or a terminal status. Only a ready
  // continuation streams; otherwise the answer is saved and the turn is over.
  if (event.connectionId && last) {
    return outcome.kind === "ready"
      ? natsStartResponse(event, outcome.publicEventId, null)
      : jsonResponse(202, { eventId: last.resultId, status: "completed" });
  }

  return last
    ? continuationResponse(last, outcome)
    : errorResponse(400, "Request body must include answers", {
        param: "answers",
      });
}

/**
 * A channel message while a prompt is open is its answer, not a turn. A
 * button click names its prompt; typed text answers the oldest open one.
 * True when a prompt settled and the conversation is resuming.
 */
async function settleChannelQuestion(
  event: ChannelInboundEvent,
): Promise<boolean> {
  const click = event.answer;
  const open = click
    ? openQuestion(
        await getAsyncToolResult(click.statusId),
        event.conversationKey,
      )
    : (await listOpenQuestions(event.conversationKey))[0];
  const chosen =
    open && click ? answersFromChoice(open.pending, click) : undefined;
  if (click && !chosen) {
    await event.channel
      .sendText("That question is no longer open.")
      .catch((): void => {});

    return true;
  }
  if (!open) return false;
  const answer: QuestionAnswerResult | undefined = chosen
    ? { status: "answered", answers: chosen }
    : answersFromText(open.pending, extractText(event.content));
  if (!answer) return false;
  const settled = await settleQuestion(open.record, {
    ...answer,
    ...(event.identity ? { answeredBy: event.identity } : {}),
  });
  if (!settled) return false;
  const outcome = await continueAfterAsyncToolSettlement(settled);
  logInfo("Question answered", {
    channel: event.channelName,
    conversationKey: event.conversationKey,
    resultId: settled.resultId,
    outcome: outcome.kind,
  });

  return true;
}

async function handleDirectRequest(
  event: DirectInboundEvent,
  context?: RequestContext,
): Promise<Response> {
  const { refusal } = await admitRun(event.accountId);
  if (refusal) {
    return planRefusalResponse(refusal);
  }
  if (event.answers?.length) {
    return handleDirectAnswers(event);
  }
  if (event.continuation) {
    return handleContinueRequest(event);
  }
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
        ...(event.publicDeploymentIngress
          ? { publicDeploymentIngress: event.publicDeploymentIngress }
          : {}),
      }
    : {
        kind: "http",
        publicEventId: event.publicEventId,
        publicConversationKey: event.publicConversationKey,
        ...(directStatusUrl(event)
          ? { statusUrl: directStatusUrl(event)! }
          : {}),
        ...(event.publicDeploymentIngress
          ? { publicDeploymentIngress: event.publicDeploymentIngress }
          : {}),
      };
  const admission = await acceptIngress({
    accountId: event.accountId,
    agentId: event.agentId,
    eventId: event.eventId,
    runId: event.runId,
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

    return natsStartResponse(
      event,
      event.publicEventId,
      directStatusUrl(event),
    );
  }

  try {
    const turn = await prepareDirectTurn(ownedEvent);
    if (!turn) {
      return emptySseResponse();
    }

    const { session, turnContext } = turn;
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      await settleFailedIngressAndDrain(
        session,
        "Request did not produce pending model input",
        () => dispatchNextIngress(session, ownedEvent),
      );

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

/** Answer a direct async request with 202 and hand it to an in-process worker. */
async function handleAsyncRequest(
  event: AsyncDirectInboundEvent,
): Promise<Response> {
  const { refusal } = await admitRun(event.accountId);
  if (refusal) {
    return planRefusalResponse(refusal);
  }
  if (event.answers?.length) {
    return handleDirectAnswers(event);
  }
  if (event.continuation) {
    return handleContinueRequest(event);
  }
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
    runId: event.runId,
    conversationKey: event.conversationKey,
    events: event.events,
    requestedMode: event.requestedMode,
    idempotencyKey: event.idempotencyKey,
    delivery: {
      kind: "async",
      publicEventId: event.publicEventId,
      publicConversationKey: event.publicConversationKey,
      statusUrl: event.statusUrl,
      ...(event.publicDeploymentIngress
        ? { publicDeploymentIngress: event.publicDeploymentIngress }
        : {}),
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
  await startOwnedAsyncRun({
    ...event,
    ownerGeneration: admission.ownerGeneration,
  });

  return acceptedAsyncResponse(
    event.runId,
    event.statusUrl,
    event,
    "processing",
  );
}

/**
 * Re-enter a conversation whose last turn stopped short (step cap, provider
 * fault) with one nudge turn on top of the persisted history, which already
 * ends in the tool results of the cut-off step. Replies where the conversation
 * replies: a live channel session answers in its channel, anything else is an
 * async run polled by its status URL. Always 202, whatever `background` said.
 */
async function handleContinueRequest(
  event: DirectInboundEvent,
): Promise<Response> {
  const target = await resolveReentryTarget({
    accountId: event.accountId,
    agentId: event.agentId,
    publicConversationKey: event.publicConversationKey,
    agentConfig: event.agentConfig,
  });
  // The key the caller named must be the session it resolves to: a scoped
  // channel key with no live session behind it is not something to continue.
  if (event.conversationKey !== target.conversationKey) {
    return errorResponse(404, "Conversation not found", {
      code: "conversation_not_found",
      param: "conversationKey",
    });
  }

  const continuation: DirectInboundEvent = {
    ...event,
    ...target,
    events: [{ role: "user", content: CONTINUE_TURN_TEXT }],
    requestedMode: "followup",
  };
  const { admission, owned } = await admitInternalContinuation(
    continuation,
    continuationDelivery(continuation),
  );
  if (owned) {
    await startOwnedAsyncRun(owned);
  }

  return directAdmissionResponse(
    continuation,
    owned ? { ...admission, status: "processing" } : admission,
    true,
  );
}

/** Run an in-process async worker request and publish its final result to storage. */
async function handleAsyncWorkerRequest(
  event: DirectInboundEvent,
  context?: RequestContext,
): Promise<void> {
  let session: Session | undefined;
  let transferred = false;
  // Scoped to the whole request so the catch below can tell a throw that
  // follows a terminal result from one that replaces it.
  let didSettle = false;
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
      didSettle = true;
      await settleCronRun(event.accountId, event.cronRun, {
        error: "Request did not produce pending model input",
      });
      transferred = await dispatchNextIngress(session, event);

      return;
    }

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
          await settleCronRun(event.accountId, event.cronRun, {
            result: response,
          });
          // An empty final text means the run already delivered its output
          // through a channel tool; pushing it would post a blank message.
          const responseText =
            typeof response === "string"
              ? response
              : JSON.stringify(response, null, 2);
          if (responseText.trim() === "") {
            return;
          }
          await pushReplyToChannel(
            session!,
            event,
            formatChannelFinalText(
              responseText,
              traceId,
              event,
              event.replyTarget?.channelName,
              event.agentConfig,
            ),
          );
        },
        onErrorText: async (error, traceId) => {
          didSettle = true;
          terminalSettled = true;
          await session!.settleIngress("failed", { error: error });
          await settleAsyncFailure(event, error);
          await settleCronRun(event.accountId, event.cronRun, {
            error: error,
          });
          await pushReplyToChannel(
            session!,
            event,
            formatChannelFinalText(
              formatChannelErrorText(error),
              traceId,
              event,
              event.replyTarget?.channelName,
              event.agentConfig,
            ),
          );
        },
        onApprovalRequired: async (approvals) => {
          await Promise.all(
            asyncResultEventIds(event).map((eventId) =>
              markAsyncAgentResultAwaitingApproval({
                eventId: eventId,
                approvals: approvals,
              }),
            ),
          );
          didSettle = true;
          terminalSettled = true;
          await session!.settleIngress("completed", {
            result: { status: "awaiting_approval", approvals: approvals },
          });
        },
        onQuestionsPending: async (questions) => {
          await Promise.all(
            asyncResultEventIds(event).map((eventId) =>
              markAsyncAgentResultAwaitingInput({
                eventId: eventId,
                questions: questions,
              }),
            ),
          );
          didSettle = true;
          terminalSettled = true;
          await session!.settleIngress("completed", {
            result: { status: "awaiting_input", questions: questions },
          });
        },
      },
    );

    if (result.didFail && !didSettle) {
      didSettle = true;
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
      await settleCronRun(event.accountId, event.cronRun, {
        error: result.failureText ?? AGENT_PROCESSING_FAILED,
      });
    }
    if (terminalSettled) {
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
    // A throw after the run already settled must not overwrite its recorded
    // outcome, and for a one-time job the run row is gone with the cron.
    if (!didSettle) {
      await settleCronRun(event.accountId, event.cronRun, {
        error: err instanceof Error ? err.message : "Async request failed",
      });
    }
    throw err;
  } finally {
    if (session && !transferred) {
      await session.releaseConversationLease().catch(() => {});
    }
  }
}

/** Run an in-process NATS worker request, publishing stream parts to its subject. */
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
  if (!process.env.NATS_URL?.trim()) {
    throw new Error("NATS worker requires NATS_URL");
  }

  const publisher = new LiveNatsPublisher({
    accountId: event.accountId,
    agentId: event.agentId,
    conversationKey: event.publicConversationKey,
    eventId: event.publicEventId,
    connectionId: connectionId,
  });

  let session: Session | undefined;
  let transferred = false;
  try {
    const turn = await prepareDirectTurn(event);
    if (!turn) {
      // Both early returns skip the inner finally, so close the request-scoped
      // publisher here instead of leaking it.
      await publisher.close();

      return;
    }

    ({ session } = turn);
    const { turnContext } = turn;
    const checkOwner = ownerCheckForStream(session);
    const fencedPublisher: NatsPublisher = {
      publish: async (data) => {
        await checkOwner(data);
        await publisher.publish(data);
      },
      close: () => publisher.close(),
    };
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      transferred = await settleFailedIngressAndDrain(
        session,
        "Request did not produce pending model input",
        () => dispatchNextIngress(session!, event),
      );
      await publisher.close();

      return;
    }

    try {
      const subagentCoordinator = new SubagentCoordinator(
        session,
        event.agentConfig,
        waitUntilMs(context),
        { dispatchNextIngress: dispatchNextIngress },
      );
      const asyncToolCoordinator = new AsyncToolCoordinator(
        session,
        waitUntilMs(context),
      );

      const result = await runParentContinuationLoop({
        session: session,
        subagentCoordinator: subagentCoordinator,
        asyncToolCoordinator: asyncToolCoordinator,
        initialTurnContext: turnContext,
        agentConfig: event.agentConfig,
        consumeStream: (stream) =>
          pipeAgentStream(stream, (chunk): Promise<void> =>
            fencedPublisher.publish(chunk),
          ),
        onLoopErrorText: async (error) => {
          fencedPublisher
            .publish({ type: "error", error: error })
            .catch(() => {});
        },
        onApprovalRequired: async (approvals) => {
          // Sent as its own event, on top of the stream part, so the WebSocket
          // gateway can pick the approvals out without parsing the stream.
          fencedPublisher
            .publish({ type: "tool-approval-request", approvals: approvals })
            .catch(() => {});
        },
        onQuestionsPending: async (questions) => {
          fencedPublisher
            .publish({ type: "question-request", questions: questions })
            .catch(() => {});
        },
        onHeartbeat: (pendingCount) => {
          fencedPublisher
            .publish({
              type: "waiting",
              reason: "in-process-async-work",
              pendingCount: pendingCount,
            })
            .catch(() => {});
        },
      });

      const settlement = turnSettlement(result);
      await session.settleIngress(settlement.status, settlement);
      await fencedPublisher.publish({ type: "done" });
      transferred = await dispatchNextIngress(session, event);
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
 * Admit one channel message and hand its turn to the worker pool. Resolves once
 * the message is durably admitted (or answered as a command, an answer, or a
 * refusal), so the webhook can ack after it; the agent run itself happens on a
 * worker slot and replies through the channel's ChannelActions.
 */
export async function handleChannelRequest(
  event: ChannelInboundEvent,
): Promise<void> {
  const outcome = resolveChannelCommand(event);
  if (outcome.kind === "reply") {
    // A forwarder retry redelivers the same event, and a second `/clear` would
    // drop what was said between the two deliveries.
    if (
      event.accountId &&
      !(await claimSession(
        new Session({
          eventId: event.eventId,
          conversationKey: event.conversationKey,
          accountId: event.accountId,
        }),
      ))
    ) {
      return;
    }
    logInfo("Channel command executing", {
      channel: event.channelName,
      accountId: event.accountId,
      agentId: event.agentId,
      eventId: event.eventId,
      conversationKey: event.conversationKey,
      commandToken: outcome.commandToken,
    });
    await executeCommand(outcome.commandToken, {
      conversationKey: event.conversationKey,
      channel: event.channel,
      accountId: event.accountId,
      agentId: event.agentId,
      eventId: event.eventId,
      text: commandText(outcome.commandToken, extractText(event.content)),
      compact: (options) => compactChannelConversation(event, options),
    });

    return;
  }
  if (outcome.kind === "rewrite") {
    event = {
      ...event,
      content: outcome.text,
      events: rewriteLatestUserIngressText(event.events, outcome.text),
    };
  }

  if (!event.accountId || !event.agentId) {
    throw new Error("Channel ingress requires account and agent scope");
  }
  if (await settleChannelQuestion(event)) return;
  const requestedMode =
    outcome.kind === "rewrite" ? outcome.requestedMode : "steer";
  // A provider redelivery of an admitted message must not store its files a
  // second time. Only a message with files pays for this read.
  if (
    event.attachments?.length &&
    (await getIngressStatusByEventId({
      accountId: event.accountId,
      agentId: event.agentId,
      eventId: event.eventId,
    }))
  ) {
    logInfo("Channel redelivery of an admitted message ignored", {
      channel: event.channelName,
      eventId: event.eventId,
      conversationKey: event.conversationKey,
    });

    return;
  }
  // The provider gets its usual ack either way; an error status would only
  // make it redeliver. The refusal and the 80% notice are said in the channel.
  const plan = await admitRun(event.accountId, { claimWarning: true });
  if (plan.refusal) {
    await event.channel.sendText(
      plan.refusal.retryAfterSeconds === undefined
        ? plan.refusal.message
        : `${plan.refusal.message} Try again in ${plan.refusal.retryAfterSeconds} seconds.`,
    );

    return;
  }
  // Best-effort: the notice is already claimed, and failing it here would drop
  // the message it rode in on.
  if (plan.warning) {
    await event.channel.sendText(plan.warning).catch((err: unknown): void => {
      logWarn("Budget warning delivery failed", {
        eventId: event.eventId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  // Before admission, so a turn that lands in the queue still carries its
  // media: the queued record holds only these events, and the drain loop
  // replays exactly what was queued.
  const ingested = await ingestChannelAttachments(
    event.events,
    event.attachments,
    {
      accountId: event.accountId,
      agentConfig: event.agentConfig ?? {},
      channelName: event.channelName,
      conversationKey: event.conversationKey,
      eventId: event.eventId,
    },
  );
  const admission = await acceptIngress({
    accountId: event.accountId,
    agentId: event.agentId,
    eventId: event.eventId,
    // A channel turn is never polled by run id, but every envelope carries one.
    runId: createRunId(),
    conversationKey: event.conversationKey,
    events: ingested.events,
    requestedMode: requestedMode,
    idempotencyKey: event.eventId,
    delivery: {
      kind: "channel",
      channel: event.channelName,
      ...(event.identity ? { identity: event.identity } : {}),
      source: event.source,
    },
    agentConfig: event.agentConfig ?? {},
  });
  const scope: IngressDispatchScope = {
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
    stageSlug: event.stageSlug,
  };
  await dispatchRecoveredIngress(scope, admission);
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

  const session = new Session({
    eventId: event.eventId,
    conversationKey: event.conversationKey,
    accountId: event.accountId,
    agentId: event.agentId,
    agentConfig: event.agentConfig ?? {},
    delivery: {
      kind: "channel",
      channelName: event.channelName,
      ...(event.identity ? { identity: event.identity } : {}),
      source: event.source,
    },
    endpointId: event.endpointId,
    projectSlug: event.projectSlug,
    stageSlug: event.stageSlug,
    ownerGeneration: admission.ownerGeneration,
    channelActions: event.channel,
  });
  // A queued worker starts later, from whichever run frees its slot, so it
  // takes this message's observability context rather than inheriting that one.
  // The webhook acked long ago, so a failure outside a turn is said here.
  const observability = getObservabilityContext();
  try {
    dispatchInProcessWorker("channel-worker", (context): Promise<void> =>
      runWithObservabilityScope(
        (): Promise<void> =>
          runChannelTurns(event, session, ingested.turnEvents, context).catch(
            async (err: unknown): Promise<never> => {
              await event.channel
                .sendText(
                  formatChannelErrorText(
                    err instanceof Error ? err.message : String(err),
                  ),
                )
                .catch((): void => {});
              throw err;
            },
          ),
        observability,
      ),
    );
  } catch (err) {
    await settleFailedIngressAndDrain(
      session,
      err instanceof Error ? err.message : "Failed to start channel turn",
      (): Promise<boolean> => dispatchNextIngress(session, scope),
    );
    throw err;
  }
}

/**
 * The owned channel turn, then every queued follow-up after it, on one worker
 * slot. Each turn settles its envelope before the queue drains on.
 * @param incoming the live turn's events, with the transient byte-backed parts
 *   admission never saw; a follow-up taken off the queue brings its own
 */
async function runChannelTurns(
  event: ChannelInboundEvent,
  owned: Session,
  incoming: ConversationIngressEvent[],
  context: RequestContext,
): Promise<void> {
  let session = owned;
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
          let awaitingInput = false;
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
                      // A channel that cannot post a live stream stops reading
                      // and hands the reply back as text, so the run keeps
                      // going and the drain below finishes it.
                      const streamedResult = await event.channel.stream!(
                        readAgentFullStream(stream, false),
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
                // An empty final text means the run already delivered its
                // output through a channel tool; sending it would post a
                // blank message.
                const responseText =
                  typeof response === "string"
                    ? response
                    : JSON.stringify(response, null, 2);
                if (responseText.trim() === "") return;
                const formatted = formatChannelFinalText(
                  responseText,
                  traceId,
                  event,
                  event.channelName,
                  activeConfig,
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
                    event.channelName,
                    activeConfig,
                  ),
                );
              },
              onApprovalRequired: async (approvals) => {
                approvalRequired = true;
                await session.persistModelMessages([
                  createChannelApprovalDenial(approvals),
                ]);
              },
              onQuestionsPending: async (questions) => {
                await session.assertCurrentOwner();
                awaitingInput = true;
                await session.settleIngress("completed", {
                  result: { status: "awaiting_input", questions: questions },
                });
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
          if (awaitingInput) {
            // Settled in the hook; the answer resumes the conversation.
          } else if (terminal === "failed") {
            await session.settleIngress("failed", {
              error: result.failureText ?? AGENT_PROCESSING_FAILED,
            });
          } else if (terminal === "completed") {
            await session.settleIngress(
              "completed",
              finalResult !== undefined ? { result: finalResult } : {},
            );
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
      // The queued sender, never the first one: policy reads userId and roles
      // from here, and the envelope is the only place the sender survived.
      const identity =
        next.delivery.kind === "channel" ? next.delivery.identity : undefined;
      activeConfig = next.agentConfig ?? event.agentConfig ?? {};
      session = new Session({
        eventId: next.eventId,
        conversationKey: event.conversationKey,
        accountId: event.accountId,
        agentId: event.agentId,
        agentConfig: activeConfig,
        delivery: {
          kind: "channel",
          channelName: event.channelName,
          ...(identity ? { identity: identity } : {}),
          source: source,
        },
        endpointId: event.endpointId,
        projectSlug: event.projectSlug,
        stageSlug: event.stageSlug,
        ownerGeneration: next.ownerGeneration,
        channelActions: event.channelFactory?.(source) ?? event.channel,
      });
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

// Serves the /compact command: it acquires the fenced clear lease first, then
// hands its generation here so the summary row is an owner-fenced append. The
// Session is context-only; no model turn runs.
function compactChannelConversation(
  event: ChannelInboundEvent,
  options: { ownerGeneration: number; instructions: string },
): Promise<number> {
  const session = new Session({
    eventId: event.eventId,
    conversationKey: event.conversationKey,
    accountId: event.accountId,
    agentId: event.agentId,
    agentConfig: event.agentConfig ?? {},
    ownerGeneration: options.ownerGeneration,
  });

  return session.compactConversation(options.instructions);
}

async function handleChannelContext(event: ChannelContextEvent): Promise<void> {
  const session = new Session({
    eventId: event.eventId,
    conversationKey: event.conversationKey,
    accountId: event.accountId,
    agentId: event.agentId,
    agentConfig: event.agentConfig ?? {},
    endpointId: event.endpointId,
    projectSlug: event.projectSlug,
    stageSlug: event.stageSlug,
  });
  logDebug("Channel context received", {
    channel: event.channelName,
    accountId: event.accountId,
    agentId: event.agentId,
    eventId: session.eventId,
    conversationKey: session.conversationKey,
    source: event.source,
  });

  if (!(await claimSession(session))) {
    logDebug("Channel context already claimed", {
      channel: event.channelName,
      accountId: event.accountId,
      agentId: event.agentId,
      eventId: session.eventId,
      conversationKey: session.conversationKey,
    });

    return;
  }

  // Context is stored, never run, so only the durable parts matter here.
  // Persistence would drop byte-backed parts anyway.
  await session.appendIngressEvents(
    (
      await ingestChannelAttachments(event.events, event.attachments, {
        accountId: event.accountId,
        agentConfig: event.agentConfig ?? {},
        channelName: event.channelName,
        conversationKey: event.conversationKey,
        eventId: event.eventId,
      })
    ).events,
  );
  logDebug("Channel context persisted", {
    channel: event.channelName,
    accountId: event.accountId,
    agentId: event.agentId,
    eventId: session.eventId,
    conversationKey: session.conversationKey,
  });
}

async function handleStatusRequest(
  event: StatusInboundEvent,
): Promise<Response> {
  // The envelope is already resolved: the route looked it up by run id to
  // learn which agent owns this run before authorizing the read.
  const result = event.ingress;
  const asyncResult = await getAsyncAgentResult(event.eventId);

  // The async agent record keeps the public approval contract: while it is
  // nonterminal its status (processing/awaiting_approval) overrides the
  // envelope's terminal settle so pollers keep waiting and see approvals
  // top-level, exactly as before durable ingress statuses existed.
  const status =
    asyncResult &&
    (asyncResult.status === "awaiting_approval" ||
      asyncResult.status === "awaiting_input" ||
      (asyncResult.status === "processing" && result.status !== "failed"))
      ? asyncResult.status
      : result.status;
  const conversationKey = result.conversationKey;

  return jsonResponse(200, {
    runId: event.runId,
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
    ...(result?.stoppedByUser ? { stoppedByUser: true } : {}),
    ...(asyncResult?.response !== undefined
      ? { response: asyncResult.response }
      : {}),
    ...(asyncResult?.approvals !== undefined
      ? { approvals: asyncResult.approvals }
      : {}),
    ...(asyncResult?.questions !== undefined
      ? { questions: asyncResult.questions }
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
    : event.replyTarget
      ? {
          kind: "channel",
          channelName: event.replyTarget.channelName,
          ...(event.replyTarget.identity
            ? { identity: event.replyTarget.identity }
            : {}),
          source: event.replyTarget.source,
        }
      : undefined;
  if (event.ownerGeneration === undefined) {
    throw new Error("Direct turn is missing its durable owner generation");
  }
  const session = new Session({
    eventId: event.eventId,
    conversationKey: event.conversationKey,
    accountId: event.accountId,
    agentId: event.agentId,
    agentConfig: event.agentConfig,
    delivery: delivery,
    endpointId: event.endpointId,
    projectSlug: event.projectSlug,
    stageSlug: event.stageSlug,
    ownerGeneration: event.ownerGeneration,
    channelActions: event.replyTarget
      ? (channelActionsFromConfig(
          event.agentConfig,
          event.replyTarget.channelName,
          event.replyTarget.source,
        ) ?? undefined)
      : undefined,
    trigger: event.cronRun ? "cron" : undefined,
  });
  try {
    const ephemeralSystem = await session.appendIngressEvents(event.events);
    if (event.ephemeralSystem) {
      ephemeralSystem.push(...event.ephemeralSystem);
    }
    const turnContext = await session.createTurnContext(ephemeralSystem);

    return { session: session, turnContext: turnContext };
  } catch (err) {
    await settleFailedIngressAndDrain(
      session,
      err instanceof Error ? err.message : "Direct turn preparation failed",
      () => dispatchNextIngress(session, event),
    );
    throw err;
  }
}

async function failOwnedIngress(
  event: DirectInboundEvent,
  error: string,
): Promise<void> {
  if (event.ownerGeneration === undefined) return;
  const session = new Session({
    eventId: event.eventId,
    conversationKey: event.conversationKey,
    accountId: event.accountId,
    agentId: event.agentId,
    agentConfig: event.agentConfig,
    delivery: event.connectionId
      ? {
          kind: "nats",
          connectionId: event.connectionId,
          publicEventId: event.publicEventId,
          publicConversationKey: event.publicConversationKey,
        }
      : undefined,
    endpointId: event.endpointId,
    projectSlug: event.projectSlug,
    stageSlug: event.stageSlug,
    ownerGeneration: event.ownerGeneration,
  });
  // A scheduling failure recurses back through dispatchAppliedIngress; each
  // level consumes one envelope, so the queue bound terminates it.
  await settleFailedIngressAndDrain(session, error, () =>
    dispatchNextIngress(session, event),
  );
}

async function claimSession(session: Session): Promise<boolean> {
  if (!(await session.claim())) {
    logDebug("Duplicate event skipped", { eventId: session.eventId });

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
        eventId: eventId,
        error: error,
      }),
    ),
  );
}

function formatChannelFinalText(
  text: string,
  traceId: string | undefined,
  event: Pick<
    DirectInboundEvent | ChannelInboundEvent,
    "projectSlug" | "stageSlug"
  >,
  channelName: string | undefined,
  config: AgentConfig,
): string {
  if (!isChannelTraceEnabled(config, channelName)) {
    return text;
  }
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
    "projectSlug" | "stageSlug"
  >,
): string | null {
  if (!traceId || !event.projectSlug || !event.stageSlug) {
    return null;
  }
  const dashboardUrl = (
    process.env.BROODS_DASHBOARD_URL ??
    process.env.DASHBOARD_URL ??
    DEFAULT_DASHBOARD_URL
  ).replace(/\/+$/, "");
  const params = new URLSearchParams({
    project: event.projectSlug,
    stage: event.stageSlug,
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
      text: text,
    });
  } catch (err) {
    logError("Background job channel reply failed", {
      eventId: event.eventId,
      channelName: event.replyTarget.channelName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function invokeAsyncWorker(event: DirectInboundEvent): Promise<void> {
  await invokeHarnessWorker({
    kind: "direct-api-async-worker",
    event: event,
  } satisfies AsyncWorkerInvocation);
}

/** Continues an async-tool completion on the worker its original request came in on. */
async function invokeAsyncToolContinuationWorker(
  event: DirectInboundEvent,
  settled: AsyncToolResultRecord,
): Promise<void> {
  if (settled.delivery?.kind === "nats") {
    await invokeNatsWorker({
      ...event,
      // An answered question streams under its own id, the one the answer
      // response names. Any other job keeps the parent's, so a reconnect that
      // attaches to the parent replays it.
      ...(settled.toolName === ASK_QUESTIONS_TOOL_NAME
        ? {}
        : { publicEventId: settled.delivery.publicEventId }),
      publicConversationKey: settled.delivery.publicConversationKey,
      connectionId: settled.delivery.connectionId,
    });

    return;
  }

  await invokeAsyncWorker(event);
}

async function invokeNatsWorker(event: DirectInboundEvent): Promise<void> {
  await invokeHarnessWorker({
    kind: "nats-worker",
    event: event,
  } satisfies NatsWorkerInvocation);
}

/**
 * Schedules one durably applied envelope on its worker. The envelope's own
 * persisted agentConfig/ephemeralSystem win over the base event's so a queued
 * request never inherits a previous request's overrides.
 */
export async function dispatchAppliedIngress(
  base: IngressDispatchScope,
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
    // This rebuild re-runs an envelope that was already admitted, and its
    // delivery (status URL included) is the stored one, so this id is never
    // published. It exists only because every direct event carries one.
    runId: createRunId(),
    agentConfig: next.agentConfig ?? base.agentConfig,
    conversationKey: base.conversationKey,
    endpointId: base.endpointId,
    projectSlug: base.projectSlug,
    stageSlug: base.stageSlug,
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
            ...(delivery.identity ? { identity: delivery.identity } : {}),
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
 * Transfers the fenced owner to the next durable FIFO application and schedules
 * it. With `settle`, the current event is settled in the same mutation; when
 * that throws, the settle has been retried on its own, so a caller's failure
 * settle normally leaves the real outcome in place.
 */
async function dispatchNextIngress(
  session: Session,
  previous: IngressDispatchScope,
  settle?: IngressSettlement,
): Promise<boolean> {
  const next = await session.takeNextIngress(settle);
  if (!next) {
    return false;
  }
  await dispatchAppliedIngress(previous, next);

  return true;
}

/**
 * Best-effort dispatch of an application that admission recovered from an
 * expired owner. Never throws: the caller's own admission response must win.
 */
async function dispatchRecoveredIngress(
  base: Parameters<typeof dispatchAppliedIngress>[0],
  admission: IngressAdmission,
): Promise<void> {
  if (!admission.recovered) {
    return;
  }
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

async function dispatchSessionMessage(
  session: Session,
  input: SessionMessageInput,
): Promise<SessionMessageResult> {
  if (!session.accountId || !session.agentId) {
    throw new Error("Session messaging requires account and agent scope");
  }
  const prepared = await prepareSessionMessage({
    accountId: session.accountId,
    agentId: session.agentId,
    sourceConversationKey: session.conversationKey,
    input: input,
  });
  const { candidate, publicEventId, publicConversationKey } = prepared;
  const delivery = candidate.delivery;
  const event: DirectInboundEvent = {
    accountId: candidate.accountId,
    agentId: candidate.agentId,
    runId: candidate.runId,
    agentConfig: candidate.agentConfig,
    eventId: candidate.eventId,
    publicEventId: publicEventId,
    conversationKey: candidate.conversationKey,
    publicConversationKey: publicConversationKey,
    events: candidate.events,
    requestedMode: candidate.requestedMode,
    idempotencyKey: candidate.idempotencyKey,
    replyTarget: {
      channelName: delivery.channel,
      source: delivery.source ?? {},
    },
  };
  const admission = await acceptIngress(candidate);
  await dispatchRecoveredIngress(event, admission);
  if (admission.outcome === "capacity") {
    throw new Error("Target conversation queue is full");
  }
  if (admission.outcome === "conflict" || admission.outcome === "rejected") {
    throw new Error("Target conversation rejected the message");
  }
  if (admission.outcome === "owner") {
    if (admission.ownerGeneration === undefined) {
      throw new Error("Session message admission has no owner generation");
    }
    try {
      await invokeAsyncWorker({
        ...event,
        ownerGeneration: admission.ownerGeneration,
      });
    } catch (error) {
      await failOwnedIngress(
        { ...event, ownerGeneration: admission.ownerGeneration },
        error instanceof Error
          ? error.message
          : "Failed to start target conversation",
      );
      throw error;
    }

    return {
      conversationKey: publicConversationKey,
      status: "accepted",
    };
  }

  return {
    conversationKey: publicConversationKey,
    status: "queued",
  };
}

async function admitInternalContinuation(
  event: DirectInboundEvent,
  delivery: IngressDelivery,
): Promise<{ admission: IngressAdmission; owned: DirectInboundEvent | null }> {
  const admission = await acceptIngress({
    accountId: event.accountId,
    agentId: event.agentId,
    eventId: event.eventId,
    runId: event.runId,
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
    return { admission: admission, owned: null };
  }
  if (admission.ownerGeneration === undefined) {
    throw new Error(
      "Continuation admission did not return an owner generation",
    );
  }

  return {
    admission: admission,
    owned: { ...event, ownerGeneration: admission.ownerGeneration },
  };
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
      ...(event.replyTarget.identity
        ? { identity: event.replyTarget.identity }
        : {}),
      source: event.replyTarget.source,
    };
  }
  const statusUrl =
    directStatusUrl(event) ?? `/v1/runs/${encodeURIComponent(event.runId)}`;

  return {
    kind: "async",
    publicEventId: event.publicEventId,
    publicConversationKey: event.publicConversationKey,
    statusUrl: statusUrl,
  };
}

/** Fire-and-forget background work on the in-process worker pool. */
async function invokeHarnessWorker(
  payload: AsyncWorkerInvocation | NatsWorkerInvocation,
): Promise<void> {
  dispatchInProcessWorker(payload.kind, (context): Promise<Response> =>
    handler(payload, context),
  );
}

function asyncToolContinuationEventId(parentEventId: string): string {
  return `${parentEventId}:async-tools`;
}

/**
 * Creates the pending result row and hands the owned event to the worker. A
 * replayed event whose row already exists is a no-op, so a retried request
 * never starts a second run.
 */
async function startOwnedAsyncRun(
  ownedEvent: DirectInboundEvent,
): Promise<void> {
  const created = await createPendingAsyncAgentResult({
    eventId: ownedEvent.eventId,
    conversationKey: ownedEvent.conversationKey,
  });
  if (!created) {
    return;
  }
  try {
    await invokeAsyncWorker(ownedEvent);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to start async worker";
    logError("Failed to invoke async worker", {
      eventId: ownedEvent.eventId,
      error: message,
    });
    await settleAsyncFailure(ownedEvent, message);
    await failOwnedIngress(ownedEvent, message);
  }
}

async function startScheduledAgentRun(
  job: CronRecord,
  firedAt: Date,
): Promise<{ eventId: string; conversationKey: string }> {
  const event = await createCronDirectEvent(job, firedAt);
  const run = await getStorage().crons.createRun({
    accountId: job.accountId,
    cronId: job.cronId,
    eventId: event.publicEventId,
    conversationKey: event.publicConversationKey,
  });
  event.cronRun = {
    cronId: job.cronId,
    runId: run.runId,
    ...(isOneTimeSchedule(job.scheduleExpression) ? { oneShot: true } : {}),
  };
  try {
    const { owned: ownedEvent } = await admitInternalContinuation(
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

/**
 * When the schedule was meant to fire, falling back to now when the payload
 * carries no usable instant, including the unsubstituted template literal.
 */
function scheduledFireTime(scheduledTime: string | undefined): Date {
  const parsed = scheduledTime ? new Date(scheduledTime) : null;

  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
}

/**
 * Best effort: a stranded cron row is recoverable from the dashboard, whereas a
 * throw here would cost the run its reply.
 */
async function removeOneShotCron(
  accountId: string,
  cronId: string,
): Promise<void> {
  await getStorage()
    .crons.remove(accountId, cronId)
    .catch((err) => {
      logError("One-time cron cleanup failed", {
        accountId: accountId,
        cronId: cronId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

async function createCronDirectEvent(
  job: CronRecord,
  firedAt: Date,
): Promise<DirectInboundEvent> {
  const publicEventId = `${job.cronId}-${crypto.randomUUID()}`;
  const publicConversationKey = job.conversationKey ?? `cron:${job.cronId}`;
  const agent = await getStorage().agents.getById(job.accountId, job.agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${job.agentId}`);
  }
  const target = await resolveReentryTarget({
    accountId: job.accountId,
    agentId: job.agentId,
    publicConversationKey: publicConversationKey,
    agentConfig: toRuntimeAgentConfig(agent.config),
  });

  return {
    accountId: job.accountId,
    agentId: job.agentId,
    runId: createRunId(),
    eventId: scopedDirectEventId(job.accountId, job.agentId, publicEventId),
    publicEventId: publicEventId,
    publicConversationKey: publicConversationKey,
    events: withScheduledRunContext(
      job,
      firedAt,
    ) as DirectInboundEvent["events"],
    requestedMode: "reject",
    idempotencyKey: publicEventId,
    ...target,
  };
}

/**
 * Where a re-entered conversation (cron, continue, a settled background job)
 * runs and answers. A live
 * channel session keeps its key, its record-narrowed config and its reply
 * target; anything else is the direct `api:` conversation on the given config.
 * The deployment scope is what puts the run's trace on the dashboard stream.
 */
async function resolveReentryTarget(options: {
  accountId: string;
  agentId: string;
  publicConversationKey: string;
  agentConfig: AgentConfig;
}): Promise<
  Pick<
    DirectInboundEvent,
    | "agentConfig"
    | "conversationKey"
    | "replyTarget"
    | "endpointId"
    | "projectSlug"
    | "stageSlug"
  >
> {
  const sessionConversationKey = accountAgentScopedKey(
    options.accountId,
    options.agentId,
    options.publicConversationKey,
  );
  const [deployment, channelTarget] = await Promise.all([
    getStorage().agentDeployments.getByAgentId?.(
      options.accountId,
      options.agentId,
    ),
    getConversationDispatchTarget({
      accountId: options.accountId,
      agentId: options.agentId,
      conversationKey: sessionConversationKey,
    }),
  ]);

  return {
    agentConfig: channelTarget
      ? channelTarget.agentConfig
      : options.agentConfig,
    conversationKey: channelTarget
      ? sessionConversationKey
      : scopedDirectConversationKey(
          options.accountId,
          options.agentId,
          options.publicConversationKey,
        ),
    ...(channelTarget
      ? {
          replyTarget: {
            channelName: channelTarget.channelName,
            source: channelTarget.source,
          },
        }
      : {}),
    ...(deployment
      ? {
          endpointId: deployment.endpointId,
          projectSlug: deployment.projectSlug,
          stageSlug: deployment.stageSlug,
        }
      : {}),
  };
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
      // Skip results the model already pulled via async_status. Re-injecting them
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
    start: function (controller) {
      return runWithObservabilityScope(async () => {
        const subagentCoordinator = new SubagentCoordinator(
          session,
          event.agentConfig,
          waitUntilMs(context),
          { dispatchNextIngress: dispatchNextIngress },
        );
        const asyncToolCoordinator = new AsyncToolCoordinator(
          session,
          waitUntilMs(context),
        );
        let transferred = false;
        let terminalFailureDrained = false;
        const checkOwner = ownerCheckForStream(session);
        // Bun closes a response that writes nothing for its idleTimeout, and one
        // bash call can run silent for longer. A comment line is ignored by
        // every SSE parser.
        const keepalive = setInterval((): void => {
          try {
            controller.enqueue(textEncoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
          }
        }, SSE_KEEPALIVE_INTERVAL_MS);
        // Once the client is gone the enqueue below throws about its closed
        // controller, which says nothing about the run. The run's own reason is
        // the one worth storing and logging.
        let streamFailureText: string | null = null;

        try {
          const result = await runParentContinuationLoop({
            session: session,
            subagentCoordinator: subagentCoordinator,
            asyncToolCoordinator: asyncToolCoordinator,
            initialTurnContext: initialTurnContext,
            agentConfig: event.agentConfig,
            consumeStream: async (stream): Promise<void> => {
              try {
                await pipeAgentStream(stream, async (chunk): Promise<void> => {
                  await checkOwner(chunk);
                  controller.enqueue(
                    textEncoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
                  );
                });
              } finally {
                streamFailureText = stream.failureText();
              }
            },
            onHeartbeat: async (pendingCount) => {
              await session.assertCurrentOwner();
              controller.enqueue(
                textEncoder.encode(
                  `: waiting for async work pending=${pendingCount}\n\n`,
                ),
              );
            },
          });
          transferred = await dispatchNextIngress(
            session,
            event,
            turnSettlement(result),
          );
        } catch (err) {
          const error =
            streamFailureText ??
            (err instanceof Error ? err.message : String(err));
          logError("Direct continuation stream failed", {
            eventId: event.eventId,
            error: error,
          });
          // Emit before draining: promoting queued work moves the owner
          // generation, so a later assertCurrentOwner() would drop this frame.
          await session
            .assertCurrentOwner()
            .then(() => {
              controller.enqueue(
                textEncoder.encode(
                  `data: ${JSON.stringify({ type: "error", error: error })}\n\n`,
                ),
              );
            })
            .catch(() => {});
          transferred = await settleFailedIngressAndDrain(session, error, () =>
            dispatchNextIngress(session, event),
          );
          terminalFailureDrained = true;
        } finally {
          clearInterval(keepalive);
          if (!terminalFailureDrained && !transferred) {
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
    onQuestionsPending?(questions: PendingQuestionSummary[]): Promise<void>;
    streamMessage?(stream: AgentLoopStream): Promise<void>;
  },
  hooks?: HookDispatcher,
): Promise<{
  didFail: boolean;
  failureText: string | null;
  traceId?: string;
  questions: PendingQuestionSummary[];
}> {
  const subagentCoordinator = new SubagentCoordinator(
    session,
    agentConfig,
    waitUntilMs(context),
    { dispatchNextIngress: dispatchNextIngress },
  );
  const asyncToolCoordinator = new AsyncToolCoordinator(
    session,
    waitUntilMs(context),
  );
  const result = await runParentContinuationLoop({
    session: session,
    subagentCoordinator: subagentCoordinator,
    asyncToolCoordinator: asyncToolCoordinator,
    initialTurnContext: initialTurnContext,
    agentConfig: agentConfig,
    ...(hooks ? { hooks: hooks } : {}),
    ...(reply.onQuestionsPending
      ? { onQuestionsPending: reply.onQuestionsPending }
      : {}),
    consumeStream:
      reply.streamMessage ??
      (async (stream) => {
        await stream.consumeStream();
      }),
  });
  if (result.approvals.length > 0) {
    await reply.onApprovalRequired?.(result.approvals);

    return {
      didFail: false,
      failureText: null,
      ...(result.traceId ? { traceId: result.traceId } : {}),
      questions: [],
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
      ...(result.traceId ? { traceId: result.traceId } : {}),
      questions: [],
    };
  }

  if (result.finalResponse !== undefined) {
    await reply.onFinalText(result.finalResponse, result.traceId);
  }

  return {
    didFail: false,
    failureText: null,
    ...(result.traceId ? { traceId: result.traceId } : {}),
    questions: result.questions,
  };
}

/**
 * Runs parent model passes until there is no runnable injected work.
 *
 * Heartbeats are emitted only while this request or worker waits on
 * in-process subagents and async tools. Detached sandbox background jobs
 * settle through their completion callback, not through pending work here.
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
  onQuestionsPending?(questions: PendingQuestionSummary[]): Promise<void>;
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
        onQuestionsPending: async (questions) => {
          await options.onQuestionsPending?.(questions);
        },
      },
      {
        dispatchAppliedIngress: dispatchAppliedIngress,
        dispatchSubagents: options.subagentCoordinator.dispatch,
        dispatchAsyncTools: options.asyncToolCoordinator.dispatch,
        dispatchSessionMessage: (
          input: SessionMessageInput,
        ): Promise<SessionMessageResult> =>
          dispatchSessionMessage(options.session, input),
        pendingWork: (): TaskWaitingOn | undefined =>
          options.subagentCoordinator.pendingCount > 0
            ? "subagent"
            : options.asyncToolCoordinator.pendingCount > 0
              ? "tool"
              : undefined,
        hooks: hooks,
      },
    );
    traceId = stream.traceId();

    await options.consumeStream(stream);
    if (approvals.length > 0) {
      return {
        didFail: false,
        failureText: null,
        ...(finalResponse !== undefined
          ? { finalResponse: finalResponse }
          : {}),
        ...(traceId ? { traceId: traceId } : {}),
        approvals: approvals,
        questions: [],
      };
    }
    // Like an approval: the answer resumes the conversation later, so nothing
    // waits for injected work now.
    const questions = stream.questionSummaries();
    if (questions.length > 0) {
      return {
        didFail: false,
        failureText: null,
        ...(finalResponse !== undefined
          ? { finalResponse: finalResponse }
          : {}),
        ...(traceId ? { traceId: traceId } : {}),
        approvals: [],
        questions: questions,
      };
    }
    if (stream.didFail()) {
      // Subagents dispatched by an earlier step may still be running. Returning
      // now leaves them spinning "running" forever in the dashboard: the running
      // span is durable, the terminal one never gets flushed. Bounded by the same
      // deadline budget as the success path.
      if (options.subagentCoordinator.pendingCount > 0) {
        await options.subagentCoordinator.waitForIdle({
          onHeartbeat: options.onHeartbeat,
        });
      }

      return {
        didFail: true,
        failureText: stream.failureText(),
        ...(finalResponse !== undefined
          ? { finalResponse: finalResponse }
          : {}),
        ...(traceId ? { traceId: traceId } : {}),
        approvals: [],
        questions: [],
      };
    }

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
        ...(finalResponse !== undefined
          ? { finalResponse: finalResponse }
          : {}),
        ...(traceId ? { traceId: traceId } : {}),
        approvals: [],
        questions: [],
      };
    }

    turnContext = await options.session.createTurnContext();
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      return {
        didFail: false,
        failureText: null,
        ...(finalResponse !== undefined
          ? { finalResponse: finalResponse }
          : {}),
        ...(traceId ? { traceId: traceId } : {}),
        approvals: [],
        questions: [],
      };
    }
  }
}

/**
 * Bridges one completed parent model pass to the next continuation pass: waits
 * for outstanding in-process work, heartbeats while waiting, and injects
 * parent-visible completions plus timeout notices near the request or worker
 * deadline. Detached sandbox background jobs add no in-memory pending work, so
 * waiting here only holds the caller for subagents and async tools.
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

// The SSE body and the NATS worker share this pump; only `send` differs.
async function pipeAgentStream(
  stream: AgentLoopStream,
  send: (chunk: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  let emittedErrorChunk = false;
  for await (const value of readAgentFullStream(stream)) {
    if (isErrorStreamChunk(value)) {
      emittedErrorChunk = true;
    }
    await send(value as Record<string, unknown>);
  }

  const failureText = stream.failureText();
  if (failureText && !emittedErrorChunk) {
    await send({ type: "error", error: failureText });
  }
  const finalResponse = stream.finalResponse();
  if (stream.hasStructuredOutput() && finalResponse !== undefined) {
    await send({ type: "structured-output", output: finalResponse });
  }
}

function waitUntilMs(context: RequestContext | undefined): number {
  if (context?.deadlineMs && Number.isFinite(context.deadlineMs)) {
    return Math.max(Date.now(), context.deadlineMs - WAIT_DEADLINE_MARGIN_MS);
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
      start: function (controller) {
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function errorSseResponse(error: string, statusCode = 200): Response {
  return new Response(
    new ReadableStream({
      start: function (controller) {
        controller.enqueue(
          textEncoder.encode(
            `data: ${JSON.stringify({ type: "error", error: error })}\n\n`,
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
  runId: string,
  statusUrl: string,
  event: Pick<
    DirectInboundEvent,
    "publicEventId" | "publicConversationKey" | "requestedMode"
  >,
  status: string,
): Response {
  return jsonResponse(202, {
    runId: runId,
    eventId: event.publicEventId,
    conversationKey: event.publicConversationKey,
    status: status,
    requestedMode: event.requestedMode,
    statusUrl: statusUrl,
  });
}

function directStatusUrl(
  event: Pick<DirectInboundEvent, "runId">,
): string | null {
  const baseUrl = getHarnessPublicUrl();
  if (!baseUrl) return null;

  return `${baseUrl}/v1/runs/${encodeURIComponent(event.runId)}`;
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
      ? errorResponse(
          429,
          message,
          { code: "ingress_capacity" },
          INGRESS_RETRY_HEADERS,
        )
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
  // A duplicate answers with the first admission's run id, never the one this
  // retry minted, so an idempotent POST keeps pointing at one run.
  const runId = admission.runId ?? event.runId;
  const statusUrl = directStatusUrl({ runId: runId });

  return jsonResponse(202, {
    runId: runId,
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
    return errorResponse(
      429,
      "Conversation ingress queue is at capacity",
      { code: "ingress_capacity" },
      INGRESS_RETRY_HEADERS,
    );
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
  const runId = admission.runId ?? event.runId;
  const statusUrl = directStatusUrl({ runId: runId }) ?? event.statusUrl;

  return acceptedAsyncResponse(
    runId,
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

/** The terminal envelope outcome of a finished parent turn, for settle or takeNext. */
function turnSettlement(result: ParentContinuationResult): IngressSettlement {
  if (result.didFail) {
    return {
      status: "failed",
      error: result.failureText ?? AGENT_PROCESSING_FAILED,
    };
  }
  if (result.approvals.length > 0) {
    return {
      status: "completed",
      result: { status: "awaiting_approval", approvals: result.approvals },
    };
  }
  if (result.questions.length > 0) {
    return {
      status: "completed",
      result: { status: "awaiting_input", questions: result.questions },
    };
  }

  return {
    status: "completed",
    ...(result.finalResponse !== undefined
      ? { result: result.finalResponse }
      : {}),
  };
}
