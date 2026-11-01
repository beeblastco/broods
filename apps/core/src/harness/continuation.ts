import type { JSONValue, SystemModelMessage } from "ai";
import type { TaskWaitingOn } from "../../../../packages/broods/src/observability-contracts.ts";
import type { RequestContext } from "../shared/http.ts";
import { logError } from "../shared/log.ts";
import { AsyncToolCoordinator } from "./async-tools.ts";
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
// Leaves the parent time for the turn that reads the results; the harness winds down in it too.
const WAIT_DEADLINE_MARGIN_MS = DEADLINE_WIND_DOWN_MS;
const DEFAULT_PARENT_WAIT_MS = 8 * 60 * 1000;

/** Ownership writers live in handler.ts and come in here, so this module never imports it. */
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
  const asyncToolCoordinator = new AsyncToolCoordinator(session, (): number =>
    waitUntilMs(context),
  );
  const result = await runParentContinuationLoop({
    session: session,
    subagentCoordinator: subagentCoordinator,
    asyncToolCoordinator: asyncToolCoordinator,
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

export async function runParentContinuationLoop(options: {
  session: Session;
  subagentCoordinator: SubagentCoordinator;
  asyncToolCoordinator: AsyncToolCoordinator;
  initialTurnContext: TurnContextSnapshot;
  agentConfig: DirectInboundEvent["agentConfig"];
  dependencies: ContinuationDependencies;
  hooks?: HookDispatcher;
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

  // Writes earlier async results into history so a retry sees them instead of redoing the work.
  const keepAsyncResultsOnFailure = async (
    failed: boolean,
    stopped: boolean,
  ): Promise<void> => {
    if (!failed || stopped || options.context?.abortSignal?.aborted) {
      return;
    }
    await waitAndDrainAsyncWork(
      options.subagentCoordinator,
      options.asyncToolCoordinator,
      {
        onHeartbeat: (pendingCount: number): void | Promise<void> =>
          options.onHeartbeat?.(pendingCount),
      },
    ).catch((error: unknown) =>
      logError("Failed run could not keep its async results", {
        eventId: options.session.eventId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  // One dispatcher per parent request, so every pass and subagent fire-point share ctx.state.
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
        dispatchAsyncTools: options.asyncToolCoordinator.dispatch,
        dispatchSessionMessage: (
          input: SessionMessageInput,
        ): Promise<SessionMessageResult> =>
          options.dependencies.dispatchSessionMessage(options.session, input),
        pendingWork: (): TaskWaitingOn | undefined =>
          options.subagentCoordinator.runningCount > 0
            ? "subagent"
            : options.asyncToolCoordinator.pendingCount > 0
              ? "tool"
              : undefined,
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
    // Write finished results first, or the hand-back sweep would also resume them.
    if (stream.yielded()) {
      await options.asyncToolCoordinator.drainCompletionsToParent();
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
    const questions = stream.questionSummaries();
    if (questions.length > 0) {
      return passResult({ questions: questions });
    }
    const stopped = stream.failureText() === USER_STOP_MESSAGE;
    if (stopped) {
      options.subagentCoordinator.stopChildren();
    }
    await keepAsyncResultsOnFailure(stream.didFail(), stopped);
    if (stream.didFail()) {
      return passResult({ didFail: true, failureText: stream.failureText() });
    }

    const injected = await waitAndDrainAsyncWork(
      options.subagentCoordinator,
      options.asyncToolCoordinator,
      {
        onHeartbeat: (pendingCount: number): void | Promise<void> =>
          options.onHeartbeat?.(pendingCount),
      },
    );
    if (injected === 0) {
      return passResult();
    }

    turnContext = await options.session.createTurnContext();
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      return passResult();
    }
  }
}

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

export function waitUntilMs(context: RequestContext | undefined): number {
  if (context?.deadlineMs && Number.isFinite(context.deadlineMs)) {
    return Math.max(Date.now(), context.deadlineMs - WAIT_DEADLINE_MARGIN_MS);
  }

  return Date.now() + DEFAULT_PARENT_WAIT_MS;
}

/** One-turn system messages are not stored, so they carry over into the reloaded history. */
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

/** Detached sandbox jobs settle through their completion callback, so they add no wait here. */
async function waitAndDrainAsyncWork(
  subagentCoordinator: SubagentCoordinator,
  asyncToolCoordinator: AsyncToolCoordinator,
  options: {
    onHeartbeat?: (pendingCount: number) => void | Promise<void>;
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

  const onHeartbeat = (): void | Promise<void> =>
    options.onHeartbeat?.(
      subagentCoordinator.pendingCount + asyncToolCoordinator.pendingCount,
    );
  const subagentStatus = await subagentCoordinator.waitForIdle({
    onHeartbeat: onHeartbeat,
  });
  if (subagentStatus === "question") {
    const [subagentCount, asyncToolCount] = await Promise.all([
      subagentCoordinator.drainCompletionsToParent(),
      asyncToolCoordinator.drainCompletionsToParent(),
    ]);

    return subagentCount + asyncToolCount;
  }
  const asyncToolStatus = await asyncToolCoordinator.waitForIdle({
    onHeartbeat: onHeartbeat,
  });

  const [subagentCount, asyncToolCount] = await Promise.all([
    subagentStatus === "idle"
      ? subagentCoordinator.drainCompletionsToParent()
      : subagentCoordinator.drainCompletionsAndDetachToParent(),
    asyncToolStatus === "idle"
      ? asyncToolCoordinator.drainCompletionsToParent()
      : asyncToolCoordinator.drainCompletionsAndTimeoutsToParent(),
  ]);

  return subagentCount + asyncToolCount;
}
