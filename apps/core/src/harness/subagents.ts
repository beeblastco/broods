import { timingSafeEqual } from "node:crypto";
import {
  subagentResultDedupeKey,
  SWEPT_HANDBACKS,
  type SweptHandback,
} from "@broods/convex/model/subagentResults";
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
  listOwedAsyncAgentResults,
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
const PERSISTENT_SUBAGENT_KEY =
  /^subagent-persistent-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{32})$/;
const DEFAULT_SUBAGENT_WAIT_BUDGET_MS = 8 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const ASK_PARENT_WAIT_MS = 5 * 60 * 1000;
const STILL_RUNNING_NOTE =
  "Still working. Its result will arrive in this conversation as a new message when it finishes, so do not redo this task.";
const LATE_RESULT_GRACE_MS = 2 * 60 * 1000;
const LATE_RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Retried next sweep pass with the held message: a queued resume stores the row only once
// applied, a full conversation has no room yet, and a duplicate is a resume still queued.
const HELD_RESUME_OUTCOMES: ReadonlySet<SubagentResumeOutcome> =
  new Set<SubagentResumeOutcome>(["queued", "capacity", "duplicate"]);
const LOST_SUBAGENT_ERROR =
  "Subagent stopped without a result: the runtime restarted while it was running.";
// Messages the last sweep pass could not deliver, so a retry skips the finish hook.
let heldLostResults = new Map<string, UserModelMessage>();
const SUBAGENT_BUDGET_MS = 15 * 60 * 1000;
// A live parent stores a result within one run budget (a worker slot's, or a child's when it is
// a subagent) plus wind-down; past that a `pending` or still-processing row has no owner.
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
  visibleResult?: JSONValue;
}

