import type {
  JSONValue,
  SystemModelMessage,
  TextStreamPart,
  ToolModelMessage,
  ToolSet,
  UserModelMessage,
} from "ai";
import { stripUndefined } from "@broods/convex/model/objects";
import { extractBearerToken, isServiceToken } from "../shared/auth.ts";
import {
  extractText,
  formatChannelErrorText,
  sendChannelFailure,
} from "../shared/channels.ts";
import { markHandlerEntry } from "../shared/cold-start.ts";
import {
  executeCommand,
  queuedCommand,
  resolveChannelCommand,
  type QueuedCommand,
} from "../shared/commands.ts";
import {
  isChannelTraceEnabled,
  toRuntimeAgentConfig,
  type AgentConfig,
} from "../shared/domain/agent-config.ts";
import {
  isOneTimeSchedule,
  withScheduledRunContext,
  type CronRecord,
  type CronRunRecord,
} from "../shared/domain/cron.ts";
import {
  channelPrincipalChain,
  delegatedChain,
  directPrincipalChain,
  runPrincipal,
} from "../shared/domain/principal.ts";
import { booleanEnv, optionalEnv } from "../shared/env.ts";
import { toErrorMessage } from "../shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  parseJsonBody,
  type CoreRequest,
  type RequestContext,
} from "../shared/http.ts";
import {
  collectSecretValues,
  logDebug,
  logError,
  logInfo,
  logWarn,
} from "../shared/log.ts";
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
  subagentTaskNonce,
} from "../shared/runtime-keys.ts";
import { getStorage } from "../shared/storage.ts";
import { resolveAgentRuntime } from "../shared/workspaces.ts";
import {
  createPendingAsyncAgentResult,
  getAsyncAgentResult,
  recordAsyncAgentResult,
  type AsyncAgentOutcome,
} from "./async-agent-result.ts";
import {
  getAsyncToolResult,
  rootEventId,
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
  recordFailedTurn,
  runCompactCommand,
  type ToolApprovalSummary,
} from "./harness.ts";
import {
  applyMessageSendingHook,
  createAgentHookDispatcher,
} from "./hook-dispatcher.ts";
import {
  acceptIngress,
  getConversationDispatchTarget,
  getIngressStatusByEventId,
  INGRESS_RETRY_HEADERS,
  loadAppliedIngressConfig,
  loadChannelSessionConfig,
  outcomeSettlement,
  prepareSessionMessage,
  takeNextIngress,
  type AppliedIngress,
  type IngressAdmission,
  type IngressCandidate,
  type IngressConfigRef,
  type IngressDelivery,
  type IngressMode,
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
  type ReentryTarget,
  type SandboxJobCompletionInboundEvent,
  type StatusInboundEvent,
} from "./integrations.ts";
import { LiveNatsPublisher } from "./nats-publisher.ts";
import {
  admitRun,
  refundRun,
  planRefusalResponse,
  planRefusalText,
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
  type QuestionAnswerResult,
} from "./questions.ts";
import {
  acceptedAsyncResponse,
  asyncAdmissionResponse,
  continuationResponse,
  CONVERSATION_BUSY,
  directAdmissionResponse,
  directStatusUrl,
  emptySseResponse,
  errorSseResponse,
  natsStartResponse,
  pipeAgentStream,
  type ContinuationOutcome,
} from "./responses.ts";
import {
  SubagentCoordinator,
  type SubagentParent,
  type SubagentResumeOutcome,
} from "./subagents.ts";
import {
  dispatchInProcessWorker,
  WORKER_QUEUE_FULL,
  withQueuePlace,
} from "./worker-queue.ts";
import {
  AGENT_PROCESSING_FAILED,
  isRunnableModelInput,
  runAgentLoopUntilSubagentsIdle,
  runParentContinuationLoop,
  turnSettlement,
  waitUntilMs,
  type ContinuationDependencies,
} from "./continuation.ts";

const CONTINUE_TURN_TEXT =
  "Your previous turn was cut off before it finished. Continue the task from where you left off.";
const NO_RUN_OUTCOMES: ReadonlySet<IngressAdmission["outcome"]> = new Set([
  "duplicate",
  "rejected",
  "capacity",
  "conflict",
]);
const CHANNEL_APPROVAL_DENIAL_REASON =
  "Tool approval is only supported through the direct API.";
const ENABLE_DIRECT_API = booleanEnv("ENABLE_DIRECT_API", true);
const ENABLE_WEBSOCKET = booleanEnv("ENABLE_WEBSOCKET", false);
const DEFAULT_DASHBOARD_URL = "https://dashboard.broods.app";
// Well under the server's 255s idleTimeout and the gateway's own idle limit.
const SSE_KEEPALIVE_INTERVAL_MS = 30_000;
// A stale run must not land a frame the client acts on in the next owner's stream.
// `waiting` fires on a timer, not per token, so checking it exactly costs nothing.
const OWNER_CHECK_EXACT_FRAME_TYPES: ReadonlySet<string> = new Set([
  "done",
  "error",
  "question-request",
  "structured-output",
  "tool-approval-request",
  "waiting",
]);
const textEncoder = new TextEncoder();
const CONTINUATION_DEPENDENCIES: ContinuationDependencies = {
  dispatchAppliedIngress: dispatchAppliedIngress,
  dispatchSessionMessage: dispatchSessionMessage,
  subagents: {
    dispatchNextIngress: dispatchNextIngress,
    resumeParent: resumeAfterSubagentResult,
  },
};

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
  scheduledTime?: string;
}

interface DirectTurn {
  session: Session;
  turnContext: Awaited<ReturnType<Session["createTurnContext"]>>;
}

