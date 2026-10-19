/**
 * In-process subagent dispatch coordinator.
 * Keep parent/child orchestration here; the model-facing schema stays in tools.
 */

import { timingSafeEqual } from "node:crypto";
import { subagentResultDedupeKey } from "@broods/convex/model/subagentResults";
import type {
  JSONValue,
  ModelMessage,
  SystemModelMessage,
  UserModelMessage,
} from "ai";
import {
  resolveSubagentMode,
  type AgentConfig,
} from "../shared/domain/agent-config.ts";
import type { AgentRecord } from "../shared/domain/agents.ts";
import { delegatedChain, runPrincipal } from "../shared/domain/principal.ts";
import { toErrorMessage } from "../shared/errors.ts";
import { collectSecretValues, logError, logInfo } from "../shared/log.ts";
import type { NatsPublisher } from "../shared/nats.ts";
import {
  getObservabilityContext,
  runWithObservabilityScope,
} from "../shared/otel.ts";
import {
  createRunId,
  createSubagentTaskId,
  parseAccountAgentScopedKey,
  publicConversationKeyFromScoped,
  publicEventIdForScope,
  scopedDirectConversationKey,
  scopedDirectEventId,
  subagentParentEventId,
} from "../shared/runtime-keys.ts";
import { subagentKeyTag } from "../shared/run-token.ts";
import { WORKER_TIMEOUT_BUDGET_MS } from "../shared/env.ts";
import { getStorage } from "../shared/storage.ts";
import {
  createPendingAsyncAgentResult,
  listUnobservedAsyncAgentResults,
  markAsyncAgentHandback,
  recordAsyncAgentResult,
  type AsyncAgentOutcome,
  type AsyncAgentResultRecord,
  type AsyncAgentStatus,
} from "./async-agent-result.ts";
import {
  DEADLINE_WIND_DOWN_MS,
  PARENT_STOP_MESSAGE,
  readAgentFullStream,
  runAgentLoop,
  USER_STOP_MESSAGE,
  type AgentLoopStream,
  type SubagentParentContext,
} from "./harness.ts";
import {
  createAgentHookDispatcher,
  type HookDispatcher,
} from "./hook-dispatcher.ts";
import {
  acceptIngress,
  outcomeSettlement,
  type IngressAdmission,
} from "./ingress.ts";
import type { IngressDispatchScope, ReentryTarget } from "./integrations.ts";
import { LiveNatsPublisher } from "./nats-publisher.ts";
import {
  createAgentLifecycleEmitter,
  toLifecycleValue,
  type AgentLifecycleEmitter,
  type AgentLifecycleEventPayload,
} from "./lifecycle.ts";
import { Session, type TurnContextSnapshot } from "./session.ts";
import type {
  RunSubagentDispatch,
  RunSubagentDispatchResult,
  RunSubagentTaskDispatch,
  RunSubagentTaskInput,
} from "./tools/run-subagent.tool.ts";
import {
  modelValueToUserParts,
  prependTextToUserParts,
  subagentConfig,
  VIRTUAL_AGENT_PREFIX,
  virtualSubagentConfig,
} from "./tools/utils.ts";

const PERSISTENT_SUBAGENT_KEY_PREFIX = "subagent-persistent-";
// The prefix, a random UUID, and the tag core signs over it (`subagentKeyTag`).
const PERSISTENT_SUBAGENT_KEY =
  /^subagent-persistent-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{32})$/;
const DEFAULT_SUBAGENT_WAIT_BUDGET_MS = 8 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
// How long a child's ask_parent waits for the parent's answer.
const ASK_PARENT_WAIT_MS = 5 * 60 * 1000;
// What the parent model reads for a child it stopped waiting for.
const STILL_RUNNING_NOTE =
  "Still working. Its result will arrive in this conversation as a new message when it finishes, so do not redo this task.";
// How long the run that detached a child has to deliver its result before the
// recovery sweep takes it over, and the age past which nobody waits for it.
const LATE_RESULT_GRACE_MS = 2 * 60 * 1000;
const LATE_RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Rows the release before `handback` detached carry only `observed: false`.
// The sweep lists them beside the hand-back windows for one release; drop
// `undefined` from this list next release.
const SWEPT_HANDBACKS = ["detached", "pending", undefined] as const;
const LOST_SUBAGENT_ERROR =
  "Subagent stopped without a result: the runtime restarted while it was running.";
// The parent message of each lost result a sweep pass could not resume yet, so
// the next pass retries it without running its finish hook again.
let heldLostResults = new Map<string, UserModelMessage>();
// Wall clock one child turn may take. The loop winds it down to a tools-off
// answer DEADLINE_WIND_DOWN_MS before; a turn still running that long past the
// budget, stuck in a tool call, is aborted.
const SUBAGENT_BUDGET_MS = 15 * 60 * 1000;
// Past this age a finished child's result is nobody's: a child still
// processing died with its pod, and a result still `pending` has no live
// parent run left to store it. A live parent drains a result at its next step
// boundary or in its last write, within one run budget (a worker slot's, or
// a child's when the parent is itself a subagent) plus wind-down, and a
// parent that stopped waiting wrote `detached`, swept after the grace.
const PENDING_HANDBACK_MAX_AGE_MS =
  Math.max(SUBAGENT_BUDGET_MS, WORKER_TIMEOUT_BUDGET_MS) +
  DEADLINE_WIND_DOWN_MS +
  LATE_RESULT_GRACE_MS;
const SUBAGENT_BUDGET_INSTRUCTION = `You are a subagent with a ${SUBAGENT_BUDGET_MS / 60_000}-minute budget for this task. Pace yourself: near the end your tools are turned off and you must answer with what you have.`;
const SUBAGENT_BUDGET_EXCEEDED = `Subagent ran far past its ${SUBAGENT_BUDGET_MS / 60_000}-minute budget and was cut off before it answered.`;

interface SubagentCompletion {
  taskId: string;
  eventId: string;
  agentId: string;
  description?: string;
  conversationKey: string;
  status: "completed" | "failed" | "running";
  response?: JSONValue;
  error?: string;
  // What the parent actually sees, after subagent.visibility + an onSubagentFinish
  // hook. Undefined => render the raw response.
  visibleResult?: JSONValue;
}

interface ResolvedSubagentTask {
  taskId: string;
  eventId: string;
  /** Minted here, not at admission, because the dispatch hands the parent this
   * task's status URL before the child conversation is admitted. */
  runId: string;
  agentId: string;
  agentConfig: AgentConfig;
  description?: string;
  publicConversationKey: string;
  conversationKey: string;
  prompt: string;
  inheritedContext: boolean;
  parentMessages: ModelMessage[];
  parentEphemeralSystem: SystemModelMessage[];
  persistent: boolean;
  resuming: boolean;
  /** Harness children only: a machine of its own instead of the agent's shared one. */
  isolatedSandbox: boolean;
}

interface SubagentStreamState {
  emittedError: boolean;
}

type SubagentPublisherFactory = (
  task: ResolvedSubagentTask,
) => NatsPublisher | undefined;
type SubagentIngressDispatcher = (
  session: Session,
  scope: IngressDispatchScope,
) => Promise<boolean>;
/** Where a late result resumes its parent: its run's session, or what the result row kept. */
export type SubagentParent = Pick<
  Session,
  "accountId" | "agentId" | "eventId" | "conversationKey" | "delivery"
