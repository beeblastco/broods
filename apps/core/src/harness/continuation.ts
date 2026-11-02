/**
 * The shared continuation loop of a parent run: model passes until the
 * injected subagent work is drained, and the envelope
 * settlement of the finished turn. Every entrypoint (SSE, async worker,
 * WebSocket, channel, cron) funnels through here. Ownership writers stay in
 * handler.ts and come in as dependencies; a channel turn's own settlement
 * branch stays there too.
 */

import type { JSONValue, SystemModelMessage } from "ai";
import type { TaskWaitingOn } from "../../../../packages/broods/src/observability-contracts.ts";
import type { RequestContext } from "../shared/http.ts";
import { logError } from "../shared/log.ts";
import {
  DEADLINE_WIND_DOWN_MS,
  runAgentLoop,
  USER_STOP_MESSAGE,
  type AgentLoopOptions,
  type AgentLoopStream,
  type ToolApprovalSummary,
} from "./harness.ts";
import {
  createAgentHookDispatcher,
  type HookDispatcher,
} from "./hook-dispatcher.ts";
import {
  outcomeSettlement,
  type IngressSettlement,
  type SessionMessageInput,
  type SessionMessageResult,
} from "./ingress.ts";
import type { DirectInboundEvent } from "./integrations.ts";
import type { PendingQuestionSummary } from "./questions.ts";
import type { Session, TurnContextSnapshot } from "./session.ts";
import {
  SubagentCoordinator,
  type SubagentCoordinatorDependencies,
} from "./subagents.ts";

export const AGENT_PROCESSING_FAILED = "Agent processing failed";
// What a subagent wait leaves of the request budget, so the parent
// still has time for the turn that reads the results before the deadline. The
// harness yields or winds down in that same window, so they match.
const WAIT_DEADLINE_MARGIN_MS = DEADLINE_WIND_DOWN_MS;
const DEFAULT_PARENT_WAIT_MS = 8 * 60 * 1000;

/**
 * What the loop takes from the handler: the functions that move conversation
 * ownership live there, so this module never imports it.
 */
export interface ContinuationDependencies {
  dispatchAppliedIngress: NonNullable<
    AgentLoopOptions["dispatchAppliedIngress"]
  >;
  dispatchSessionMessage(
    session: Session,
    input: SessionMessageInput,
  ): Promise<SessionMessageResult>;
  subagents: SubagentCoordinatorDependencies;
}

export interface ParentContinuationResult {
  didFail: boolean;
  failureText: string | null;
  finalResponse?: JSONValue;
  traceId?: string;
  approvals: ToolApprovalSummary[];
  questions: PendingQuestionSummary[];
}

// A persisted tool result is history, not new model input. Only user turns and
// AI SDK approval responses should start or resume a model run.
export function isRunnableModelInput(
  message:
    | DirectInboundEvent["events"][number]
    | TurnContextSnapshot["messages"][number]
    | undefined,
): boolean {
  return (
    message?.role === "user" ||
    (message?.role === "tool" &&
      message.content.length > 0 &&
      message.content.every((part) => part.type === "tool-approval-response"))
  );
}

/**
 * The continuation loop for a run that answers through callbacks (async
 * worker, channel, cron): builds the coordinators, runs the passes, and hands
 * the one outcome to the matching `reply` callback.
 */