export async function handler(
  event:
    | CoreRequest
    | AsyncWorkerInvocation
    | NatsWorkerInvocation
    | CronInvocation,
  context?: RequestContext,
): Promise<Response> {
  // Request-private, so concurrent tenants never share log redaction secrets or NATS tags.
  return runWithObservabilityScope(() => handleRequest(event, context));
}

export function ownerCheckForStream(
  session: Pick<Session, "assertCurrentOwner" | "assertRecentOwner">,
): (frame: Record<string, unknown>) => Promise<void> {
  return async (frame): Promise<void> => {
    // The SDK emits `start` before any step proves the owner, and it carries no model output.
    if (frame.type === "start") return;
    const exact =
      typeof frame.type === "string" &&
      OWNER_CHECK_EXACT_FRAME_TYPES.has(frame.type);
    await (exact ? session.assertCurrentOwner() : session.assertRecentOwner());
  };
}

export async function settleCronRun(
  accountId: string,
  cronRun: DirectInboundEvent["cronRun"],
  outcome: AsyncAgentOutcome,
): Promise<void> {
  if (!cronRun) return;
  const crons = getStorage().crons;
  if (outcome.status === "failed") {
    await crons.failRun(
      accountId,
      cronRun.cronId,
      cronRun.runId,
      outcome.error,
    );
  } else if (outcome.status === "completed") {
    await crons.completeRun(
      accountId,
      cronRun.cronId,
      cronRun.runId,
      outcome.response,
    );
  } else {
    return;
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
      // Refused before the plan counts it or ingress records it: a same-eventId retry starts anew.
      handleDirectRequest: async (event): Promise<Response> =>
        (await withQueuePlace(() => handleDirectRequest(event))) ??
        queueFullResponse(event.accountId, (): Response =>
          event.connectionId || event.answers?.length || event.continuation
            ? errorResponse(503, WORKER_QUEUE_FULL, {}, INGRESS_RETRY_HEADERS)
            : errorSseResponse(WORKER_QUEUE_FULL, 503, INGRESS_RETRY_HEADERS),
        ),
      handleAsyncRequest: async (event): Promise<Response> =>
        (await withQueuePlace(() => handleAsyncRequest(event))) ??
        queueFullResponse(event.accountId, (): Response =>
          errorResponse(503, WORKER_QUEUE_FULL, {}, INGRESS_RETRY_HEADERS),
        ),
      handleStatusRequest: handleStatusRequest,
      handleSandboxJobCompletionRequest: handleSandboxJobCompletionRequest,
      handleChannelRequest: handleChannelRequest,
      handleChannelContext: handleChannelContext,
    },
    {
      directApiEnabled: ENABLE_DIRECT_API,
      cacheAgentLists: true,
      ...(context?.waitUntil
        ? { waitUntil: context.waitUntil.bind(context) }
        : {}),
    },
  );
}