>;
/** What a late result's resume did: its admission, or "skip" with no parent to resume. */
export type SubagentResumeOutcome = IngressAdmission["outcome"] | "skip";
/**
 * Starts a new parent turn with a child's result, once per `taskId`, unless
 * the parent already read the result row `resultEventId`. The recovery sweep
 * passes the `target` it already resolved.
 */
type SubagentParentResumer = (
  parent: SubagentParent,
  taskId: string,
  message: UserModelMessage,
  resultEventId: string,
  target?: ReentryTarget,
) => Promise<SubagentResumeOutcome>;
/** Where a parent conversation re-enters, or null once its agent is gone. */
type SubagentParentLoader = (
  accountId: string,
  agentId: string,
  conversationKey: string,
) => Promise<ReentryTarget | null>;

// Collaborators the handler owns. Every one has a working default, so tests and
// non-handler callers override only what they exercise.
export interface SubagentCoordinatorDependencies {
  lifecycle?: AgentLifecycleEmitter;
  publisherFactory?: SubagentPublisherFactory;
  dispatchNextIngress?: SubagentIngressDispatcher;
  resumeParent?: SubagentParentResumer;
}

export class SubagentCoordinator {
  private readonly completions: SubagentCompletion[] = [];
  private readonly pending = new Map<string, Promise<void>>();
  private readonly pendingMetadata = new Map<
    string,
    Omit<SubagentCompletion, "status" | "response" | "error" | "visibleResult">
  >();
  // Children still running after the parent stopped waiting. Each reports
  // through `resumeParent` instead, as a new turn of the parent conversation.
  private readonly detached = new Set<string>();
  private readonly waiters = new Set<() => void>();
  // Child runs whose outcome is recorded; a later failure never overwrites it.
  private readonly recorded = new Set<string>();
  // Result rows the model already read through get_subagent_status.
  private readonly delivered = new Set<string>();
  // Result rows this pass already decided for the parent: queued for it, read
  // by it, or kept from it. A child still in `pendingMetadata` after its result
  // is one draining a follow-up, and the parent stopping is no news of that row.
  private readonly handled = new Set<string>();
  // Questions children asked, queued for the parent's next step.
  private readonly questions: Array<{
    taskId: string;
    message: UserModelMessage;
    dedupeKey: string;
  }> = [];
  // Set once no parent pass can answer, so ask_parent returns at once.
  private questionsClosed = false;
  // A child blocked in ask_parent, by taskId, resolved by the parent's answer.
  private readonly openQuestions = new Map<
    string,
    (answer: string | null) => void
  >();
  // Read, but that tool result is not saved to the parent yet.
  private readonly readUnsaved = new Set<string>();
  // The parent's user stop, which every child run listens to.
  private readonly childStop = new AbortController();
  private hooksPromise?: Promise<HookDispatcher>;

  private readonly lifecycle: AgentLifecycleEmitter;
  private readonly publisherFactory: SubagentPublisherFactory;
  private readonly dispatchNextIngress: SubagentIngressDispatcher;
  private readonly resumeParent: SubagentParentResumer;

  constructor(
    private readonly parentSession: Session,
    private readonly parentAgentConfig: AgentConfig,
    private readonly waitUntil: number | (() => number) = Date.now() +
      DEFAULT_SUBAGENT_WAIT_BUDGET_MS,
    dependencies: SubagentCoordinatorDependencies = {},
  ) {
    this.lifecycle =
      dependencies.lifecycle ??
      createAgentLifecycleEmitter(parentSession, parentAgentConfig);
    this.publisherFactory =
      dependencies.publisherFactory ??
      ((task) => createSubagentPublisher(parentSession, task));
    // Defaulting to "no envelope transferred" releases the child lease rather
    // than stranding it when a caller builds a coordinator without a dispatcher.
    this.dispatchNextIngress =
      dependencies.dispatchNextIngress ?? (async () => false);
    // Without a resumer a late result is only recorded on its status row.
    this.resumeParent =
      dependencies.resumeParent ??
      (async (): Promise<SubagentResumeOutcome> => "skip");
  }

  // A getter follows the worker's budget as a yielding run moves to a new slot.
  private get waitUntilMs(): number {
    return typeof this.waitUntil === "number"
      ? this.waitUntil
      : this.waitUntil();
  }

  private get isPersistentMode(): boolean {
    return resolveSubagentMode(this.parentAgentConfig) === "persistent";
  }

  dispatch: RunSubagentDispatch = async (
    tasks: RunSubagentTaskInput[],
    parentMessages: ModelMessage[],
    parentEphemeralSystem: SystemModelMessage[] = [],
  ): Promise<RunSubagentDispatchResult> => {
    // Capture the parent's trace/task id now, inside the parent's run_subagent
    // tool call. Each child is its own top-level trace that links back to it.
    const parentObs = getObservabilityContext();
    const subagentParent: SubagentParentContext | undefined = parentObs?.traceId
      ? {
          parentTraceId: parentObs.traceId,
          parentTaskId: this.parentSession.eventId,
        }
      : undefined;

    // Resolve all inputs before launching anything. If one task is invalid,
    // the tool call fails without starting a partial batch of child runs.
    const resolvedTasks = await Promise.all(
      tasks.map((task) =>
        this.resolveTask(task, parentMessages, parentEphemeralSystem),
      ),
    );

    // Create status rows before returning task ids so clients can poll the ids
    // as soon as the model sees the tool result.
    await Promise.all(
      resolvedTasks.map((task) =>
        createPendingAsyncAgentResult({
          eventId: task.eventId,
          conversationKey: task.conversationKey,
          subagent: {
            ...(task.description ? { description: task.description } : {}),
            parentConversationKey: this.parentSession.conversationKey,
            ...(this.parentSession.delivery
              ? { parentDelivery: this.parentSession.delivery }
              : {}),
          },
        }),
      ),
    );

    await Promise.all(
      resolvedTasks.map((task) =>
        this.lifecycle.emit("subagent.task.started", {
          taskId: task.taskId,
          agentId: task.agentId,
          conversationKey: task.publicConversationKey,
          inheritedContext: task.inheritedContext,
          persistent: task.persistent,
          resuming: task.resuming,
        }),
      ),
    );

    const dispatches = resolvedTasks.map((task) => {
      // Intentionally not awaited: child agents run concurrently while the
      // parent model can keep streaming or later wait for injected results.
      this.startTask(task, subagentParent);

      return toDispatch(task);
    });

    return { tasks: dispatches };
  };

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Children still working, waited on or not; the root span waits on them. */
  get runningCount(): number {
    return this.pending.size + this.detached.size;
  }

  async waitForIdle(
    options: {
      onHeartbeat?: (pendingCount: number) => void | Promise<void>;
    } = {},
  ): Promise<"idle" | "question" | "timeout"> {
    while (
      this.pending.size > 0 &&
      this.questions.length === 0 &&
      Date.now() < this.waitUntilMs
    ) {
      const heartbeatAt = Math.min(
        Date.now() + HEARTBEAT_INTERVAL_MS,
        this.waitUntilMs,
      );
      const timerWoke = await Promise.race([
        this.nextStateChange().then((): boolean => false),
        sleep(Math.max(heartbeatAt - Date.now(), 0)).then((): boolean => true),
      ]);

      if (this.pending.size > 0) {
        // Awaited, so a heartbeat that finds the run lost ends the wait.
        await options.onHeartbeat?.(this.pending.size);
        // No step boundary runs while the parent waits, so a user stop reaches
        // the children here, once per heartbeat interval.
        if (
          timerWoke &&
          (await this.parentSession.renewConversationLease()) === "stopped"
        ) {
          this.stopChildren();
        }
      }
    }

    if (this.questions.length > 0) return "question";

    return this.pending.size === 0 ? "idle" : "timeout";
  }