export async function runAgentLoopUntilSubagentsIdle(
  session: Session,
  initialTurnContext: TurnContextSnapshot,
  agentConfig: DirectInboundEvent["agentConfig"],
  context: RequestContext | undefined,
  reply: {
    onFinalText(response: JSONValue, traceId?: string): Promise<void>;
    onErrorText(error: string, traceId?: string): Promise<void>;
    onApprovalRequired?(approvals: ToolApprovalSummary[]): Promise<void>;
    onQuestionsPending?(questions: PendingQuestionSummary[]): Promise<void>;
    streamMessage?(stream: AgentLoopStream): Promise<void>;
  },
  dependencies: ContinuationDependencies,
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
    (): number => waitUntilMs(context),
    dependencies.subagents,
  );
  const result = await runParentContinuationLoop({
    session: session,
    subagentCoordinator: subagentCoordinator,
    initialTurnContext: initialTurnContext,
    agentConfig: agentConfig,
    dependencies: dependencies,
    ...(hooks ? { hooks: hooks } : {}),
    ...(context ? { context: context } : {}),
    ...(reply.onQuestionsPending
      ? { onQuestionsPending: reply.onQuestionsPending.bind(reply) }
      : {}),
    consumeStream:
      reply.streamMessage?.bind(reply) ??
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
 * in-process subagents. Detached sandbox background jobs settle through their
 * completion callback, not through pending work here.
 */
export async function runParentContinuationLoop(options: {
  session: Session;
  subagentCoordinator: SubagentCoordinator;
  initialTurnContext: TurnContextSnapshot;
  agentConfig: DirectInboundEvent["agentConfig"];
  dependencies: ContinuationDependencies;
  hooks?: HookDispatcher;
  // The worker's budget: its abort ends the pass and skips the wait on async
  // work it left running, and a pass near its deadline yields the slot.
  context?: RequestContext;
  consumeStream(stream: AgentLoopStream): Promise<void>;
  onLoopErrorText?(error: string): Promise<void>;
  onApprovalRequired?(approvals: ToolApprovalSummary[]): Promise<void>;
  onQuestionsPending?(questions: PendingQuestionSummary[]): Promise<void>;
  onHeartbeat?(pendingCount: number): void | Promise<void>;
}): Promise<ParentContinuationResult> {
  let turnContext = options.initialTurnContext;
  let finalResponse: JSONValue | undefined;
  let traceId: string | undefined;

  // Builds one loop outcome; reads the latest pass's finalResponse and traceId.
  const passResult = (
    overrides: Partial<ParentContinuationResult> = {},
  ): ParentContinuationResult => ({
    didFail: false,
    failureText: null,
    ...(finalResponse !== undefined ? { finalResponse: finalResponse } : {}),
    ...(traceId ? { traceId: traceId } : {}),
    approvals: [],
    questions: [],
    ...overrides,
  });

  // Subagents from earlier steps may still be running or already done when a
  // pass fails. Wait for them and write their results into
  // the history, so the next turn ("try again") sees them instead of redoing
  // the work. A user stop or a reclaimed slot skips the wait.
  const keepAsyncResultsOnFailure = async (
    failed: boolean,
    stopped: boolean,
  ): Promise<void> => {
    if (!failed || stopped || options.context?.abortSignal?.aborted) {
      return;
    }
    await waitAndDrainAsyncWork(options.subagentCoordinator, {
      onHeartbeat: (pendingCount: number): void | Promise<void> =>
        options.onHeartbeat?.(pendingCount),
    }).catch((error: unknown) =>
      logError("Failed run could not keep its async results", {
        eventId: options.session.eventId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  // One hook dispatcher for the whole parent request: every loop iteration and
  // the subagent-finish fire-points share a single ctx.state and one storage load.
  const hooks =
    options.hooks ??
    (await createAgentHookDispatcher(
      options.session.accountId,
      options.agentConfig,
    ));
  options.subagentCoordinator.attachHooks(hooks);

  for (;;) {
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
        dispatchAppliedIngress: options.dependencies.dispatchAppliedIngress,
        dispatchSubagents: options.subagentCoordinator.dispatch,
        subagentWatch: options.subagentCoordinator,
        dispatchSessionMessage: (
          input: SessionMessageInput,
        ): Promise<SessionMessageResult> =>
          options.dependencies.dispatchSessionMessage(options.session, input),
        pendingWork: (): TaskWaitingOn | undefined =>
          options.subagentCoordinator.runningCount > 0 ? "subagent" : undefined,
        hooks: hooks,
        ...(options.context
          ? {
              ...(options.context.abortSignal
                ? { abortSignal: options.context.abortSignal }
                : {}),
              deadlineMs: options.context.deadlineMs,
              canYield: options.context.yieldSlot !== undefined,
            }
          : {}),
      },
    );
    traceId = stream.traceId();

    await options.consumeStream(stream);
    // The pass gave its slot to the next queued run; the next pass carries on
    // from the stored tool results once a slot is free again.
    if (stream.yielded()) {
      turnContext = await resumeAfterYield(
        options.session,
        options.context,
        turnContext.ephemeralSystem,
      );
      continue;
    }
    // Only a clean pass leads to another pass that can answer a subagent.
    if (
      approvals.length > 0 ||
      stream.questionSummaries().length > 0 ||
      stream.didFail()
    ) {
      options.subagentCoordinator.closeQuestions();
    }
    if (approvals.length > 0) {
      return passResult({ approvals: approvals });
    }
    // Like an approval: the answer resumes the conversation later, so nothing
    // waits for injected work now.
    const questions = stream.questionSummaries();
    if (questions.length > 0) {
      return passResult({ questions: questions });
    }
    // A stop means stop: the children it started stop too, and nothing waits
    // on the work it left running.
    const stopped = stream.failureText() === USER_STOP_MESSAGE;
    if (stopped) {
      options.subagentCoordinator.stopChildren();
    }
    await keepAsyncResultsOnFailure(stream.didFail(), stopped);
    if (stream.didFail()) {
      return passResult({ didFail: true, failureText: stream.failureText() });
    }

    const injected = await waitAndDrainAsyncWork(options.subagentCoordinator, {
      onHeartbeat: (pendingCount: number): void | Promise<void> =>
        options.onHeartbeat?.(pendingCount),
    });
    if (injected === 0) {
      return passResult();
    }

    turnContext = await options.session.createTurnContext();
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      return passResult();
    }
  }
}

/** The terminal envelope outcome of a finished parent turn, for settle or takeNext. */
export function turnSettlement(
  result: ParentContinuationResult,
): IngressSettlement {
  if (result.didFail) {
    return {
      status: "failed",
      error: result.failureText ?? AGENT_PROCESSING_FAILED,
    };
  }
  if (result.approvals.length > 0) {
    return outcomeSettlement({
      status: "awaiting_approval",
      approvals: result.approvals,
    });
  }
  if (result.questions.length > 0) {
    return outcomeSettlement({
      status: "awaiting_input",
      questions: result.questions,
    });
  }

  return {
    status: "completed",
    ...(result.finalResponse !== undefined
      ? { result: result.finalResponse }
      : {}),
  };
}

/**
 * How long a parent may wait on its subagents: up to the
 * request budget less the margin, or the default wait with no budget.
 */
export function waitUntilMs(context: RequestContext | undefined): number {
  if (context?.deadlineMs && Number.isFinite(context.deadlineMs)) {
    return Math.max(Date.now(), context.deadlineMs - WAIT_DEADLINE_MARGIN_MS);
  }

  return Date.now() + DEFAULT_PARENT_WAIT_MS;
}

/**
 * Hands a yielded pass's worker slot to the next queued run, holding the
 * conversation lease meanwhile, then reloads the stored history, which ends in
 * the cut-off step's tool results, for the next pass on the fresh budget. The
 * turn's one-turn system messages are not stored, so they carry over.
 */
async function resumeAfterYield(
  session: Session,
  context: RequestContext | undefined,
  ephemeralSystem: SystemModelMessage[],
): Promise<TurnContextSnapshot> {
  await context?.yieldSlot?.(
    session.ownerGeneration === undefined
      ? undefined
      : {
          conversationKey: session.conversationKey,
          ownerEventId: session.eventId,
          ownerGeneration: session.ownerGeneration,
        },
  );

  return session.createTurnContext(ephemeralSystem);
}

/**
 * Bridges one completed parent model pass to the next continuation pass: waits
 * for outstanding subagents, heartbeats while waiting, and injects
 * parent-visible completions, detaching the rest near the request or worker
 * deadline. Detached sandbox background jobs add no in-memory pending work, so
 * waiting here only holds the caller for subagents.
 */
async function waitAndDrainAsyncWork(
  subagentCoordinator: SubagentCoordinator,
  options: {
    onHeartbeat?: (pendingCount: number) => void | Promise<void>;
  } = {},
): Promise<number> {
  if (subagentCoordinator.pendingCount === 0) {
    return subagentCoordinator.drainCompletionsToParent();
  }

  // A subagent's question wakes the parent before the rest finish, so its
  // answer can unblock the child.
  const status = await subagentCoordinator.waitForIdle(options);

  return status === "timeout"
    ? subagentCoordinator.drainCompletionsAndDetachToParent()
    : subagentCoordinator.drainCompletionsToParent();
}