// A plan refusal (402/429) wins over the queue's 503, which the client would only retry.
async function queueFullResponse(
  accountId: string,
  full: () => Response,
): Promise<Response> {
  const { refusal } = await admitRun(accountId, { count: false });

  return refusal ? planRefusalResponse(refusal) : full();
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
  const firedAt = scheduledFireTime(event.scheduledTime);
  const { refusal } = await admitRun(job.accountId);
  if (refusal) {
    await crons.markFailed(job.accountId, job.cronId, refusal.message, firedAt);
    if (isOneTimeSchedule(job.scheduleExpression)) {
      await removeOneShotCron(job.accountId, job.cronId);
    }

    return refusal;
  }

  try {
    const result = await startScheduledAgentRun(job, firedAt);
    logInfo("Cron agent run invoked", {
      accountId: job.accountId,
      cronId: job.cronId,
      agentId: job.agentId,
      eventId: result.eventId,
      conversationKey: result.conversationKey,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logError("Cron agent run failed", {
      accountId: job.accountId,
      cronId: job.cronId,
      agentId: job.agentId,
      error: error,
    });
    if (isOneTimeSchedule(job.scheduleExpression)) {
      await removeOneShotCron(job.accountId, job.cronId);
    }
    throw err;
  }

  return null;
}

// Authed by the per-job token on the stored row, so a sandbox never holds an account key.
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
    secretValues: await asyncToolRowSecretValues(existing),
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

// A job callback arrives outside any run, so rebuild the redaction set that run used.
async function asyncToolRowSecretValues(
  row: AsyncToolResultRecord,
): Promise<string[]> {
  const scope = parseAccountAgentFromScopedKey(row.parentEventId);
  const agent = scope
    ? await getStorage().agents.getById(scope.accountId, scope.agentId)
    : null;
  if (!scope || !agent) {
    return [];
  }
  const agentConfig = toRuntimeAgentConfig(agent.config);
  try {
    const { sandboxes, workspaces } = await resolveAgentRuntime(agentConfig, {
      accountId: scope.accountId,
      agentId: scope.agentId,
    });

    return collectSecretValues([agentConfig, sandboxes, workspaces]);
  } catch (err) {
    logWarn("Background job secrets resolved from the agent config only", {
      resultId: row.resultId,
      error: toErrorMessage(err),
    });

    return collectSecretValues(agentConfig);
  }
}

export async function continueAfterAsyncToolSettlement(
  settled: AsyncToolResultRecord,
): Promise<ContinuationOutcome> {
  const scope = parseAccountAgentFromScopedKey(settled.parentEventId);
  // Stored by async_status or the parent's append: resuming would answer it twice.
  if (
    !scope ||
    settled.status === "processing" ||
    settled.handback === "stored"
  ) {
    return { kind: "skip" };
  }
  const publicEventId = `async-tools-${settled.resultId}`;
  const question = settled.toolName === ASK_QUESTIONS_TOOL_NAME;

  return resumeConversation({
    ...scope,
    eventId: asyncToolContinuationEventId(settled),
    publicEventId: publicEventId,
    toolResultId: settled.resultId,
    conversationKey: settled.conversationKey,
    // An answer streams under the id its response names; other jobs keep the parent's for replay.
    delivery:
      question && settled.delivery?.kind === "nats"
        ? { ...settled.delivery, publicEventId: publicEventId }
        : settled.delivery,
    ...(settled.delivery?.kind === "async"
      ? { asyncResultEventId: settled.parentEventId }
      : {}),
    message: completionToParentMessage({
      resultId: settled.resultId,
      toolName: settled.toolName,
      input: settled.input,
      status: settled.status,
      ...(settled.response !== undefined ? { response: settled.response } : {}),
      ...(settled.error ? { error: settled.error } : {}),
    }),
    requestedMode: question ? "steer" : "followup",
  });
}

// Resumes the parent once per task id, and never once it read `resultEventId` itself.
export async function resumeAfterSubagentResult(
  parent: SubagentParent,
  taskId: string,
  message: UserModelMessage,
  resultEventId: string,
  target?: ReentryTarget,
): Promise<SubagentResumeOutcome> {
  // Root event + nonce, so a chain of late results never nests each earlier id in the next.
  const nonce = subagentTaskNonce(taskId);
  if (!parent.accountId || !parent.agentId || !nonce) {
    return "skip";
  }
  const outcome = await resumeConversation({
    accountId: parent.accountId,
    agentId: parent.agentId,
    eventId: `${rootEventId(parent.eventId)}:async-subagent:${nonce}`,
    publicEventId: `async-subagent-${nonce}`,
    conversationKey: parent.conversationKey,
    delivery: parent.delivery,
    message: message,
    requestedMode: "followup",
    resultEventId: resultEventId,
    target: target,
  });

  return outcome.kind === "skip" ? "skip" : outcome.admission;
}

export async function loadReentryTarget(
  accountId: string,
  agentId: string,
  conversationKey: string,
): Promise<ReentryTarget | null> {
  const agent = await getStorage().agents.getById(accountId, agentId);
  if (!agent) {
    return null;
  }

  return await resolveReentryTarget({
    accountId: accountId,
    agentId: agentId,
    publicConversationKey: eventPublicConversationKey(
      conversationKey,
      accountId,
      agentId,
    ),
    agentConfig: toRuntimeAgentConfig(agent.config),
  });
}

async function resumeConversation(options: {
  accountId: string;
  agentId: string;
  eventId: string;
  publicEventId: string;
  conversationKey: string;
  delivery: AsyncToolDelivery | undefined;
  asyncResultEventId?: string;
  message: UserModelMessage;
  requestedMode: IngressMode;
  resultEventId?: string;
  toolResultId?: string;
  target?: ReentryTarget;
}): Promise<ContinuationOutcome> {
  const target =
    options.target ??
    (await loadReentryTarget(
      options.accountId,
      options.agentId,
      options.conversationKey,
    ));
  if (!target) {
    return { kind: "skip" };
  }
  const publicConversationKey = eventPublicConversationKey(
    options.conversationKey,
    options.accountId,
    options.agentId,
  );

  const continuationEvent: DirectInboundEvent = {
    accountId: options.accountId,
    agentId: options.agentId,
    runId: createRunId(),
    agentConfig: target.agentConfig,
    configRef: target.configRef,
    // Without the deployment scope the resumed run never reaches Tracing.
    endpointId: target.endpointId,
    projectSlug: target.projectSlug,
    stageSlug: target.stageSlug,
    eventId: options.eventId,
    ...(options.asyncResultEventId
      ? { asyncResultEventId: options.asyncResultEventId }
      : {}),
    ...(options.delivery?.kind === "channel"
      ? {
          replyTarget: {
            channelName: options.delivery.channelName,
            ...(options.delivery.identity
              ? { identity: options.delivery.identity }
              : {}),
            source: options.delivery.source,
          },
        }
      : {}),
    publicEventId: options.publicEventId,
    conversationKey: options.conversationKey,
    publicConversationKey: publicConversationKey,
    events: [options.message],
    requestedMode: options.requestedMode,
    idempotencyKey: options.eventId,
  };

  const { admission, owned: ownedContinuation } =
    await admitInternalContinuation(
      continuationEvent,
      continuationDelivery(onSocket(continuationEvent, options.delivery)),
      {
        ...(options.resultEventId
          ? { resultEventId: options.resultEventId }
          : {}),
        ...(options.toolResultId ? { toolResultId: options.toolResultId } : {}),
      },
    );
  if (!ownedContinuation) {
    return {
      kind: "ready",
      admission: admission.outcome,
      invoked: false,
      publicEventId: continuationEvent.publicEventId,
    };
  }
  await createPendingAsyncAgentResult({
    eventId: ownedContinuation.eventId,
    conversationKey: ownedContinuation.conversationKey,
  });
  await invokeContinuationWorker(ownedContinuation, options.delivery);

  return {
    kind: "ready",
    admission: admission.outcome,
    invoked: true,
    publicEventId: continuationEvent.publicEventId,
  };
}

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

  // A socket client needs a stream to follow, or a terminal status when none starts.
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

// True when the message was an answer: a click names its prompt, typed text takes the oldest.
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
    configRef: event.configRef,
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

  return directTurnResponse(ownedEvent);
}

// On a worker slot like any other run, so MAX_INPROCESS_WORKERS bounds streamed runs too.
async function directTurnResponse(
  ownedEvent: DirectInboundEvent,
): Promise<Response> {
  // A queued run starts inside whichever run frees the slot; it must keep this request's context.
  const observability = getObservabilityContext();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start: (controller): void => {
      // Bun closes a silent response after idleTimeout; SSE parsers ignore comment lines.
      keepalive = setInterval((): void => {
        try {
          controller.enqueue(textEncoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(keepalive);
        }
      }, SSE_KEEPALIVE_INTERVAL_MS);
      const frame = (chunk: unknown): Uint8Array =>
        textEncoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
      dispatchInProcessWorker(
        "direct-sse",
        (context): Promise<void> =>
          runWithObservabilityScope(async (): Promise<void> => {
            try {
              if (cancelled) {
                await failOwnedIngress(
                  ownedEvent,
                  "The client disconnected before the run started",
                );

                return;
              }
              const command = queuedCommand(ownedEvent.events);
              if (command) {
                await runCommandTurn({
                  event: ownedEvent,
                  command: command,
                  send: async (chunk): Promise<void> => {
                    try {
                      controller.enqueue(frame(chunk));
                    } catch {}
                  },
                });

                return;
              }
              const turn = await prepareDirectTurn(ownedEvent).catch(
                (err: unknown): null => {
                  // prepareDirectTurn already settled the run as failed.
                  const error =
                    err instanceof Error ? err.message : String(err);
                  logError("Direct request pre-processing failed", {
                    eventId: ownedEvent.eventId,
                    error: error,
                  });
                  controller.enqueue(frame({ type: "error", error: error }));

                  return null;
                },
              );
              if (!turn) return;
              const { session, turnContext } = turn;
              if (!isRunnableModelInput(turnContext.messages.at(-1))) {
                await settleFailedIngressAndDrain(
                  session,
                  "Request did not produce pending model input",
                  () => dispatchNextIngress(session, ownedEvent),
                );

                return;
              }
              await streamDirectContinuation(
                ownedEvent,
                session,
                turnContext,
                controller,
                context,
              );
            } finally {
              clearInterval(keepalive);
              try {
                controller.close();
              } catch {}
            }
          }, observability),
        ownedEvent.ownerGeneration === undefined
          ? undefined
          : {
              conversationKey: ownedEvent.conversationKey,
              ownerEventId: ownedEvent.eventId,
              ownerGeneration: ownedEvent.ownerGeneration,
            },
      );
    },
    cancel: (): void => {
      cancelled = true;
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

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
    configRef: event.configRef,
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

// Always 202, whatever `background` said: a live channel session replies in its channel.
async function handleContinueRequest(
  event: DirectInboundEvent,
): Promise<Response> {
  const target = await resolveReentryTarget({
    accountId: event.accountId,
    agentId: event.agentId,
    publicConversationKey: event.publicConversationKey,
    agentConfig: event.agentConfig,
    configRef: event.configRef,
  });
  // A scoped channel key with no live session behind it has nothing to continue.
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

async function handleAsyncWorkerRequest(
  event: DirectInboundEvent,
  context?: RequestContext,
): Promise<void> {
  let session: Session | undefined;
  let transferred = false;
  let outcome: AsyncAgentOutcome | undefined;
  let recorded = false;
  let cronSettled = false;
  // The first outcome wins, as in Convex; a later call only retries a write that failed.
  const finish = async (result: AsyncAgentOutcome): Promise<void> => {
    if (recorded) {
      return;
    }
    outcome ??= result;
    await settleAsyncRun(session, event, outcome);
    recorded = true;
  };
  try {
    await createPendingAsyncAgentResult({
      eventId: event.asyncResultEventId ?? event.eventId,
      conversationKey: event.conversationKey,
    });
    const command = queuedCommand(event.events, event.replyTarget?.channelName);
    if (command) {
      session = directSession(event);
      await finish(await commandOutcome(session, command));
    } else {
      const turn = await prepareDirectTurn(event);
      if (!turn) {
        return;
      }

      ({ session } = turn);
      const { turnContext } = turn;
      if (!isRunnableModelInput(turnContext.messages.at(-1))) {
        await finish({
          status: "failed",
          error: "Request did not produce pending model input",
        });
      } else {
        await runAgentLoopUntilSubagentsIdle(
          session,
          turnContext,
          event.agentConfig,
          context,
          {
            onFinalText: async (response, traceId) => {
              await finish({ status: "completed", response: response });
              const responseText = channelReplyText(response);
              if (responseText === null) {
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
              await finish({ status: "failed", error: error });
              await pushReplyToChannel(
                session!,
                event,
                formatChannelFinalText(
                  formatChannelErrorText(error, event.replyTarget?.channelName),
                  traceId,
                  event,
                  event.replyTarget?.channelName,
                  event.agentConfig,
                ),
              );
            },
            onApprovalRequired: async (approvals) => {
              await finish({
                status: "awaiting_approval",
                approvals: approvals,
              });
            },
            onQuestionsPending: async (questions) => {
              await finish({ status: "awaiting_input", questions: questions });
            },
          },
          CONTINUATION_DEPENDENCIES,
        );
      }
    }
    // The harness swallows a callback's throw: a failed write shows only as no recorded outcome.
    if (!recorded || !outcome) {
      throw new Error("Async run ended without recording its outcome");
    }
    await settleCronRun(event.accountId, event.cronRun, outcome);
    cronSettled = true;
    transferred = await dispatchNextIngress(session, event);
  } catch (err) {
    const error = err instanceof Error ? err.message : "Async request failed";
    logError("Async direct request processing failed", {
      eventId: event.eventId,
      error: error,
    });
    const produced: AsyncAgentOutcome = outcome ?? {
      status: "failed",
      error: error,
    };
    if (!recorded) {
      // Without the lease the envelope is not ours to settle, but its polling rows still are.
      await settleAsyncRun(session, event, produced)
        .catch((): Promise<void> => recordAsyncRun(event, produced))
        .catch((writeErr: unknown): void => {
          logError("Async run outcome lost", {
            eventId: event.eventId,
            error:
              writeErr instanceof Error ? writeErr.message : String(writeErr),
          });
        });
    }
    if (!cronSettled) {
      await settleCronRun(event.accountId, event.cronRun, produced).catch(
        (cronErr: unknown): void => {
          logError("Cron run outcome lost", {
            eventId: event.eventId,
            error: cronErr instanceof Error ? cronErr.message : String(cronErr),
          });
        },
      );
    }
    if (session) {
      transferred = await dispatchNextIngress(session, event).catch(
        () => false,
      );
    }
    throw err;
  } finally {
    if (session && !transferred) {
      await session.releaseConversationLease().catch(() => {});
    }
  }
}

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

  const publisher = new LiveNatsPublisher(
    {
      accountId: event.accountId,
      agentId: event.agentId,
      conversationKey: event.publicConversationKey,
      eventId: event.publicEventId,
      connectionId: connectionId,
    },
    collectSecretValues(event.agentConfig),
  );

  const command = queuedCommand(event.events);
  if (command) {
    try {
      await runCommandTurn({
        event: event,
        command: command,
        send: (chunk): Promise<void> => publisher.publish(chunk),
      });
      await publisher.publish({ type: "done" });
    } finally {
      await publisher.close();
    }

    return;
  }
  let session: Session | undefined;
  let transferred = false;
  try {
    const turn = await prepareDirectTurn(event);
    if (!turn) {
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
      await settleFailedIngressAndDrain(
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
        (): number => waitUntilMs(context),
        CONTINUATION_DEPENDENCIES.subagents,
      );
      const asyncToolCoordinator = new AsyncToolCoordinator(
        session,
        (): number => waitUntilMs(context),
      );

      const result = await runParentContinuationLoop({
        session: session,
        subagentCoordinator: subagentCoordinator,
        asyncToolCoordinator: asyncToolCoordinator,
        initialTurnContext: turnContext,
        agentConfig: event.agentConfig,
        dependencies: CONTINUATION_DEPENDENCIES,
        ...(context ? { context: context } : {}),
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
          // Also its own event, so the gateway picks approvals out without parsing the stream.
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
      // Not in a finally: the crash path must settle first, which needs the lease.
      if (!transferred) {
        await session.releaseConversationLease().catch(() => {});
      }
    } finally {
      await publisher.close();
    }
  } catch (err) {
    await publisher.close().catch(() => {});
    // Unsettled, the envelope stays processing and this conversation's queue never drains.
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

// Resolves once durably admitted, so the webhook can ack. An at-once command takes no queue
// place, so `/stop` still reaches a run while the queue is full.
export async function handleChannelRequest(
  event: ChannelInboundEvent,
): Promise<void> {
  if (resolveChannelCommand(event).kind === "reply") {
    return admitChannelMessage(event);
  }
  if (
    await withQueuePlace(async (): Promise<true> => {
      await admitChannelMessage(event);

      return true;
    })
  ) {
    return;
  }
  const { refusal } = event.accountId
    ? await admitRun(event.accountId, { count: false })
    : { refusal: null };
  if (!refusal) throw new Error(WORKER_QUEUE_FULL);
  await event.channel.sendText(planRefusalText(refusal));
}

async function admitChannelMessage(event: ChannelInboundEvent): Promise<void> {
  const outcome = resolveChannelCommand(event);
  if (outcome.kind === "reply") {
    // Claimed, so a forwarder retry cannot run `/clear` twice and drop what came between.
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
  const command = queuedCommand(event.events, event.channelName);
  if (!command && (await settleChannelQuestion(event))) return;
  const requestedMode =
    outcome.kind === "rewrite" ? outcome.requestedMode : "steer";
  // A provider redelivery must not store its files twice; only messages with files pay this read.
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
  // Refusals are said in the channel: an error status would only make the provider redeliver.
  const plan = await admitRun(event.accountId, { claimWarning: true });
  if (plan.refusal) {
    await event.channel.sendText(planRefusalText(plan.refusal));

    return;
  }
  // Best effort: throwing would drop the message the already-claimed notice rode in on.
  if (plan.warning) {
    await event.channel.sendText(plan.warning).catch((err: unknown): void => {
      logWarn("Budget warning delivery failed", {
        eventId: event.eventId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  // Before admission: a queued turn replays only its stored events, so they must hold the media.
  const ingested = await ingestChannelAttachments(
    event.events,
    event.attachments,
    {
      accountId: event.accountId,
      agentId: event.agentId,
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
    configRef: {
      channel: { channelName: event.channelName, ...event.channelTarget },
    },
    channelTarget: event.channelTarget,
  });
  const scope: IngressDispatchScope = {
    accountId: event.accountId,
    agentId: event.agentId,
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
  // A provider's retries must not spend the per-minute run limit.
  if (NO_RUN_OUTCOMES.has(admission.outcome)) refundRun(plan, event.accountId);
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
  if (admission.outcome === "queued" && command) {
    await event.channel.sendText(
      `${command.commandToken} queued. It runs when the current turn finishes.`,
    );
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
    principal: runPrincipal(
      event,
      channelPrincipalChain(event.identity, event.channelName),
    ),
  });
  // A queued worker starts inside whichever run frees the slot; it must keep this context.
  const observability = getObservabilityContext();
  try {
    dispatchInProcessWorker(
      "channel-worker",
      (context): Promise<void> =>
        runWithObservabilityScope(
          (): Promise<void> =>
            runChannelTurns(
              event,
              scope,
              session,
              ingested.turnEvents,
              context,
            ).catch(async (err: unknown): Promise<never> => {
              await sendChannelFailure(
                event.channel,
                formatChannelErrorText(
                  err instanceof Error ? err.message : String(err),
                  event.channelName,
                ),
              ).catch((): void => {});
              throw err;
            }),
          observability,
        ),
      {
        conversationKey: session.conversationKey,
        ownerEventId: session.eventId,
        ownerGeneration: admission.ownerGeneration,
      },
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

// `incoming` keeps the byte-backed parts admission never stored; queued turns bring their own.
async function runChannelTurns(
  event: ChannelInboundEvent,
  scope: IngressDispatchScope,
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
    for (;;) {
      let settlement: IngressSettlement | undefined;
      try {
        const command = queuedCommand(incoming, event.channelName);
        if (command) {
          settlement = outcomeSettlement(
            await commandOutcome(session, command),
          );
        } else {
          const turnStartedAt = Date.now();
          const turnContext = await session
            .createTurnContext(incomingEphemeral, incoming)
            .catch((err: unknown) => {
              recordFailedTurn(session, turnStartedAt, err);
              throw err;
            });
          if (!isRunnableModelInput(turnContext.messages.at(-1))) {
            settlement = {
              status: "failed",
              error: "Request did not produce pending model input",
            };
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
                        // Falsy: the channel could not stream, so drain and reply as text.
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
                  const responseText = channelReplyText(response);
                  if (responseText === null) return;
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
                  const text = await applyMessageSendingHook(
                    hooks,
                    event.channelName,
                    formatChannelFinalText(
                      formatChannelErrorText(error, event.channelName),
                      traceId,
                      event,
                      event.channelName,
                      activeConfig,
                    ),
                  );
                  if (text !== null) {
                    await sendChannelFailure(event.channel, text);
                  }
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
              CONTINUATION_DEPENDENCIES,
              hooks,
            );
            if (approvalRequired) {
              incoming = [];
              incomingEphemeral = [];
              continue;
            }
            if (result.didFail) terminal = "failed";
            if (awaitingInput) {
              // Settled in onQuestionsPending; the answer resumes the conversation.
            } else if (terminal === "failed") {
              settlement = {
                status: "failed",
                error: result.failureText ?? AGENT_PROCESSING_FAILED,
              };
            } else if (terminal === "completed") {
              settlement = {
                status: "completed",
                ...(finalResult !== undefined ? { result: finalResult } : {}),
              };
            }
          }
        }
      } catch (err) {
        logError("Channel turn failed", {
          eventId: session.eventId,
          conversationKey: session.conversationKey,
          error: err instanceof Error ? err.message : String(err),
        });
        settlement = {
          status: "failed",
          error: err instanceof Error ? err.message : "Channel turn failed",
        };
      }

      // Envelopes hold only a config ref; rebuilding from live rows picks up a rotated key.
      let next = await session.takeNextIngress(settlement);
      while (next) {
        try {
          activeConfig = await loadAppliedIngressConfig({
            accountId: scope.accountId,
            agentId: scope.agentId,
            configRef: next.configRef,
          });
          break;
        } catch (err) {
          const error = toErrorMessage(err);
          logWarn("Queued channel turn failed: its config did not load", {
            eventId: next.eventId,
            conversationKey: event.conversationKey,
            error: error,
          });
          next = await takeNextIngress(
            {
              conversationKey: event.conversationKey,
              ownerEventId: next.eventId,
              ownerGeneration: next.ownerGeneration,
            },
            { status: "failed", error: error },
          );
        }
      }
      if (!next) {
        await session.releaseConversationLease();
        released = true;

        return;
      }
      const source =
        next.delivery.kind === "channel"
          ? (next.delivery.source ?? event.source)
          : event.source;
      // The queued sender, not the first: policy reads userId and roles from this identity.
      const identity =
        next.delivery.kind === "channel" ? next.delivery.identity : undefined;
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
        principal: runPrincipal(
          event,
          channelPrincipalChain(identity, event.channelName),
        ),
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

  // Context is stored, never run, so only the durable `events` matter.
  await session.appendIngressEvents(
    (
      await ingestChannelAttachments(event.events, event.attachments, {
        accountId: event.accountId,
        agentId: event.agentId,
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
  const result = event.ingress;
  const asyncResult = await getAsyncAgentResult(event.eventId);

  // Pollers keep waiting while the async record is nonterminal, even past the envelope's settle.
  const status =
    asyncResult &&
    (asyncResult.status === "awaiting_approval" ||
      asyncResult.status === "awaiting_input" ||
      (asyncResult.status === "processing" && result.status !== "failed"))
      ? asyncResult.status
      : result.status;

  return jsonResponse(
    200,
    stripUndefined({
      runId: event.runId,
      eventId: event.publicEventId,
      agentId: event.agentId,
      conversationKey: eventPublicConversationKey(
        result.conversationKey,
        event.accountId,
        event.agentId,
      ),
      status: status,
      requestedMode: result.requestedMode,
      appliedMode: result.appliedMode,
      appliedToEventId:
        result.appliedToEventId !== undefined
          ? publicEventIdForScope(
              result.appliedToEventId,
              event.accountId,
              event.agentId,
              event.publicEventId,
            )
          : undefined,
      result: result.result,
      stoppedByUser: result.stoppedByUser ? true : undefined,
      response: asyncResult?.response,
      approvals: asyncResult?.approvals,
      questions: asyncResult?.questions,
      error: (result.error ?? asyncResult?.error) || undefined,
    }),
  );
}

async function prepareDirectTurn(
  event: DirectInboundEvent,
): Promise<DirectTurn | null> {
  const session = directSession(event);
  const turnStartedAt = Date.now();
  try {
    const turnContext = await session.createTurnContext(
      event.ephemeralSystem,
      event.events,
    );

    return { session: session, turnContext: turnContext };
  } catch (err) {
    recordFailedTurn(session, turnStartedAt, err);
    await settleFailedIngressAndDrain(
      session,
      err instanceof Error ? err.message : "Direct turn preparation failed",
      () => dispatchNextIngress(session, event),
    );
    throw err;
  }
}

function directSession(event: DirectInboundEvent): Session {
  // Where a background job this turn launches reports back; plain API turns only poll.
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

  return new Session({
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
    principal: runPrincipal(event, directPrincipalChain(event)),
  });
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
  // A failed schedule recurses via dispatchAppliedIngress, one envelope per level, so it ends.
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

// Null when a channel tool already delivered the reply, so nothing blank gets posted.
function channelReplyText(response: JSONValue): string | null {
  const text =
    typeof response === "string" ? response : JSON.stringify(response, null, 2);

  return text.trim() === "" ? null : text;
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
    optionalEnv("BROODS_DASHBOARD_URL") ?? DEFAULT_DASHBOARD_URL
  ).replace(/\/+$/, "");
  const params = new URLSearchParams({
    project: event.projectSlug,
    stage: event.stageSlug,
    tab: "tracing",
    trace: traceId,
  });

  return `${dashboardUrl}?${params.toString()}`;
}

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
  const invocation: AsyncWorkerInvocation = {
    kind: "direct-api-async-worker",
    event: event,
  };
  await invokeHarnessWorker(invocation);
}

async function invokeContinuationWorker(
  event: DirectInboundEvent,
  delivery: AsyncToolDelivery | undefined,
): Promise<void> {
  if (delivery?.kind === "nats") {
    await invokeNatsWorker(onSocket(event, delivery));

    return;
  }

  await invokeAsyncWorker(event);
}

function onSocket(
  event: DirectInboundEvent,
  delivery: AsyncToolDelivery | undefined,
): DirectInboundEvent {
  if (delivery?.kind !== "nats") {
    return event;
  }

  return {
    ...event,
    publicEventId: delivery.publicEventId,
    publicConversationKey: delivery.publicConversationKey,
    connectionId: delivery.connectionId,
  };
}

async function invokeNatsWorker(event: DirectInboundEvent): Promise<void> {
  const invocation: NatsWorkerInvocation = {
    kind: "nats-worker",
    event: event,
  };
  await invokeHarnessWorker(invocation);
}

// Only the envelope's own overrides: a queued request must never inherit a previous one's.
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
    // Never published: the stored delivery already carries the admitted run's status URL.
    runId: createRunId(),
    agentConfig: {},
    configRef: next.configRef,
    ...(base.subagentConfig ? { subagentConfig: base.subagentConfig } : {}),
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
    event.agentConfig = await loadAppliedIngressConfig({
      accountId: base.accountId,
      agentId: base.agentId,
      configRef: next.configRef,
      subagentConfig: base.subagentConfig,
    });
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

// A throwing hand-off has retried `settle` alone, so a caller's failure settle keeps the outcome.
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

// Never throws: the caller's own admission response must win.
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
  const senderChain = session.principal && delegatedChain(session.principal);
  const event: DirectInboundEvent = {
    accountId: candidate.accountId,
    agentId: candidate.agentId,
    runId: candidate.runId,
    agentConfig: prepared.agentConfig,
    configRef: candidate.configRef,
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
    ...(senderChain ? { principalChain: senderChain } : {}),
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

// `fence`: admission refuses a result the conversation already has, and stores it otherwise.
async function admitInternalContinuation(
  event: DirectInboundEvent,
  delivery: IngressDelivery,
  fence: Pick<IngressCandidate, "resultEventId" | "toolResultId"> = {},
): Promise<{ admission: IngressAdmission; owned: DirectInboundEvent | null }> {
  const admission = await acceptIngress({
    ...fence,
    accountId: event.accountId,
    agentId: event.agentId,
    eventId: event.eventId,
    runId: event.runId,
    conversationKey: event.conversationKey,
    events: event.events,
    requestedMode: event.requestedMode,
    idempotencyKey: event.idempotencyKey,
    delivery: delivery,
    configRef: event.configRef,
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

async function invokeHarnessWorker(
  payload: AsyncWorkerInvocation | NatsWorkerInvocation,
): Promise<void> {
  const { event } = payload;
  dispatchInProcessWorker(
    payload.kind,
    (context): Promise<Response> => handler(payload, context),
    event.ownerGeneration === undefined
      ? undefined
      : {
          conversationKey: event.conversationKey,
          ownerEventId: event.eventId,
          ownerGeneration: event.ownerGeneration,
        },
  );
}

// Root event, not parent: a detached row's parent event id already names the row.
function asyncToolContinuationEventId(
  row: Pick<AsyncToolResultRecord, "parentEventId" | "resultId">,
): string {
  return `${rootEventId(row.parentEventId)}:async-tools:${row.resultId}`;
}

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
    await recordAsyncRun(ownedEvent, { status: "failed", error: message });
    await failOwnedIngress(ownedEvent, message);
  }
}

async function startScheduledAgentRun(
  job: CronRecord,
  firedAt: Date,
): Promise<{ eventId: string; conversationKey: string }> {
  const { event, run } = await openCronRun(job, firedAt).catch(
    async (err: unknown): Promise<never> => {
      await getStorage().crons.markFailed(
        job.accountId,
        job.cronId,
        err instanceof Error ? err.message : String(err),
        firedAt,
      );
      throw err;
    },
  );
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

// Now when the payload has no usable instant, e.g. an unsubstituted template literal.
function scheduledFireTime(scheduledTime: string | undefined): Date {
  const parsed = scheduledTime ? new Date(scheduledTime) : null;

  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
}

// Best effort: a stranded row is fixable in the dashboard; a throw would cost the reply.
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

async function openCronRun(
  job: CronRecord,
  firedAt: Date,
): Promise<{ event: DirectInboundEvent; run: CronRunRecord }> {
  const event = await createCronDirectEvent(job, firedAt);
  const run = await getStorage().crons.createRun(
    {
      accountId: job.accountId,
      cronId: job.cronId,
      eventId: event.publicEventId,
      conversationKey: event.publicConversationKey,
    },
    firedAt,
  );

  return { event: event, run: run };
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

async function resolveReentryTarget(options: {
  accountId: string;
  agentId: string;
  publicConversationKey: string;
  agentConfig: AgentConfig;
  configRef?: IngressConfigRef;
}): Promise<ReentryTarget> {
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

  const runConfig = channelTarget
    ? await loadChannelSessionConfig({
        accountId: options.accountId,
        agentId: options.agentId,
        target: channelTarget,
      })
    : { agentConfig: options.agentConfig, configRef: options.configRef ?? {} };

  return {
    ...runConfig,
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

async function streamDirectContinuation(
  event: DirectInboundEvent,
  session: Session,
  initialTurnContext: DirectTurn["turnContext"],
  controller: ReadableStreamDefaultController<Uint8Array>,
  context: RequestContext,
): Promise<void> {
  const subagentCoordinator = new SubagentCoordinator(
    session,
    event.agentConfig,
    (): number => waitUntilMs(context),
    CONTINUATION_DEPENDENCIES.subagents,
  );
  const asyncToolCoordinator = new AsyncToolCoordinator(session, (): number =>
    waitUntilMs(context),
  );
  let transferred = false;
  let terminalFailureDrained = false;
  const checkOwner = ownerCheckForStream(session);
  // Wins over the closed-controller error a gone client causes: store the run's own reason.
  let streamFailureText: string | null = null;

  try {
    const result = await runParentContinuationLoop({
      session: session,
      subagentCoordinator: subagentCoordinator,
      asyncToolCoordinator: asyncToolCoordinator,
      initialTurnContext: initialTurnContext,
      agentConfig: event.agentConfig,
      dependencies: CONTINUATION_DEPENDENCIES,
      context: context,
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
      streamFailureText ?? (err instanceof Error ? err.message : String(err));
    logError("Direct continuation stream failed", {
      eventId: event.eventId,
      error: error,
    });
    // Before draining: promoting queued work moves the owner generation and would drop the frame.
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
    if (!terminalFailureDrained && !transferred) {
      await session.releaseConversationLease().catch(() => {});
    }
  }
}

async function runCommandTurn(options: {
  event: DirectInboundEvent;
  command: QueuedCommand;
  send: (
    chunk: TextStreamPart<ToolSet> | { type: "error"; error: string },
  ) => Promise<void>;
}): Promise<AsyncAgentOutcome> {
  const { event } = options;
  const session = directSession(event);
  const checkOwner = ownerCheckForStream(session);
  const outcome = await commandOutcome(
    session,
    options.command,
    async (chunk): Promise<void> => {
      await checkOwner(chunk);
      await options.send(chunk);
    },
  );
  if (outcome.status === "failed") {
    await options
      .send({ type: "error", error: outcome.error })
      .catch((): void => {});
  }
  const transferred = await dispatchNextIngress(
    session,
    event,
    outcomeSettlement(outcome),
  ).catch((err: unknown): boolean => {
    logError("Queued command settle or hand-off failed", {
      eventId: event.eventId,
      conversationKey: event.conversationKey,
      error: err instanceof Error ? err.message : String(err),
    });

    return false;
  });
  if (!transferred) {
    await session.releaseConversationLease().catch((): void => {});
  }

  return outcome;
}

async function commandOutcome(
  session: Session,
  command: QueuedCommand,
  send?: (chunk: TextStreamPart<ToolSet>) => Promise<void>,
): Promise<AsyncAgentOutcome> {
  try {
    const result = await executeCommand(command.commandToken, {
      conversationKey: session.conversationKey,
      channel: session.channelActions,
      accountId: session.accountId,
      agentId: session.agentId,
      eventId: session.eventId,
      text: command.text,
      compact: (instructions: string): Promise<number> =>
        runCompactCommand(session, command.text, instructions),
    });
    const reply = result?.reply ?? "";
    if (send) {
      await send({ type: "text-start", id: session.eventId });
      await send({ type: "text-delta", id: session.eventId, text: reply });
      await send({ type: "text-end", id: session.eventId });
    }

    return result?.error === undefined
      ? { status: "completed", response: reply }
      : { status: "failed", error: result.error };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "Queued command failed",
    };
  }
}

function createChannelApprovalDenial(
  approvals: ToolApprovalSummary[],
): ToolModelMessage {
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

async function settleAsyncRun(
  session: Session | undefined,
  event: DirectInboundEvent,
  outcome: AsyncAgentOutcome,
): Promise<void> {
  const { status, ...settlement } = outcomeSettlement(outcome);
  const settled = await session?.settleIngress(status, {
    ...settlement,
    asyncResult: { eventIds: asyncResultEventIds(event), outcome: outcome },
  });
  if (!settled) await recordAsyncRun(event, outcome);
}

async function recordAsyncRun(
  event: DirectInboundEvent,
  outcome: AsyncAgentOutcome,
): Promise<void> {
  await Promise.all(
    asyncResultEventIds(event).map((eventId) =>
      recordAsyncAgentResult(eventId, outcome),
    ),
  );
}

function asyncResultEventIds(event: DirectInboundEvent): string[] {
  return [
    ...new Set([event.asyncResultEventId ?? event.eventId, event.eventId]),
  ];
}