  /**
   * Waits until one of this turn's subagents records its outcome or settles, up
   * to `timeoutMs` or the parent's wait budget. get_subagent_status uses it, so a
   * status check spends one model step per change instead of one per instant
   * "processing". It returns before the child's queued follow-ups drain.
   */
  async waitForSettled(
    taskId: string,
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const pending = this.pending.get(taskId);
    if (!pending || abortSignal?.aborted) {
      return;
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<boolean>((resolve): void => {
      onAbort = (): void => resolve(true);
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
    const eventId = this.pendingMetadata.get(taskId)?.eventId;
    const deadline = Math.min(Date.now() + timeoutMs, this.waitUntilMs);
    const settled = pending.then((): boolean => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve): void => {
      timer = setTimeout((): void => resolve(true), deadline - Date.now());
    });
    try {
      while (
        this.questions.length === 0 &&
        !(eventId !== undefined && this.recorded.has(eventId))
      ) {
        const done = await Promise.race([
          settled,
          aborted,
          timedOut,
          this.nextStateChange().then((): boolean => false),
        ]);
        if (done) {
          return;
        }
      }
    } finally {
      clearTimeout(timer);
      if (onAbort) abortSignal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Records that get_subagent_status showed the model this run's outcome, by
   * the result row's event id. It counts once `confirmDelivered` runs after
   * that tool result is saved, so a failed save still gets this turn's
   * injection. The row's durable `stored` hand-back keeps a late resume away.
   */
  markDelivered(eventId: string): void {
    this.readUnsaved.add(eventId);
  }

  /**
   * Called once the parent's step output is saved. Each result read by then
   * never starts another pass: a queued injection is dropped now and one that
   * is enqueued later is skipped.
   */
  confirmDelivered(): void {
    for (const eventId of this.readUnsaved) {
      this.delivered.add(eventId);
      // A finish hook's rewrite never reached the model through the tool.
      const index = this.completions.findIndex(
        (completion): boolean =>
          completion.eventId === eventId &&
          completion.visibleResult === undefined,
      );
      if (index !== -1) {
        this.completions.splice(index, 1);
      }
    }
    this.readUnsaved.clear();
  }

  /**
   * The pass's last write of results and questions. No pass drains after it,
   * so when it fails each finished result it did not save resumes the parent
   * through `resumeParent`, each child still working is detached to resume it
   * the same way, and the run still fails.
   */
  async drainCompletionsToParent(): Promise<number> {
    try {
      return (await this.takeParentMessages()).length;
    } catch (error: unknown) {
      // A put-back running notice is dropped: its child is detached and
      // resumes the parent itself. Each result is detached first, so the
      // recovery sweep retries a resume that fails too; when that write fails
      // as well the row is still `pending`, and the sweep takes it later.
      await this.detachPending();
      const finished = this.completions
        .splice(0)
        .filter(({ status }): boolean => status !== "running");
      await Promise.all(
        finished.map(async (completion): Promise<void> => {
          await markAsyncAgentHandback(completion.eventId, "detached");
          await this.resumeParentWith(completion);
        }),
      );
      throw error;
    }
  }

  /**
   * Moves queued results and questions into the parent conversation and returns
   * them. The parent's step boundary calls it, so they reach the model mid-pass.
   */
  async takeParentMessages(): Promise<UserModelMessage[]> {
    // A running notice is stale once its child has finished: that child
    // resumed the parent with its result itself, even while the detach that
    // queued the notice was still writing.
    const completions = this.completions
      .splice(0)
      .filter(
        ({ status, taskId }): boolean =>
          status !== "running" || this.detached.has(taskId),
      );
    const questions = this.questions.splice(0);
    const messages = [
      ...completions.map(completionToParentMessage),
      ...questions.map((question): UserModelMessage => question.message),
    ];
    if (messages.length === 0) return messages;
    // One write for all of them. Each is one stored event, and a large write
    // takes several appends, so a failure puts back only what no append saved,
    // and a later step or drain delivers it without repeating the rest. An
    // append that committed but lost its reply is put back too: its dedupe key
    // makes the retry store it once.
    let saved = 0;
    await this.parentSession
      .persistModelMessages(
        messages,
        (count): void => {
          saved = count;
        },
        [
          ...completions.map(({ eventId, status }): string =>
            subagentResultDedupeKey(eventId, status),
          ),
          ...questions.map(({ dedupeKey }): string => dedupeKey),
        ],
      )
      .catch((error: unknown): never => {
        this.completions.unshift(...completions.slice(saved));
        this.restoreQuestions(
          questions.slice(Math.max(saved - completions.length, 0)),
        );
        throw error;
      });

    return messages;
  }

  /**
   * A child's ask_parent: queues the question for the parent and waits for the
   * answer, which update_subagent delivers. Null when the parent does not answer
   * in time, the child stops, it already has a question open, or no parent pass
   * is left to answer.
   */
  async askParent(
    taskId: string,
    question: string,
    abortSignal?: AbortSignal,
  ): Promise<string | null> {
    const metadata = this.pendingMetadata.get(taskId);
    if (
      !metadata ||
      this.questionsClosed ||
      this.openQuestions.has(taskId) ||
      abortSignal?.aborted
    ) {
      return null;
    }
    const budgetMs = Math.max(
      Math.min(ASK_PARENT_WAIT_MS, this.waitUntilMs - Date.now()),
      0,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const answer = new Promise<string | null>((resolve): void => {
      this.openQuestions.set(taskId, resolve);
      timer = setTimeout((): void => resolve(null), budgetMs);
      onAbort = (): void => resolve(null);
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
    this.questions.push({
      taskId: taskId,
      message: questionToParentMessage(metadata, question),
      dedupeKey: `subagent-question:${crypto.randomUUID()}`,
    });
    this.notifyCompletion();
    const result = await answer;
    clearTimeout(timer);
    if (onAbort) abortSignal?.removeEventListener("abort", onAbort);
    // A question nobody answered in time is not left for the parent to answer.
    this.openQuestions.delete(taskId);
    const queued = this.questions.findIndex((open) => open.taskId === taskId);
    if (queued !== -1) {
      this.questions.splice(queued, 1);
    }

    return result;
  }

  /**
   * The parent's user stop: aborts every running child at once, so each ends
   * as stopped rather than working on for a request nobody waits for.
   */
  stopChildren(): void {
    this.childStop.abort(new Error(USER_STOP_MESSAGE));
  }

  /**
   * For a parent that cannot run another pass: every open question resolves
   * with no answer, and later ones return at once.
   */
  closeQuestions(): void {
    this.questionsClosed = true;
    this.questions.length = 0;
    for (const resolve of this.openQuestions.values()) resolve(null);
    this.openQuestions.clear();
  }

  /** Hands the parent's message to a child blocked in ask_parent; false when none is. */
  answerQuestion(taskId: string, answer: string): boolean {
    const resolve = this.openQuestions.get(taskId);
    if (!resolve) {
      return false;
    }
    this.openQuestions.delete(taskId);
    resolve(answer);

    return true;
  }

  /**
   * The parent stops waiting: finished results go in as usual, and each child
   * still working is reported as running. Those keep running and later resume
   * the parent conversation with their result through `resumeParent`.
   */
  async drainCompletionsAndDetachToParent(): Promise<number> {
    if (this.completions.length === 0 && this.pending.size === 0) {
      return 0;
    }

    for (const metadata of await this.detachPending()) {
      // Queued like a result, so it rides the same write. A child whose
      // result the model already read is not still working news.
      if (!this.delivered.has(metadata.eventId)) {
        this.completions.push({ ...metadata, status: "running" });
      }
    }

    return this.drainCompletionsToParent();
  }

  /**
   * The parent stops waiting on every child still working: each resumes the
   * parent with its result through `resumeParent` once it finishes, and no
   * question gets an answer. Returns the children it detached.
   */
  private async detachPending(): Promise<
    Omit<
      SubagentCompletion,
      "status" | "response" | "error" | "visibleResult"
    >[]
  > {
    // A child whose result is queued is only settling its lease.
    const answered = new Set(this.completions.map(({ taskId }) => taskId));
    const detaching = [...this.pendingMetadata.values()].filter(
      ({ taskId }): boolean => !answered.has(taskId),
    );
    for (const { taskId } of detaching) this.detached.add(taskId);
    this.pending.clear();
    this.pendingMetadata.clear();
    this.closeQuestions();
    // Only the recovery sweep reads this, for a result this process never
    // delivers; the live resume needs none of it.
    await Promise.all(
      detaching
        .filter(({ eventId }): boolean => !this.handled.has(eventId))
        .map(({ eventId }): Promise<void> =>
          markAsyncAgentHandback(eventId, "detached"),
        ),
    );

    return detaching;
  }

  private async resolveTask(
    task: RunSubagentTaskInput,
    parentMessages: ModelMessage[],
    parentEphemeralSystem: SystemModelMessage[],
  ): Promise<ResolvedSubagentTask> {
    const accountId = requireParentAccountId(this.parentSession);
    const persistent = this.isPersistentMode;
    if (!persistent && task.conversationKey !== undefined) {
      throw new Error(
        "Subagent conversationKey is only supported in persistent mode",
      );
    }
    // The key comes from the model, and it shares the child agent's direct-API
    // namespace, so only a key this runtime minted for this parent may be
    // resumed: anything else could name another caller's conversation with
    // that agent, whatever form that caller gave its key.
    if (
      task.conversationKey !== undefined &&
      !this.mintedChildKey(accountId, task.conversationKey)
    ) {
      throw new Error(
        "Subagent conversationKey must be one run_subagent returned to this agent",
      );
    }
    const taskId = createSubagentTaskId(this.parentSession.eventId);
    const runId = createRunId();
    const resuming = persistent && task.conversationKey !== undefined;
    const publicConversationKey =
      task.conversationKey ??
      (persistent
        ? this.mintChildKey(accountId, crypto.randomUUID())
        : `subagent-${taskId}`);
    const inheritedContext =
      this.parentAgentConfig.subagent?.context === "inherited";
    if (task.agentId) {
      const agent = await this.resolveAllowedAgent(accountId, task.agentId);

      return {
        taskId: taskId,
        runId: runId,
        eventId: scopedDirectEventId(accountId, agent.agentId, taskId),
        agentId: agent.agentId,
        agentConfig: subagentConfig(agent.config, this.parentAgentConfig),
        ...(agent.description ? { description: agent.description } : {}),
        publicConversationKey: publicConversationKey,
        conversationKey: scopedDirectConversationKey(
          accountId,
          agent.agentId,
          publicConversationKey,
        ),
        prompt: task.prompt,
        inheritedContext: inheritedContext,
        parentMessages: parentMessages,
        parentEphemeralSystem: parentEphemeralSystem,
        persistent: persistent,
        resuming: resuming,
        isolatedSandbox: task.isolated === true,
      };
    }

    // A persistent virtual child is named by its key's UUID, so resuming the
    // key reaches the same child and its history. A one-off child by its task.
    const virtualAgentId = `${VIRTUAL_AGENT_PREFIX}${PERSISTENT_SUBAGENT_KEY.exec(publicConversationKey)?.[1] ?? taskId}`;

    return {
      taskId: taskId,
      runId: runId,
      eventId: scopedDirectEventId(accountId, virtualAgentId, taskId),
      agentId: virtualAgentId,
      agentConfig: virtualSubagentConfig(this.parentAgentConfig),
      publicConversationKey: publicConversationKey,
      conversationKey: scopedDirectConversationKey(
        accountId,
        virtualAgentId,
        publicConversationKey,
      ),
      prompt: task.prompt,
      inheritedContext: inheritedContext,
      parentMessages: parentMessages,
      parentEphemeralSystem: parentEphemeralSystem,
      persistent: persistent,
      resuming: resuming,
      isolatedSandbox: task.isolated === true,
    };
  }

  /** A persistent child's public key, tagged for this account and parent agent. */
  private mintChildKey(accountId: string, uuid: string): string {
    const scope = `${accountId}:${this.parentSession.agentId ?? ""}:${uuid}`;

    return `${PERSISTENT_SUBAGENT_KEY_PREFIX}${uuid}-${subagentKeyTag(scope)}`;
  }

  private mintedChildKey(accountId: string, key: string): boolean {
    const uuid = PERSISTENT_SUBAGENT_KEY.exec(key)?.[1];
    if (!uuid) return false;
    const expected = Buffer.from(this.mintChildKey(accountId, uuid));
    const given = Buffer.from(key);

    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private async resolveAllowedAgent(
    accountId: string,
    agentId: string,
  ): Promise<AgentRecord> {
    const allowed = this.parentAgentConfig.subagent?.allowed ?? [];
    if (!allowed.includes(agentId)) {
      throw new Error(`Subagent is not allowed: ${agentId}`);
    }

    const agent = await getStorage().agents.getById(accountId, agentId);
    if (!agent) {
      throw new Error(`Subagent not found: ${agentId}`);
    }

    return agent;
  }

  /**
   * Deliberately does not await `runTask`: the parent model gets task ids back
   * immediately while the child keeps progressing in the same request or worker.
   * Completion or failure is normalized into the coordinator queue so the parent
   * loop can inject it later.
   */
  private startTask(
    task: ResolvedSubagentTask,
    subagentParent?: SubagentParentContext,
  ): void {
    const publisher = this.createPublisher(task);
    const streamState: SubagentStreamState = { emittedError: false };
    const trackedPublisher = publisher
      ? bestEffortSubagentPublisher(publisher, streamState, task.taskId)
      : undefined;
    // The child gets its own observability cell, seeded from the parent's. On
    // the shared cell the parent's pass ending blanked the child's scope, so its
    // steps never reached the dashboard, and each child relabeled the parent.
    const promise = runWithObservabilityScope(
      () => this.runTask(task, subagentParent, trackedPublisher),
      getObservabilityContext(),
    )
      .then(async () => {
        await trackedPublisher?.publish({ type: "done" });
      })
      .catch(async (error) => {
        const errorText =
          error instanceof Error ? error.message : String(error);
        await this.completeTask({
          taskId: task.taskId,
          eventId: task.eventId,
          agentId: task.agentId,
          ...(task.description ? { description: task.description } : {}),
          conversationKey: task.publicConversationKey,
          status: "failed",
          error: errorText,
        });
        if (!streamState.emittedError) {
          await trackedPublisher?.publish({
            type: "error",
            error: errorText,
          });
        }
        await trackedPublisher?.publish({ type: "done" });
      })
      .finally(async () => {
        await trackedPublisher?.close();
        this.pending.delete(task.taskId);
        this.pendingMetadata.delete(task.taskId);
        this.detached.delete(task.taskId);
        this.notifyCompletion();
      });

    this.pending.set(task.taskId, promise);
    this.pendingMetadata.set(task.taskId, {
      taskId: task.taskId,
      eventId: task.eventId,
      agentId: task.agentId,
      ...(task.description ? { description: task.description } : {}),
      conversationKey: task.publicConversationKey,
    });
  }

  private createPublisher(
    task: ResolvedSubagentTask,
  ): NatsPublisher | undefined {
    if (this.parentAgentConfig.subagent?.stream !== true) {
      return undefined;
    }

    try {
      return this.publisherFactory(task);
    } catch (error) {
      logError("Failed to create best-effort subagent stream publisher", {
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error),
      });

      return undefined;
    }
  }

  /**
   * Ephemeral child turns run on a `persist: false` Session and store nothing.
   * Persistent child turns write the task prompt and generated child messages
   * to the child conversation while keeping inherited parent context ephemeral.
   */
  private async runTask(
    task: ResolvedSubagentTask,
    subagentParent?: SubagentParentContext,
    publisher?: NatsPublisher,
    // Set when this turn continues a queued envelope the child already owns, so
    // it reuses that fencing token instead of admitting the conversation again.
    preOwned?: { ownerGeneration: number; events: ModelMessage[] },
  ): Promise<void> {
    logInfo("Subagent task started", {
      parentEventId: this.parentSession.eventId,
      taskId: task.taskId,
      agentId: task.agentId,
      conversationKey: task.conversationKey,
      inheritedContext: task.inheritedContext,
      persistent: task.persistent,
      resuming: task.resuming,
    });

    const promptMessage: UserModelMessage = {
      role: "user",
      content: [{ type: "text", text: task.prompt }],
    };
    const incoming = preOwned?.events ?? [promptMessage];
    // Persistent children run through the same conversation coordinator as
    // top-level runs. Without an owner generation every steer and stop the
    // session exposes is a silent no-op.
    const ownerGeneration = preOwned
      ? preOwned.ownerGeneration
      : task.persistent
        ? await this.admitChildConversation(task, promptMessage)
        : undefined;
    // Inherit the parent's deployment scope (endpoint/project/stage) so the
    // child's spans and logs publish to the same live dashboard subscription and
    // its usage rows are counted in the right stage. The trigger is inherited
    // too: a child of a scheduled run must not reach the schedule tools either.
    const childSession = new Session({
      eventId: task.eventId,
      conversationKey: task.conversationKey,
      accountId: requireParentAccountId(this.parentSession),
      agentId: task.agentId,
      agentConfig: task.agentConfig,
      endpointId: this.parentSession.endpointId,
      projectSlug: this.parentSession.projectSlug,
      stageSlug: this.parentSession.stageSlug,
      ownerGeneration: ownerGeneration,
      trigger: this.parentSession.trigger,
      persist: task.persistent,
      policyDelivery: this.parentSession.policyDelivery,
      // The child acts as its own agent, delegated to by the parent's chain.
      principal: this.parentSession.principal
        ? runPrincipal(
            {
              accountId: this.parentSession.principal.accountId,
              agentId: task.agentId,
            },
            delegatedChain(this.parentSession.principal),
          )
        : undefined,
    });
    let finalResponse: JSONValue | undefined;
    let approvalRequested = false;
    const deadlineMs = Date.now() + SUBAGENT_BUDGET_MS;
    const budget = new AbortController();
    const budgetTimer = setTimeout((): void => {
      budget.abort(new Error(SUBAGENT_BUDGET_EXCEEDED));
    }, SUBAGENT_BUDGET_MS + DEADLINE_WIND_DOWN_MS);
    budgetTimer.unref?.();
    try {
      // Persistent mode writes the task prompt first so the child model response
      // and tool messages append to that conversation.
      const turnContext = await this.createChildTurnContext(
        childSession,
        task,
        incoming,
      );
      const stream = await runAgentLoop(
        childSession,
        turnContext,
        task.agentConfig,
        {
          onFinalText: async (response) => {
            finalResponse = response;
          },
          onErrorText: async (error) => {
            throw new Error(error);
          },
          onApprovalRequired: async () => {
            approvalRequested = true;
          },
        },
        {
          ...(subagentParent ? { subagentParent: subagentParent } : {}),
          isolatedSandbox: task.isolatedSandbox,
          // Never yields: the child holds no worker slot, so near its budget
          // it winds down to an answer instead.
          deadlineMs: deadlineMs,
          abortSignal: AbortSignal.any([budget.signal, this.childStop.signal]),
          ...(task.persistent
            ? {
                askParent: (
                  question: string,
                  abortSignal?: AbortSignal,
                ): Promise<string | null> =>
                  this.askParent(task.taskId, question, abortSignal),
                stopMessage: PARENT_STOP_MESSAGE,
              }
            : {}),
        },
      );

      if (publisher) {
        await pipeSubagentNatsStream(stream, publisher);
      } else {
        await stream.consumeStream();
      }
      if (approvalRequested) {
        throw new Error("Subagent task stopped for tool approval");
      }
      if (stream.didFail()) {
        throw new Error(stream.failureText() ?? "Subagent task failed");
      }
      if (finalResponse === undefined) {
        throw new Error("Subagent task returned an empty response");
      }

      await this.completeSuccessfulRun(
        childSession,
        task,
        finalResponse,
        subagentParent,
        publisher,
      );
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      await this.recordOutcome(childSession, task, {
        status: "failed",
        error: errorText,
      }).catch((settlementError: unknown): void => {
        logError("Failed to record subagent failure", {
          taskId: task.taskId,
          error:
            settlementError instanceof Error
              ? settlementError.message
              : String(settlementError),
        });
      });
      await this.drainChildConversation(
        childSession,
        task,
        subagentParent,
        publisher,
      ).catch((drainError) => {
        logError("Failed to drain subagent conversation after failure", {
          taskId: task.taskId,
          error:
            drainError instanceof Error
              ? drainError.message
              : String(drainError),
        });
      });
      throw error;
    } finally {
      clearTimeout(budgetTimer);
    }
  }

  private async completeSuccessfulRun(
    childSession: Session,
    task: ResolvedSubagentTask,
    finalResponse: JSONValue,
    subagentParent?: SubagentParentContext,
    publisher?: NatsPublisher,
  ): Promise<void> {
    await this.recordOutcome(childSession, task, {
      status: "completed",
      response: finalResponse,
    });
    await this.completeTask({
      taskId: task.taskId,
      eventId: task.eventId,
      agentId: task.agentId,
      ...(task.description ? { description: task.description } : {}),
      conversationKey: task.publicConversationKey,
      status: "completed",
      response: finalResponse,
    });
    // The durable result is authoritative. A queued-drain failure must not
    // turn this completed task into a second failed completion.
    await this.drainChildConversation(
      childSession,
      task,
      subagentParent,
      publisher,
    ).catch((error) => {
      logError("Failed to drain completed subagent conversation", {
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Records a child run's outcome on its envelope and polling row in one
   * mutation, once. A child that owns no envelope, or whose settle fails,
   * still records the row.
   */
  private async recordOutcome(
    childSession: Session,
    task: ResolvedSubagentTask,
    outcome: AsyncAgentOutcome,
  ): Promise<void> {
    if (this.recorded.has(task.eventId)) return;
    const { status, ...settlement } = outcomeSettlement(outcome);
    const settled = await childSession
      .settleIngress(status, {
        ...settlement,
        asyncResult: { eventIds: [task.eventId], outcome: outcome },
      })
      .catch((error: unknown): boolean => {
        logError("Failed to settle subagent ingress", {
          taskId: task.taskId,
          error: error instanceof Error ? error.message : String(error),
        });

        return false;
      });
    if (!settled) await recordAsyncAgentResult(task.eventId, outcome);
    this.recorded.add(task.eventId);
    this.notifyCompletion();
  }

  /**
   * Transfers ownership to the next queued envelope for this child, or releases
   * the lease when nothing is waiting. Ephemeral children never own a
   * generation, so both calls are no-ops for them.
   */
  private async drainChildConversation(
    childSession: Session,
    task: ResolvedSubagentTask,
    subagentParent?: SubagentParentContext,
    publisher?: NatsPublisher,
  ): Promise<void> {
    // Past the parent's wait budget, or after its stop, there is no live
    // parent turn left to inject into, so hand the envelope to a standalone
    // worker instead of running it here and dropping the answer.
    if (Date.now() >= this.waitUntilMs || this.childStop.signal.aborted) {
      await this.transferChildConversation(childSession, task);

      return;
    }
    const next = await childSession.takeNextIngress().catch((error) => {
      logError("Subagent queued ingress read failed", {
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error),
      });

      return null;
    });
    if (!next) {
      await childSession.releaseConversationLease().catch(() => {});

      return;
    }

    // Run the queued envelope as another turn of the same child task, so its
    // result reaches the parent through the normal completion path.
    try {
      await this.runTask(
        {
          ...task,
          eventId: next.eventId,
          resuming: true,
          inheritedContext: false,
        },
        subagentParent,
        publisher,
        {
          ownerGeneration: next.ownerGeneration,
          events: next.events as ModelMessage[],
        },
      );
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      await this.completeTask({
        taskId: task.taskId,
        eventId: next.eventId,
        agentId: task.agentId,
        ...(task.description ? { description: task.description } : {}),
        conversationKey: task.publicConversationKey,
        status: "failed",
        error: errorText,
      }).catch((completionError) => {
        logError("Failed to record queued subagent failure", {
          taskId: task.taskId,
          error:
            completionError instanceof Error
              ? completionError.message
              : String(completionError),
        });
      });
      throw error;
    }
  }

  /** Hands the next queued envelope to its own worker and drops the lease. */
  private async transferChildConversation(
    childSession: Session,
    task: ResolvedSubagentTask,
  ): Promise<void> {
    const transferred = await this.dispatchNextIngress(childSession, {
      accountId: requireParentAccountId(this.parentSession),
      agentId: task.agentId,
      subagentConfig: task.agentConfig,
      conversationKey: task.conversationKey,
      publicConversationKey: task.publicConversationKey,
      endpointId: this.parentSession.endpointId,
      projectSlug: this.parentSession.projectSlug,
      stageSlug: this.parentSession.stageSlug,
    }).catch((error) => {
      logError("Subagent queued ingress dispatch failed", {
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error),
      });

      return false;
    });
    if (!transferred) {
      await childSession.releaseConversationLease().catch(() => {});
    }
  }

  /**
   * Admits one persistent child conversation into the durable coordinator and
   * returns its fencing token. A busy conversation is refused rather than
   * queued so the parent sees the conflict instead of stalling on a dispatch.
   */
  private async admitChildConversation(
    task: ResolvedSubagentTask,
    promptMessage: UserModelMessage,
  ): Promise<number> {
    const admission = await acceptIngress({
      accountId: requireParentAccountId(this.parentSession),
      agentId: task.agentId,
      eventId: task.eventId,
      runId: task.runId,
      ownerTaskId: task.taskId,
      conversationKey: task.conversationKey,
      events: [promptMessage],
      requestedMode: "reject",
      idempotencyKey: task.eventId,
      delivery: {
        kind: "async",
        publicEventId: task.taskId,
        publicConversationKey: task.publicConversationKey,
        statusUrl: subagentStatusPath(task),
      },
    });
    if (
      admission.outcome !== "owner" ||
      admission.ownerGeneration === undefined
    ) {
      throw new Error(
        `Subagent conversation is not available: ${admission.outcome}`,
      );
    }

    return admission.ownerGeneration;
  }

  private async createChildTurnContext(
    childSession: Session,
    task: ResolvedSubagentTask,
    incoming: ModelMessage[],
  ): Promise<TurnContextSnapshot> {
    // The child is told its budget so it can pace itself.
    const ephemeralSystem: SystemModelMessage[] = [
      ...task.parentEphemeralSystem,
      { role: "system", content: SUBAGENT_BUDGET_INSTRUCTION },
    ];
    if (!task.persistent) {
      return childSession.createEphemeralTurnContext(
        [...(task.inheritedContext ? task.parentMessages : []), ...incoming],
        ephemeralSystem,
      );
    }

    await childSession.persistModelMessages(incoming);
    // `resuming` means the caller supplied an existing public conversationKey.
    // That is enough to load prior child history; when omitted, this is a new
    // persistent child conversation with a generated public key.
    if (task.resuming || !task.inheritedContext) {
      return childSession.createTurnContext(ephemeralSystem);
    }

    return childSession.createEphemeralTurnContext(
      [...task.parentMessages, ...incoming],
      ephemeralSystem,
    );
  }

  private async completeTask(completion: SubagentCompletion): Promise<void> {
    const shouldInjectToParent =
      this.pending.has(completion.taskId) ||
      this.detached.has(completion.taskId);

    if (
      completion.status === "failed" &&
      !this.recorded.has(completion.eventId)
    ) {
      await recordAsyncAgentResult(completion.eventId, {
        status: "failed",
        error: completion.error ?? "Subagent task failed",
      }).catch((error) => {
        logError("Failed to mark subagent task failed", {
          taskId: completion.taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (!shouldInjectToParent) {
      return;
    }

    const visible = await parentVisibleCompletion(
      completion,
      this.parentAgentConfig,
      this.getHooks(),
    );
    // Read after the hook: the parent may have stopped waiting meanwhile.
    const detached = this.detached.has(completion.taskId);
    if (
      visible &&
      (visible.visibleResult !== undefined ||
        !this.delivered.has(visible.eventId))
    ) {
      if (detached) {
        await this.resumeParentWith(visible);
      } else {
        this.completions.push(visible);
      }
    } else {
      // Never told, so the recovery sweep must not tell it either: a finished
      // row left `pending` would be swept past the parent's hold.
      await markAsyncAgentHandback(completion.eventId, "stored");
    }
    this.handled.add(completion.eventId);
    this.notifyCompletion();
    logInfo(
      stoppedOnPurpose(completion)
        ? "Subagent task stopped"
        : "Subagent task completed",
      {
        parentEventId: this.parentSession.eventId,
        taskId: completion.taskId,
        agentId: completion.agentId,
        status: completion.status,
        ...(completion.error ? { error: completion.error } : {}),
      },
    );
    await this.emitTaskFinished({
      taskId: completion.taskId,
      agentId: completion.agentId,
      conversationKey: completion.conversationKey,
      status: completion.status,
      ...(completion.response !== undefined
        ? { response: toLifecycleValue(completion.response) }
        : {}),
      ...(completion.error ? { error: completion.error } : {}),
    });
  }

  // Presentation only, and it runs after the durable result is recorded, so a
  // webhook failure must never propagate into the run's terminal status.
  private async emitTaskFinished(
    payload: AgentLifecycleEventPayload,
  ): Promise<void> {
    await this.lifecycle
      .emit("subagent.task.finished", payload)
      .catch((error) => {
        logError("Failed to emit subagent lifecycle event", {
          taskId: payload.taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** Share the request's hook dispatcher so onSubagentFinish sees the same ctx.state as the loop hooks. */
  attachHooks(hooks: HookDispatcher): void {
    this.hooksPromise = Promise.resolve(hooks);
  }

  private getHooks(): Promise<HookDispatcher> {
    if (!this.hooksPromise) {
      this.hooksPromise = createAgentHookDispatcher(
        this.parentSession.accountId,
        this.parentAgentConfig,
      );
    }

    return this.hooksPromise;
  }

  // A result the parent stopped waiting for starts its own parent turn. Its
  // row already holds the result, so a failed or refused resume is only
  // logged: the row is `detached` or still `pending`, and the recovery sweep
  // retries it from either.
  private async resumeParentWith(
    completion: SubagentCompletion,
  ): Promise<void> {
    await this.resumeParent(
      this.parentSession,
      completion.taskId,
      completionToParentMessage(completion),
      completion.eventId,
    ).catch((error: unknown): void => {
      logError("Failed to resume the parent with a late subagent result", {
        parentEventId: this.parentSession.eventId,
        taskId: completion.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // Puts unsaved questions back; one whose child stopped waiting stays dropped.
  private restoreQuestions(questions: SubagentCoordinator["questions"]): void {
    this.questions.unshift(
      ...questions.filter((open): boolean =>
        this.openQuestions.has(open.taskId),
      ),
    );
  }

  private nextStateChange(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.add(resolve);
    });
  }

  private notifyCompletion(): void {
    for (const waiter of this.waiters) {
      waiter();
    }
    this.waiters.clear();
  }
}

/**
 * Resumes each parent whose subagent result no live run delivered: the run
 * that detached it died with its pod or its resume failed, or the result is
 * still `pending` past any live parent's hold, because the run that owed it
 * died before its write and its detach. Each pass walks every page, so rows
 * it must retry never crowd the rest out. The ingress recovery sweep calls it
 * on its timer, with the handler's re-entry.
 */
export async function resumeLostSubagentResults(
  loadParent: SubagentParentLoader,
  resumeParent: SubagentParentResumer,
): Promise<void> {
  const now = Date.now();
  const updatedAfter = new Date(now - LATE_RESULT_MAX_AGE_MS).toISOString();
  const settledBefore = new Date(now - LATE_RESULT_GRACE_MS).toISOString();
  const abandonedBefore = new Date(
    now - PENDING_HANDBACK_MAX_AGE_MS,
  ).toISOString();
  const ranges: Array<
    [(typeof SWEPT_HANDBACKS)[number], AsyncAgentStatus, string]
  > = [];
  for (const handback of SWEPT_HANDBACKS) {
    // A detached result is the sweep's once the run that detached it had its
    // grace; a pending one only once no live parent run can still store it.
    const finishedBefore =
      handback === "pending" ? abandonedBefore : settledBefore;
    ranges.push(
      [handback, "completed", finishedBefore],
      [handback, "failed", finishedBefore],
    );
    // A child still running this long past its budget died with its pod. A
    // pending row is never processing: the finish is what sets it.
    if (handback !== "pending") {
      ranges.push([handback, "processing", abandonedBefore]);
    }
  }
  const held = new Map<string, UserModelMessage>();
  for (const [handback, status, updatedBefore] of ranges) {
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const result = await listUnobservedAsyncAgentResults({
        ...(handback === undefined ? {} : { handback: handback }),
        status: status,
        updatedAfter: updatedAfter,
        updatedBefore: updatedBefore,
        cursor: cursor,
      });
      for (const row of result.page) {
        // A child listed still running died with its pod: its row is failed,
        // unless its outcome landed since, and a later pass tells the parent.
        if (row.status === "processing") {
          await recordAsyncAgentResult(
            row.eventId,
            { status: "failed", error: LOST_SUBAGENT_ERROR },
            { onlyWhileProcessing: true },
          );
          continue;
        }
        // Counted: each one is a result a parent run dropped without a trace.
        if (handback === "pending") {
          logInfo("Subagent result left pending past the parent's hold", {
            eventId: row.eventId,
            ageMs: now - Date.parse(row.updatedAt),
            outcome: row.status,
          });
        }
        const retry = await resumeLostSubagentResult(
          row,
          loadParent,
          resumeParent,
          heldLostResults.get(row.eventId),
        ).catch((error: unknown): UserModelMessage | undefined => {
          logError("Failed to resume the parent with a lost subagent result", {
            eventId: row.eventId,
            error: toErrorMessage(error),
          });

          return heldLostResults.get(row.eventId);
        });
        if (retry) held.set(row.eventId, retry);
      }
      cursor = result.cursor;
      isDone = result.isDone;
    }
  }
  heldLostResults = held;
}

export async function pipeSubagentNatsStream(
  stream: AgentLoopStream,
  publisher: NatsPublisher,
): Promise<void> {
  for await (const value of readAgentFullStream(stream)) {
    await publisher.publish(value as Record<string, unknown>);
  }

  const finalResponse = stream.finalResponse();
  if (stream.hasStructuredOutput() && finalResponse !== undefined) {
    await publisher.publish({
      type: "structured-output",
      output: finalResponse,
    });
  }
}

function bestEffortSubagentPublisher(
  publisher: NatsPublisher,
  state: SubagentStreamState,
  taskId: string,
): NatsPublisher {
  return {
    publish: async (data) => {
      if (data.type === "error") {
        state.emittedError = true;
      }
      await publisher.publish(data).catch((error) => {
        logError("Best-effort subagent stream publish failed", {
          taskId: taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    close: async () => {
      await publisher.close().catch((error) => {
        logError("Best-effort subagent stream flush failed", {
          taskId: taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };
}

/**
 * What the parent sees of a finished child, or null when it is not told. A
 * stopped child was cancelled on purpose, so its progress is no answer. An
 * onSubagentFinish hook's rewrite wins, otherwise subagent.visibility decides.
 * The result is already recorded, so a hook that cannot load or throws only
 * loses its override.
 */
async function parentVisibleCompletion(
  completion: SubagentCompletion,
  parentAgentConfig: AgentConfig,
  hooks: Promise<HookDispatcher>,
): Promise<SubagentCompletion | null> {
  if (stoppedOnPurpose(completion)) return null;
  if (completion.status !== "completed") return completion;
  let visibleResult: JSONValue | undefined;
  try {
    const mutation = await (
      await hooks
    ).runMutation("subagent.task.finished", {
      taskId: completion.taskId,
      agentId: completion.agentId,
      result:
        completion.response === undefined
          ? null
          : toLifecycleValue(completion.response),
    });
    visibleResult = toLifecycleValue(mutation?.visibleResult);
  } catch (error) {
    logError("Subagent finish hook failed", {
      taskId: completion.taskId,
      error: toErrorMessage(error),
    });
  }
  if (visibleResult !== undefined) {
    return { ...completion, visibleResult: visibleResult };
  }

  return (parentAgentConfig.subagent?.visibility ?? "result") === "none"
    ? null
    : completion;
}

/**
 * Marks a lost result stored without resuming its parent, logged once: the
 * row then leaves the sweep's list.
 */
async function giveUpLostSubagentResult(
  eventId: string,
  reason: string,
): Promise<void> {
  await markAsyncAgentHandback(eventId, "stored");
  logInfo("Gave up on a lost subagent result", {
    eventId: eventId,
    reason: reason,
  });
}

/**
 * One finished row of `resumeLostSubagentResults`: it resumes the parent,
 * from `held` when an earlier pass already ran its finish hook. A row no
 * resume can ever deliver is given up. The row's `eventId` is
 * `scopedDirectEventId(account, child agent, taskId)`.
 * @returns the parent message to retry on the next pass, when the
 *   conversation had no room for it or the resume failed
 */
async function resumeLostSubagentResult(
  row: AsyncAgentResultRecord,
  loadParent: SubagentParentLoader,
  resumeParent: SubagentParentResumer,
  held: UserModelMessage | undefined,
): Promise<UserModelMessage | undefined> {
  const task = row.subagent;
  const child = parseAccountAgentScopedKey(row.eventId);
  const taskId = child
    ? publicEventIdForScope(row.eventId, child.accountId, child.agentId, "")
    : "";
  const parentEventId = subagentParentEventId(taskId);
  const scope = parentEventId
    ? parseAccountAgentScopedKey(parentEventId)
    : null;
  // Only a parent of the row's own account is ever resumed.
  if (!task || !child || !parentEventId || scope?.accountId !== row.accountId) {
    await giveUpLostSubagentResult(
      row.eventId,
      "no parent of the row's account to resume",
    );

    return undefined;
  }
  const target = await loadParent(
    scope.accountId,
    scope.agentId,
    task.parentConversationKey,
  );
  if (!target) {
    await giveUpLostSubagentResult(row.eventId, "parent agent is gone");

    return undefined;
  }
  const message =
    held ??
    (await parentVisibleCompletion(
      {
        taskId: taskId,
        eventId: row.eventId,
        agentId: child.agentId,
        ...(task.description ? { description: task.description } : {}),
        conversationKey: publicConversationKeyFromScoped(
          row.conversationKey,
          child.accountId,
          child.agentId,
        ),
        status: row.status === "completed" ? "completed" : "failed",
        ...(row.response !== undefined ? { response: row.response } : {}),
        ...(row.error !== undefined ? { error: row.error } : {}),
      },
      target.agentConfig,
      createAgentHookDispatcher(scope.accountId, target.agentConfig),
    ).then((visible): UserModelMessage | undefined =>
      visible ? completionToParentMessage(visible) : undefined,
    ));
  if (!message) {
    await giveUpLostSubagentResult(row.eventId, "hidden from the parent");

    return undefined;
  }
  let outcome: SubagentResumeOutcome;
  try {
    outcome = await resumeParent(
      {
        accountId: scope.accountId,
        agentId: scope.agentId,
        eventId: parentEventId,
        conversationKey: task.parentConversationKey,
        delivery: task.parentDelivery,
      },
      taskId,
      message,
      row.eventId,
      target,
    );
  } catch (error) {
    logError("Failed to resume the parent with a lost subagent result", {
      eventId: row.eventId,
      error: toErrorMessage(error),
    });

    return message;
  }
  if (outcome === "owner" || outcome === "queued") {
    logInfo("Resumed the parent with a lost subagent result", {
      parentEventId: parentEventId,
      taskId: taskId,
      admission: outcome,
    });

    return undefined;
  }
  if (outcome === "capacity") return message;
  await giveUpLostSubagentResult(row.eventId, `resume ${outcome}`);

  return undefined;
}

function questionToParentMessage(
  task: Omit<
    SubagentCompletion,
    "status" | "response" | "error" | "visibleResult"
  >,
  question: string,
): UserModelMessage {
  const metadata = [
    `taskId: ${task.taskId}`,
    `agentId: ${task.agentId}`,
    `conversationKey: ${task.conversationKey}`,
  ].join("\n");

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `Subagent question for the parent. The subagent is paused until you answer with update_subagent (mode "steer") using this taskId and agentId.\n${metadata}\n\nQuestion:\n${question}`,
      },
    ],
  };
}

function completionToParentMessage(
  completion: SubagentCompletion,
): UserModelMessage {
  const metadata = [
    `taskId: ${completion.taskId}`,
    `agentId: ${completion.agentId}`,
    ...(completion.description
      ? [`agentDescription: ${completion.description}`]
      : []),
    `conversationKey: ${completion.conversationKey}`,
    `status: ${completion.status}`,
  ].join("\n");
  const visible = completion.visibleResult ?? completion.response;
  const resultParts =
    completion.status === "completed" && visible !== undefined
      ? modelValueToUserParts(visible)
      : [];
  const prefix = `Subagent and async agent result injected into parent conversation.\n${metadata}\n\nResult:\n`;
  const detail =
    completion.status === "running"
      ? STILL_RUNNING_NOTE
      : (completion.error ?? "(no result)");

  return {
    role: "user",
    content:
      resultParts.length > 0
        ? prependTextToUserParts(prefix, resultParts)
        : [{ type: "text", text: `${prefix}${detail}` }],
  };
}

function createSubagentPublisher(
  parentSession: Session,
  task: ResolvedSubagentTask,
): NatsPublisher | undefined {
  if (!process.env.NATS_URL?.trim()) {
    return undefined;
  }

  return new LiveNatsPublisher(
    {
      accountId: requireParentAccountId(parentSession),
      agentId: task.agentId,
      conversationKey: task.publicConversationKey,
      eventId: task.taskId,
      connectionId: task.taskId,
    },
    collectSecretValues(task.agentConfig),
  );
}

function requireParentAccountId(session: Session): string {
  if (!session.accountId) {
    throw new Error("Subagents require an account-scoped parent session");
  }

  return session.accountId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A child its parent or the user stopped, as opposed to one that failed.
function stoppedOnPurpose(completion: SubagentCompletion): boolean {
  return (
    completion.error === PARENT_STOP_MESSAGE ||
    completion.error === USER_STOP_MESSAGE
  );
}

function subagentStatusPath(task: ResolvedSubagentTask): string {
  return `/v1/runs/${encodeURIComponent(task.runId)}`;
}

function toDispatch(task: ResolvedSubagentTask): RunSubagentTaskDispatch {
  return {
    taskId: task.taskId,
    agentId: task.agentId,
    ...(task.description ? { description: task.description } : {}),
    conversationKey: task.publicConversationKey,
    runId: task.runId,
    statusPath: subagentStatusPath(task),
    status: "running",
  };
}