interface ResolvedSubagentTask {
  taskId: string;
  eventId: string;
  /** Minted before admission: the dispatch hands the parent its status URL first. */
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
export type SubagentParent = Pick<
  Session,
  "accountId" | "agentId" | "eventId" | "conversationKey" | "delivery"
>;
export type SubagentResumeOutcome = IngressAdmission["outcome"] | "skip";
/** Once per `taskId`, and never when the parent already read row `resultEventId`. */
type SubagentParentResumer = (
  parent: SubagentParent,
  taskId: string,
  message: UserModelMessage,
  resultEventId: string,
  target?: ReentryTarget,
) => Promise<SubagentResumeOutcome>;
type SubagentParentLoader = (
  accountId: string,
  agentId: string,
  conversationKey: string,
) => Promise<ReentryTarget | null>;

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
  // Children the parent stopped waiting for; each reports through `resumeParent` instead.
  private readonly detached = new Set<string>();
  private readonly waiters = new Set<() => void>();
  private readonly recorded = new Set<string>();
  // Rows already queued for or kept from the parent: detaching must not mark them again.
  private readonly handled = new Set<string>();
  private readonly questions: Array<{
    taskId: string;
    message: UserModelMessage;
    dedupeKey: string;
  }> = [];
  private questionsClosed = false;
  private readonly openQuestions = new Map<
    string,
    (answer: string | null) => void
  >();
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
    this.dispatchNextIngress =
      dependencies.dispatchNextIngress ?? (async () => false);
    this.resumeParent =
      dependencies.resumeParent ??
      (async (): Promise<SubagentResumeOutcome> => "skip");
  }

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
    const parentObs = getObservabilityContext();
    const subagentParent: SubagentParentContext | undefined = parentObs?.traceId
      ? {
          parentTraceId: parentObs.traceId,
          parentTaskId: this.parentSession.eventId,
        }
      : undefined;

    // All resolved first, so one invalid task fails the call before any child starts.
    const resolvedTasks = await Promise.all(
      tasks.map((task) =>
        this.resolveTask(task, parentMessages, parentEphemeralSystem),
      ),
    );

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
      this.startTask(task, subagentParent);

      return toDispatch(task);
    });

    return { tasks: dispatches };
  };

  get pendingCount(): number {
    return this.pending.size;
  }

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
        await options.onHeartbeat?.(this.pending.size);
        // No step boundary runs while the parent waits, so a user stop reaches children here.
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

  // The pass's last write: on failure every unsaved result and running child resumes the parent.
  async drainCompletionsToParent(): Promise<number> {
    try {
      return (await this.takeParentMessages()).length;
    } catch (error: unknown) {
      // Marked detached before the resume, so the sweep retries a resume that fails.
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

  async takeParentMessages(): Promise<UserModelMessage[]> {
    // A running notice whose child already finished is stale: it resumed the parent itself.
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
    // A large write takes several appends: a failure puts back only what none saved. An
    // append that committed but lost its reply is put back too; its dedupe key stores it once.
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
    this.openQuestions.delete(taskId);
    const queued = this.questions.findIndex((open) => open.taskId === taskId);
    if (queued !== -1) {
      this.questions.splice(queued, 1);
    }

    return result;
  }

  stopChildren(): void {
    this.childStop.abort(new Error(USER_STOP_MESSAGE));
  }

  closeQuestions(): void {
    this.questionsClosed = true;
    this.questions.length = 0;
    for (const resolve of this.openQuestions.values()) resolve(null);
    this.openQuestions.clear();
  }

  answerQuestion(taskId: string, answer: string): boolean {
    const resolve = this.openQuestions.get(taskId);
    if (!resolve) {
      return false;
    }
    this.openQuestions.delete(taskId);
    resolve(answer);

    return true;
  }

  async drainCompletionsAndDetachToParent(): Promise<number> {
    if (this.completions.length === 0 && this.pending.size === 0) {
      return 0;
    }

    for (const metadata of await this.detachPending()) {
      this.completions.push({ ...metadata, status: "running" });
    }

    return this.drainCompletionsToParent();
  }

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
    await Promise.all(
      detaching
        .filter(({ eventId }): boolean => !this.handled.has(eventId))
        .map(({ eventId }): Promise<boolean> =>
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
    // The key comes from the model and shares the child agent's direct-API namespace: only a
    // key minted for this parent may resume, or it could name another caller's conversation.
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

    // Named by the persistent key's UUID, so resuming the key reaches the same child.
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

  private startTask(
    task: ResolvedSubagentTask,
    subagentParent?: SubagentParentContext,
  ): void {
    const publisher = this.createPublisher(task);
    const streamState: SubagentStreamState = { emittedError: false };
    const trackedPublisher = publisher
      ? bestEffortSubagentPublisher(publisher, streamState, task.taskId)
      : undefined;
    // Its own cell: on the parent's, the parent's pass ending blanks the child's scope.
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

  private async runTask(
    task: ResolvedSubagentTask,
    subagentParent?: SubagentParentContext,
    publisher?: NatsPublisher,
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
    // Without an owner generation every steer and stop on the session is a silent no-op.
    const ownerGeneration = preOwned
      ? preOwned.ownerGeneration
      : task.persistent
        ? await this.admitChildConversation(task, promptMessage)
        : undefined;
    // Inherited trigger: a child of a scheduled run must not reach the schedule tools either.
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
          // The child holds no worker slot to yield, so it winds down near its deadline.
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
    // A drain failure must not turn this completed task into a second, failed completion.
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

  private async drainChildConversation(
    childSession: Session,
    task: ResolvedSubagentTask,
    subagentParent?: SubagentParentContext,
    publisher?: NatsPublisher,
  ): Promise<void> {
    // No live parent turn is left to take the answer, so a standalone worker runs the envelope.
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
    if (visible) {
      if (detached) {
        await this.resumeParentWith(visible);
      } else {
        this.completions.push(visible);
      }
    } else {
      // Hidden from the parent: a finished row left `pending` would be swept to it later.
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

  // After the durable record: a webhook failure must never change the run's terminal status.
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

  /** Shares the request's dispatcher, so onSubagentFinish sees the loop hooks' ctx.state. */
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

  // Only logged on failure: the row holds the result and the sweep retries it.
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

export async function resumeLostSubagentResults(
  loadParent: SubagentParentLoader,
  resumeParent: SubagentParentResumer,
): Promise<void> {
  const now = Date.now();
  const { updatedAfter, finishedBefore, abandonedBefore } =
    lostResultWindows(now);
  const ranges: Array<[SweptHandback, AsyncAgentStatus, string]> = [];
  for (const handback of SWEPT_HANDBACKS) {
    const settledBefore = finishedBefore(handback);
    ranges.push(
      [handback, "completed", settledBefore],
      [handback, "failed", settledBefore],
      [handback, "processing", abandonedBefore],
    );
  }
  const held = new Map<string, UserModelMessage>();
  for (const [handback, status, updatedBefore] of ranges) {
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const result = await listOwedAsyncAgentResults({
        handback: handback,
        status: status,
        updatedAfter: updatedAfter,
        updatedBefore: updatedBefore,
        cursor: cursor,
      });
      for (const row of result.page) {
        // Died with its pod, and so did its parent run: a pending row is detached in the same
        // write, so the failure goes out after the grace rather than another hold.
        if (row.status === "processing") {
          await recordAsyncAgentResult(
            row.eventId,
            { status: "failed", error: LOST_SUBAGENT_ERROR },
            {
              onlyWhileProcessing: true,
              ...(handback === "pending" ? { handback: "detached" } : {}),
            },
          );
          continue;
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
        // Logged once per row: each is a result a parent run dropped without a trace.
        if (handback === "pending" && !heldLostResults.has(row.eventId)) {
          logInfo("Subagent result left pending past the parent's hold", {
            eventId: row.eventId,
            ageMs: now - Date.parse(row.updatedAt),
            outcome: row.status,
          });
        }
      }
      cursor = result.cursor;
      isDone = result.isDone;
    }
  }
  heldLostResults = held;
}

/** The async tool sweep (`async-tools.ts`) lists on these same windows. */
export function lostResultWindows(now: number): {
  updatedAfter: string;
  finishedBefore: (handback: SweptHandback) => string;
  abandonedBefore: string;
} {
  const settledBefore = new Date(now - LATE_RESULT_GRACE_MS).toISOString();
  const abandonedBefore = new Date(
    now - PENDING_HANDBACK_MAX_AGE_MS,
  ).toISOString();

  return {
    updatedAfter: new Date(now - LATE_RESULT_MAX_AGE_MS).toISOString(),
    finishedBefore: (handback): string =>
      handback === "pending" ? abandonedBefore : settledBefore,
    abandonedBefore: abandonedBefore,
  };
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

// A duplicate is never given up: admission stores the row once the conversation has it, and
// a still-queued resume stores it when applied or is admitted again once it expired.
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
  }
  if (HELD_RESUME_OUTCOMES.has(outcome)) return message;
  if (outcome !== "owner") {
    await giveUpLostSubagentResult(row.eventId, `resume ${outcome}`);
  }

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
