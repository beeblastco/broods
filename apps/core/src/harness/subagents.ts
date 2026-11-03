import { createHash, timingSafeEqual } from "node:crypto";
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
  toRuntimeAgentConfig,
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
  type IngressCandidate,
} from "./ingress.ts";
import type { ReentryTarget } from "./integrations.ts";
import { LiveNatsPublisher } from "./nats-publisher.ts";
import {
  createAgentLifecycleEmitter,
  toLifecycleValue,
  type AgentLifecycleEmitter,
  type AgentLifecycleEventPayload,
} from "./lifecycle.ts";
import {
  Session,
  type IngressUserMessage,
  type TurnContextSnapshot,
} from "./session.ts";
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
  type AgentMessage,
  type AgentMessageResult,
  type MessageChild,
} from "./tools/utils.ts";

const PERSISTENT_SUBAGENT_KEY_PREFIX = "subagent-persistent-";
const PERSISTENT_SUBAGENT_KEY =
  /^subagent-persistent-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{32})$/;
const DEFAULT_SUBAGENT_WAIT_BUDGET_MS = 8 * 60 * 1000;
// Turns one run lineage's family may start by messaging each other, so two
// agents cannot keep waking each other forever.
const MESSAGE_TURN_BUDGET = 40;
const HEARTBEAT_INTERVAL_MS = 15_000;
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
// The parent message of each lost result a sweep pass could not resume yet, so
// the next pass retries it without running its finish hook again.
let heldLostResults = new Map<string, IngressUserMessage>();
// Wall clock one child turn may take. The loop winds it down to a tools-off
// answer DEADLINE_WIND_DOWN_MS before; a turn still running that long past the
// budget, stuck in a tool call, is aborted.
const SUBAGENT_BUDGET_MS = 15 * 60 * 1000;
// A live parent stores a result within one run budget (a worker slot's, or a child's when it is
// a subagent) plus wind-down; past that a `pending` or still-processing row has no owner.
const PENDING_HANDBACK_MAX_AGE_MS =
  Math.max(SUBAGENT_BUDGET_MS, WORKER_TIMEOUT_BUDGET_MS) +
  DEADLINE_WIND_DOWN_MS +
  LATE_RESULT_GRACE_MS;
const SUBAGENT_BUDGET_INSTRUCTION = `You are a subagent with a ${SUBAGENT_BUDGET_MS / 60_000}-minute budget for this task. Pace yourself: near the end your tools are turned off and you must answer with what you have.`;
const SUBAGENT_BUDGET_EXCEEDED = `Subagent ran far past its ${SUBAGENT_BUDGET_MS / 60_000}-minute budget and was cut off before it answered.`;
const MESSAGE_TURNS_SPENT = `Agents in this run already started ${MESSAGE_TURN_BUDGET} turns by messaging each other. Finish with what you have.`;
const NO_REPLY_NOTE =
  "No reply from your parent: it ended its turn or stopped waiting on you. Carry on with your best judgment and say what you assumed. A late reply still arrives as a later message.";
const NO_TURNS_LEFT_NOTE =
  "No reply from your parent, and this run has no message turns left, so you cannot message your parent again. Finish now with your best judgment and say what you assumed.";
const CHILD_BUSY =
  "The subagent's conversation is busy with a turn this runtime does not run, such as one a restart cut off. Try again in a few minutes.";
// A conflict is an earlier try of the same note, admitted before its reply was lost.
const NOTE_DELIVERED: ReadonlySet<string> = new Set([
  "owner",
  "queued",
  "duplicate",
  "conflict",
]);
// Persistent children running a task in this process, by conversation key. What a parent sends
// one is read at its next step, or else as the task's next turn once the current one ends.
const liveChildren = new Map<string, LiveChild>();
// The question each child of this process waits on its parent with, by public key, until a turn.
const unanswered = new Map<string, string>();

interface SubagentCompletion {
  taskId: string;
  eventId: string;
  agentId: string;
  description?: string;
  conversationKey: string;
  // `awaiting_input`: the child ended its turn waiting on its parent's reply
  // to `question`, in exchange `exchangeId`.
  status: "completed" | "failed" | "running" | "awaiting_input";
  response?: JSONValue;
  error?: string;
  question?: string;
  exchangeId?: string;
  // What the parent actually sees, after subagent.visibility + an onSubagentFinish
  // hook. Undefined => render the raw response.
  visibleResult?: JSONValue;
}

/** What the parent knows of a child task before it finishes. */
type SubagentTaskMetadata = Omit<
  SubagentCompletion,
  "status" | "response" | "error" | "visibleResult"
>;

// One message for the parent's next write, in arrival order.
interface QueuedParentMessage {
  message: IngressUserMessage;
  completion: SubagentCompletion;
}

/** Who runs a child, on which config, and where its conversation lives. */
interface SubagentChild {
  agentId: string;
  agentConfig: AgentConfig;
  description?: string;
  publicConversationKey: string;
  conversationKey: string;
}

interface ResolvedSubagentTask extends SubagentChild {
  taskId: string;
  eventId: string;
  /** Minted here, not at admission, because the dispatch hands the parent this
   * task's status URL before the child conversation is admitted. */
  runId: string;
  prompt: string;
  inheritedContext: boolean;
  parentMessages: ModelMessage[];
  parentEphemeralSystem: SystemModelMessage[];
  persistent: boolean;
  resuming: boolean;
  isolatedSandbox: boolean;
  /** No line to its parent, so it answers, unless its `payer` pays for this turn. */
  lastTurn: boolean;
  /** The run that pays for this turn, and whose stop and line to the parent it runs under. */
  payer?: SubagentCoordinator;
}

interface LiveChild {
  taskId: string;
  // The current turn's admission: a message joins the turn only once it is admitted.
  started: Promise<boolean>;
  settle: (started: boolean) => void;
  inbox: string[];
  // Who pays the next turn: the first sender since the inbox was last read.
  sender?: SubagentCoordinator;
}

/** A turn whose envelope the child already owns, so it runs without admitting again. */
interface PreOwnedTurn {
  ownerGeneration: number;
  events: ModelMessage[];
}

/** How a child turn ended: an answer, or a message it waits on its parent with. */
type ChildFinish =
  | { status: "completed"; response: JSONValue }
  | { status: "awaiting_input"; message: AgentMessage };

interface SubagentStreamState {
  emittedError: boolean;
}

type SubagentPublisherFactory = (
  task: ResolvedSubagentTask,
) => NatsPublisher | undefined;
export type SubagentParent = Pick<
  Session,
  "accountId" | "agentId" | "eventId" | "conversationKey" | "delivery"
>;
export type SubagentResumeOutcome = IngressAdmission["outcome"] | "skip";
/** Once per `taskId`, and never when the parent already read row `resultEventId`. */
type SubagentParentResumer = (
  parent: SubagentParent,
  taskId: string,
  message: IngressUserMessage,
  resultEventId: string | undefined,
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
  resumeParent?: SubagentParentResumer;
}

export class SubagentCoordinator {
  private readonly outbox: QueuedParentMessage[] = [];
  private readonly pending = new Map<string, Promise<void>>();
  private readonly pendingMetadata = new Map<string, SubagentTaskMetadata>();
  // Children still running after the parent stopped waiting. Each reports
  // through `resumeParent` instead, as a new turn of the parent conversation.
  private readonly detached = new Map<string, SubagentTaskMetadata>();
  private readonly waiters = new Set<() => void>();
  private readonly recorded = new Set<string>();
  // Rows already queued for or kept from the parent: detaching must not mark them again.
  private readonly handled = new Set<string>();
  private readonly childStop = new AbortController();
  // When the parent stops waiting on a child it messaged with a wait, by taskId.
  private readonly waitDeadlines = new Map<string, number>();
  // Questions written to the parent, by child key: woken at closePasses unless a later turn ran.
  private readonly asked = new Map<string, SubagentTaskMetadata>();
  // Set once no parent pass runs any more: a child started after it reports through `resumeParent`.
  private closed = false;
  private hooksPromise?: Promise<HookDispatcher>;

  private readonly lifecycle: AgentLifecycleEmitter;
  private readonly publisherFactory: SubagentPublisherFactory;
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
    // All resolved first, so one invalid task fails the call before any child starts.
    const resolvedTasks = await Promise.all(
      tasks.map((task) =>
        this.resolveTask(task, parentMessages, parentEphemeralSystem),
      ),
    );

    return this.launch(resolvedTasks);
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
  ): Promise<"idle" | "message" | "timeout"> {
    while (
      this.pending.size > 0 &&
      !this.hasChildMessage() &&
      Date.now() < this.waitUntilMs
    ) {
      const heartbeatAt = Math.min(
        Date.now() + HEARTBEAT_INTERVAL_MS,
        this.waitUntilMs,
        ...this.waitDeadlines.values(),
      );
      const timerWoke = await Promise.race([
        this.nextStateChange().then((): boolean => false),
        sleep(Math.max(heartbeatAt - Date.now(), 0)).then((): boolean => true),
      ]);
      await this.detachOverdueWaits();

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

    if (this.hasChildMessage()) return "message";

    return this.pending.size === 0 ? "idle" : "timeout";
  }

  // The pass's last write: on failure every unsaved result and running child resumes the parent.
  async drainCompletionsToParent(): Promise<number> {
    try {
      return (await this.takeParentMessages()).length;
    } catch (error: unknown) {
      await this.handOverToParent();
      throw error;
    }
  }

  // Writes queued results, questions and notes to the parent conversation in arrival order. The
  // parent's step boundary calls it, so they reach the model mid-pass.
  async takeParentMessages(): Promise<IngressUserMessage[]> {
    // A running notice is stale once its child has finished: that child
    // resumed the parent with its result itself, even while the detach that
    // queued the notice was still writing.
    const queued = this.outbox
      .splice(0)
      .filter(
        ({ completion }): boolean =>
          completion.status !== "running" ||
          this.detached.has(completion.taskId),
      );
    const messages = queued.map(({ message }): IngressUserMessage => message);
    if (messages.length === 0) return messages;
    // A large write takes several appends: a failure puts back only what none saved. An
    // append that committed but lost its reply is put back too; its dedupe key stores it once.
    let saved = 0;
    // A saved question is the parent's to answer, so it is woken if no pass does.
    const asked = (upTo: number): void => {
      for (const { completion } of queued.slice(0, upTo)) {
        if (completion.status === "awaiting_input") {
          this.asked.set(completion.conversationKey, completion);
        }
      }
    };
    await this.parentSession
      .persistModelMessages(messages, {
        onSaved: (count): void => {
          saved = count;
          asked(count);
        },
      })
      .catch((error: unknown): never => {
        this.outbox.unshift(...queued.slice(saved));
        throw error;
      });
    asked(queued.length);

    return messages;
  }

  // A live child reads it at its next step, or in the turn after the one it is finishing; an
  // idle one starts a turn (one lineage message turn). A wait detaches the child once it passes.
  messageChild: MessageChild = async (
    to: string,
    message: AgentMessage,
  ): Promise<AgentMessageResult> => {
    const child = await this.resolveAddress(to);
    const result = (
      status: AgentMessageResult["status"],
      note: string,
    ): AgentMessageResult => ({
      status: status,
      exchangeId: message.exchangeId,
      note: note,
    });
    const text = `Message from your parent (exchange ${message.exchangeId}${message.followUp ? ", follow-up" : ""}):\n${message.text}`;
    // One an earlier turn left running reports to that turn's coordinator, which resumes
    // this conversation with its result.
    const deliver = async (): Promise<AgentMessageResult | undefined> => {
      const key = child.conversationKey;
      for (
        let live = liveChildren.get(key);
        live;
        live = liveChildren.get(key)
      ) {
        const admission = live.started;
        await admission;
        // A turn that ended, failed or passed to its next while this waited reads nothing more.
        if (liveChildren.get(key) !== live || live.started !== admission) {
          continue;
        }
        live.inbox.push(text);
        live.sender ??= this;

        return result(
          "delivered",
          this.runningTaskFor(child.publicConversationKey)
            ? "It reads this at its next step."
            : "It reads this at its next step. It is still running from an earlier turn, so its reply arrives as a later message, not in this turn.",
        );
      }

      return undefined;
    };
    const delivered = await deliver();
    if (delivered) return delivered;
    if (!(await this.parentSession.claimMessageTurn(MESSAGE_TURN_BUDGET))) {
      return result("not_delivered", MESSAGE_TURNS_SPENT);
    }
    const waitUntil =
      message.waitSeconds === undefined
        ? undefined
        : Date.now() + message.waitSeconds * 1000;
    const { outcome, task } = await this.resumeChild(child, text, true);
    // Refused because another message started a turn meanwhile: this one joins it.
    if (outcome !== "owner") {
      return (await deliver()) ?? result("not_delivered", CHILD_BUSY);
    }
    if (waitUntil === undefined) {
      await this.detachTask(task.taskId, false);
    } else {
      this.waitDeadlines.set(task.taskId, waitUntil);
    }

    return {
      ...result(
        "resumed",
        waitUntil === undefined
          ? "It started a turn on it. Its reply arrives as a later message."
          : `It started a turn on it. Its reply comes back here, or as a later message if it takes longer than ${message.waitSeconds}s.`,
      ),
      taskId: task.taskId,
      runId: task.runId,
      statusPath: task.statusPath,
    };
  };

  /**
   * The child at an address run_subagent returned this parent conversation:
   * `<agentId>/<conversationKey>`, under a key this parent minted.
   */
  async resolveAddress(to: string): Promise<SubagentChild> {
    const accountId = requireParentAccountId(this.parentSession);
    const slash = to.indexOf("/");
    const agentId = to.slice(0, slash);
    const publicKey = to.slice(slash + 1);
    const notOurs = new Error(
      `${to} is not the address of one of your persistent subagents. Use the address run_subagent returned.`,
    );
    if (
      !this.isPersistentMode ||
      slash <= 0 ||
      !this.mintedChildKey(accountId, publicKey)
    ) {
      throw notOurs;
    }
    const child = await this.resolveChild(
      accountId,
      publicKey,
      agentId.startsWith(VIRTUAL_AGENT_PREFIX) ? undefined : agentId,
      "",
    );
    // A virtual child's id is its key's, so a mismatch names another child.
    if (child.agentId !== agentId) throw notOurs;

    return child;
  }

  // Starts a turn of an idle child on `prompt`. A live or busy one is `rejected`, never queued
  // on. `charged` is a message turn, given back unless the turn starts.
  async resumeChild(
    child: SubagentChild,
    prompt: string,
    charged: boolean,
  ): Promise<{
    outcome: IngressAdmission["outcome"];
    task: RunSubagentTaskDispatch;
  }> {
    const task = this.childTask(child, {
      taskId: createSubagentTaskId(this.parentSession.eventId),
      prompt: prompt,
      resuming: true,
      parentMessages: [],
      parentEphemeralSystem: [],
      isolated: false,
      lastTurn: !charged,
    });
    const events: ModelMessage[] = [userText(prompt)];
    const key = child.conversationKey;
    const reserved = liveChildren.has(key) ? undefined : reserveLive(key, task);
    let started = false;
    try {
      const admission: IngressAdmission = reserved
        ? await acceptIngress(this.childCandidate(task, events))
        : { outcome: "rejected" };
      if (admission.outcome === "owner") {
        const ownerGeneration = ownedGeneration(admission);
        await this.launch([task], {
          ownerGeneration: ownerGeneration,
          events: events,
        }).catch(async (error: unknown): Promise<never> => {
          // Admitted but never started: settle and release, or the child stays busy for good.
          const owner = new Session({
            eventId: task.eventId,
            conversationKey: task.conversationKey,
            accountId: requireParentAccountId(this.parentSession),
            agentId: task.agentId,
            ownerGeneration: ownerGeneration,
          });
          await owner
            .settleIngress("failed", { error: toErrorMessage(error) })
            .catch((): boolean => false);
          await owner.releaseConversationLease().catch((): void => {});
          throw error;
        });
        started = true;
      }

      return { outcome: admission.outcome, task: toDispatch(task) };
    } finally {
      if (reserved) settleLive(key, reserved, started);
      if (charged && !started) await this.parentSession.releaseMessageTurn();
    }
  }

  /**
   * A child's message-agents note to the parent, without waiting: admitted to the parent's
   * conversation, a live parent reads it at its next step. Refused once its passes ended.
   */
  async noteFromChild(
    taskId: string,
    message: AgentMessage,
    metadata = this.pendingMetadata.get(taskId) ?? this.detached.get(taskId),
  ): Promise<AgentMessageResult> {
    const refused = (note: string): AgentMessageResult => ({
      status: "not_delivered",
      exchangeId: message.exchangeId,
      note: note,
    });
    const notReading = refused(
      "Your parent is not reading messages now. Put it in your final answer instead.",
    );
    if (this.closed || !metadata) return notReading;
    // It can wake the parent's conversation, so it takes a message turn like a message does.
    if (!(await this.parentSession.claimMessageTurn(MESSAGE_TURN_BUDGET))) {
      return refused(MESSAGE_TURNS_SPENT);
    }
    // Its ids come from its task and text: a retry of one note, this call's own after a throw
    // or the model's next, is found again once admitted, and two notes in one step stay apart.
    const nonce = noteNonce(taskId, message.text);
    const send = (): Promise<SubagentResumeOutcome> =>
      this.resumeParent(
        this.parentSession,
        createSubagentTaskId(this.parentSession.eventId, nonce),
        noteToParentMessage(metadata, message, nonce),
        undefined,
      );
    const outcome = this.closed
      ? "closed"
      : await send()
          .catch(send)
          .catch((error: unknown): string => toErrorMessage(error));
    if (!NOTE_DELIVERED.has(outcome)) {
      await this.parentSession.releaseMessageTurn();

      return outcome === "closed"
        ? notReading
        : refused(`Your parent could not take the note: ${outcome}.`);
    }

    return {
      status: "delivered",
      exchangeId: message.exchangeId,
      note: "Your parent reads it at its next step.",
    };
  }

  /**
   * The parent's passes are over: what no pass will read resumes the parent instead, and each
   * child no turn reached since its question is woken once to carry on. A child's note is refused.
   */
  async closePasses(): Promise<void> {
    this.closed = true;
    await this.handOverToParent();
    const waiting = [...this.asked.values()].filter(
      ({ conversationKey, eventId }): boolean =>
        unanswered.get(conversationKey) === eventId,
    );
    this.asked.clear();
    await Promise.all(
      waiting.map((question): Promise<void> => this.wakeChild(question)),
    );
  }

  /**
   * The parent's user stop: aborts every running child at once, so each ends
   * as stopped rather than working on for a request nobody waits for.
   */
  stopChildren(): void {
    this.childStop.abort(new Error(USER_STOP_MESSAGE));
  }

  async drainCompletionsAndDetachToParent(): Promise<number> {
    if (this.outbox.length === 0 && this.pending.size === 0) {
      return 0;
    }

    for (const metadata of await this.detachPending()) {
      // Queued like a result, so it rides the same write.
      this.enqueue({ ...metadata, status: "running" });
    }

    return this.drainCompletionsToParent();
  }

  // The parent stops waiting on every child still working: each resumes the parent through
  // `resumeParent` once it finishes.
  private async detachPending(): Promise<SubagentTaskMetadata[]> {
    const detaching = [...this.pendingMetadata.values()].filter(
      (metadata): boolean => !this.answered(metadata),
    );
    for (const metadata of detaching) {
      this.detached.set(metadata.taskId, metadata);
    }
    this.pending.clear();
    this.pendingMetadata.clear();
    await Promise.all(
      detaching
        .filter(({ eventId }): boolean => !this.handled.has(eventId))
        .map(({ eventId }): Promise<void> =>
          markAsyncAgentHandback(eventId, "detached"),
        ),
    );

    return detaching;
  }

  // Stops waiting on one child, which resumes the parent with its result. `notify` queues a
  // running notice. A child whose result is already queued is left to it.
  private async detachTask(taskId: string, notify: boolean): Promise<void> {
    const metadata = this.pendingMetadata.get(taskId);
    this.waitDeadlines.delete(taskId);
    if (!metadata || this.answered(metadata)) return;
    this.pending.delete(taskId);
    this.pendingMetadata.delete(taskId);
    this.detached.set(taskId, metadata);
    if (notify) this.enqueue({ ...metadata, status: "running" });
    if (!this.handled.has(metadata.eventId)) {
      await markAsyncAgentHandback(metadata.eventId, "detached");
    }
    this.notifyCompletion();
  }

  // Its current turn's result is queued, so only that turn's lease is left to settle.
  private answered(metadata: SubagentTaskMetadata): boolean {
    return this.outbox.some(
      ({ completion }): boolean => completion.eventId === metadata.eventId,
    );
  }

  // Queues one result, question or running notice for the parent's next write.
  private enqueue(completion: SubagentCompletion): void {
    this.outbox.push({
      message: completionToParentMessage(completion),
      completion: completion,
    });
  }

  // What no pass will write resumes the parent; rows go detached first so the sweep retries.
  private async handOverToParent(): Promise<void> {
    await this.detachPending();
    for (const { message, completion } of this.outbox.splice(0)) {
      if (completion.status === "running") continue;
      await markAsyncAgentHandback(completion.eventId, "detached");
      await this.resumeParentWith(message, completion);
    }
  }

  // Once per question no live pass will answer. With the run's message turns spent the child
  // gets no line to its parent, so it answers. It runs detached: no pass waits on it.
  private async wakeChild(question: SubagentTaskMetadata): Promise<void> {
    if (this.childStop.signal.aborted) {
      if (unanswered.get(question.conversationKey) === question.eventId) {
        unanswered.delete(question.conversationKey);
      }

      return;
    }
    try {
      const child = await this.resolveAddress(childAddress(question));
      const charged =
        await this.parentSession.claimMessageTurn(MESSAGE_TURN_BUDGET);
      // Checked again after the awaits, where a reply's turn may have run, and right before
      // resumeChild reserves the child without awaiting.
      if (unanswered.get(question.conversationKey) !== question.eventId) {
        if (charged) await this.parentSession.releaseMessageTurn();

        return;
      }
      const { outcome, task } = await this.resumeChild(
        child,
        charged ? NO_REPLY_NOTE : NO_TURNS_LEFT_NOTE,
        charged,
      );
      if (outcome === "owner") await this.detachTask(task.taskId, false);
    } catch (error) {
      logError("Failed to wake a subagent its parent left unanswered", {
        taskId: question.taskId,
        error: toErrorMessage(error),
      });
    }
  }

  private async detachOverdueWaits(): Promise<void> {
    const now = Date.now();
    for (const [taskId, at] of this.waitDeadlines) {
      if (at <= now) await this.detachTask(taskId, true);
    }
  }

  private runningTaskFor(publicKey: string): string | undefined {
    for (const metadata of this.pendingMetadata.values()) {
      if (metadata.conversationKey === publicKey) return metadata.taskId;
    }

    return undefined;
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
    const publicConversationKey =
      task.conversationKey ??
      (persistent
        ? this.mintChildKey(accountId, crypto.randomUUID())
        : `subagent-${taskId}`);
    const child = await this.resolveChild(
      accountId,
      publicConversationKey,
      task.agentId,
      taskId,
    );

    const resuming = persistent && task.conversationKey !== undefined;

    // A resume is a reply too, so it takes a message turn.
    return this.childTask(child, {
      taskId: taskId,
      prompt: task.prompt,
      resuming: resuming,
      parentMessages: parentMessages,
      parentEphemeralSystem: parentEphemeralSystem,
      isolated: task.isolated === true,
      lastTurn: false,
      ...(resuming ? { payer: this } : {}),
    });
  }

  /**
   * Who runs the child on `publicKey`: the allowed agent `agentId` on its own
   * config under the parent's, or else a virtual child on the parent's.
   */
  private async resolveChild(
    accountId: string,
    publicKey: string,
    agentId: string | undefined,
    taskId: string,
  ): Promise<SubagentChild> {
    if (agentId) {
      const agent = await this.resolveAllowedAgent(accountId, agentId);

      return {
        agentId: agent.agentId,
        agentConfig: subagentConfig(
          toRuntimeAgentConfig(agent.config),
          this.parentAgentConfig,
        ),
        ...(agent.description ? { description: agent.description } : {}),
        publicConversationKey: publicKey,
        conversationKey: scopedDirectConversationKey(
          accountId,
          agent.agentId,
          publicKey,
        ),
      };
    }
    // Named by the persistent key UUID, so resuming the key reaches the same child.
    const virtualAgentId = `${VIRTUAL_AGENT_PREFIX}${PERSISTENT_SUBAGENT_KEY.exec(publicKey)?.[1] ?? taskId}`;

    return {
      agentId: virtualAgentId,
      agentConfig: virtualSubagentConfig(this.parentAgentConfig),
      publicConversationKey: publicKey,
      conversationKey: scopedDirectConversationKey(
        accountId,
        virtualAgentId,
        publicKey,
      ),
    };
  }

  /** One turn of `child` on `turn.prompt`, as `launch` starts it. */
  private childTask(
    child: SubagentChild,
    turn: {
      taskId: string;
      prompt: string;
      resuming: boolean;
      parentMessages: ModelMessage[];
      parentEphemeralSystem: SystemModelMessage[];
      isolated: boolean;
      lastTurn: boolean;
      payer?: SubagentCoordinator;
    },
  ): ResolvedSubagentTask {
    return {
      ...child,
      ...(turn.payer ? { payer: turn.payer } : {}),
      taskId: turn.taskId,
      runId: createRunId(),
      eventId: scopedDirectEventId(
        requireParentAccountId(this.parentSession),
        child.agentId,
        turn.taskId,
      ),
      prompt: turn.prompt,
      inheritedContext:
        this.parentAgentConfig.subagent?.context === "inherited",
      parentMessages: turn.parentMessages,
      parentEphemeralSystem: turn.parentEphemeralSystem,
      persistent: this.isPersistentMode,
      resuming: turn.resuming,
      isolatedSandbox: turn.isolated,
      lastTurn: turn.lastTurn,
    };
  }

  // Tagged for this account, parent agent and parent conversation, so only the conversation
  // that started a child can resume or message it.
  private mintChildKey(accountId: string, uuid: string): string {
    const scope = `${accountId}:${this.parentSession.agentId ?? ""}:${this.parentSession.conversationKey}:${uuid}`;

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

  // Status rows first, so each task id can be polled the moment the parent sees it. `preOwned`
  // is the envelope a resumed child already owns.
  private async launch(
    resolvedTasks: ResolvedSubagentTask[],
    preOwned?: PreOwnedTurn,
  ): Promise<RunSubagentDispatchResult> {
    // Capture the parent's trace/task id now, inside the parent's tool call.
    // Each child is its own top-level trace that links back to it.
    const parentObs = getObservabilityContext();
    const subagentParent: SubagentParentContext | undefined = parentObs?.traceId
      ? {
          parentTraceId: parentObs.traceId,
          parentTaskId: this.parentSession.eventId,
        }
      : undefined;
    await Promise.all(
      resolvedTasks.map((task): Promise<boolean> =>
        this.createChildResultRow(task),
      ),
    );

    await Promise.all(
      resolvedTasks.map((task): Promise<void> =>
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

    const dispatches = resolvedTasks.map((task): RunSubagentTaskDispatch => {
      // Intentionally not awaited: child agents run concurrently while the
      // parent model can keep streaming or later wait for injected results.
      this.startTask(task, subagentParent, preOwned);

      return toDispatch(task);
    });
    // No pass is left to read these results, so each resumes the parent.
    if (this.closed) {
      await Promise.all(
        resolvedTasks.map(({ taskId }): Promise<void> =>
          this.detachTask(taskId, false),
        ),
      );
    }

    return { tasks: dispatches };
  }

  // Not awaited: the parent gets task ids back at once; each result reaches it through the queue.
  private startTask(
    task: ResolvedSubagentTask,
    subagentParent?: SubagentParentContext,
    preOwned?: PreOwnedTurn,
  ): void {
    const publisher = this.createPublisher(task);
    const streamState: SubagentStreamState = { emittedError: false };
    const trackedPublisher = publisher
      ? bestEffortSubagentPublisher(publisher, streamState, task.taskId)
      : undefined;
    if (task.persistent && !liveChildren.has(task.conversationKey)) {
      reserveLive(task.conversationKey, task);
    }
    // Its own cell: on the parent's, the parent's pass ending blanks the child's scope.
    const promise = runWithObservabilityScope(
      (): Promise<void> =>
        this.runTurns(task, subagentParent, preOwned, {
          publisher: trackedPublisher,
          state: streamState,
        }),
      getObservabilityContext(),
    )
      .catch((error: unknown): void => {
        logError("Failed to settle a subagent task", {
          taskId: task.taskId,
          error: toErrorMessage(error),
        });
      })
      .finally(async () => {
        await trackedPublisher?.close();
        const live = liveChildren.get(task.conversationKey);
        if (live?.taskId === task.taskId) {
          settleLive(task.conversationKey, live, false);
        }
        this.pending.delete(task.taskId);
        this.pendingMetadata.delete(task.taskId);
        this.detached.delete(task.taskId);
        this.notifyCompletion();
      });

    this.pending.set(task.taskId, promise);
    this.pendingMetadata.set(task.taskId, taskMetadata(task));
  }

  /**
   * Runs `task`'s turns: its first, then one per batch of messages that reached it after its
   * last step. Each turn is settled and handed to the parent before the next one starts.
   */
  private async runTurns(
    task: ResolvedSubagentTask,
    subagentParent: SubagentParentContext | undefined,
    preOwned: PreOwnedTurn | undefined,
    stream: { publisher?: NatsPublisher; state: SubagentStreamState },
  ): Promise<void> {
    const { publisher, state } = stream;
    let turn: ResolvedSubagentTask | undefined = task;
    while (turn) {
      const current: ResolvedSubagentTask = turn;
      const completion = await (
        current === task
          ? Promise.resolve(true)
          : this.createChildResultRow(current)
      )
        .then((): Promise<SubagentCompletion> =>
          this.runTask(
            current,
            subagentParent,
            publisher,
            current === task ? preOwned : undefined,
          ),
        )
        .catch((error: unknown): SubagentCompletion => ({
          ...taskMetadata(current),
          status: "failed",
          error: toErrorMessage(error),
        }));
      turn = this.takeFollowUp(current, completion);
      await this.completeTask(completion, current.payer ?? this);
      if (completion.status === "failed" && !state.emittedError) {
        await publisher?.publish({ type: "error", error: completion.error });
      }
    }
    await publisher?.publish({ type: "done" });
  }

  /**
   * The task's next turn on what reached it after its last step, or none, and then it is no
   * longer live. Synchronous, so a message lands in this turn's inbox or finds the child idle.
   */
  private takeFollowUp(
    turn: ResolvedSubagentTask,
    completion: SubagentCompletion,
  ): ResolvedSubagentTask | undefined {
    const live = liveChildren.get(turn.conversationKey);
    if (live?.taskId !== turn.taskId) return undefined;
    const payer = live.sender ?? this;
    if (
      live.inbox.length === 0 ||
      stoppedOnPurpose(completion) ||
      this.childStop.signal.aborted ||
      payer.childStop.signal.aborted
    ) {
      settleLive(turn.conversationKey, live, false);

      return undefined;
    }
    Object.assign(live, pendingAdmission());
    const next: ResolvedSubagentTask = {
      ...turn,
      eventId: scopedDirectEventId(
        requireParentAccountId(this.parentSession),
        turn.agentId,
        createSubagentTaskId(this.parentSession.eventId),
      ),
      runId: createRunId(),
      prompt: live.inbox.splice(0).join("\n\n"),
      payer: payer,
      inheritedContext: false,
      resuming: true,
      // Unless its sender pays for it, it answers with no line to its parent.
      lastTurn: true,
    };
    live.sender = undefined;
    // From here the task is this turn: the last turn's queued result no longer answers it.
    for (const tasks of [this.pendingMetadata, this.detached]) {
      if (tasks.has(turn.taskId)) tasks.set(turn.taskId, taskMetadata(next));
    }

    return next;
  }

  // At each step of a live child: what its parent sent since, stored in its conversation.
  private async takeInbox(
    childSession: Session,
    task: ResolvedSubagentTask,
  ): Promise<IngressUserMessage[]> {
    const live = liveChildren.get(task.conversationKey);
    if (live?.taskId !== task.taskId || live.inbox.length === 0) return [];
    const texts = live.inbox.splice(0);
    const sender = live.sender;
    live.sender = undefined;
    const messages = texts.map(userText);
    await childSession
      .persistModelMessages(messages)
      .catch((error: unknown): never => {
        live.inbox.unshift(...texts);
        live.sender ??= sender;
        throw error;
      });

    return messages;
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

  // One turn, recorded, its lease given back: its completion is the caller's to hand on.
  private async runTask(
    task: ResolvedSubagentTask,
    subagentParent?: SubagentParentContext,
    publisher?: NatsPublisher,
    preOwned?: PreOwnedTurn,
  ): Promise<SubagentCompletion> {
    logInfo("Subagent task started", {
      parentEventId: this.parentSession.eventId,
      taskId: task.taskId,
      agentId: task.agentId,
      conversationKey: task.conversationKey,
      inheritedContext: task.inheritedContext,
      persistent: task.persistent,
      resuming: task.resuming,
    });

    const promptMessage = userText(task.prompt);
    const incoming = preOwned?.events ?? [promptMessage];
    // Without an owner generation every steer and stop on the session is a silent no-op.
    const admitted = preOwned
      ? { ownerGeneration: preOwned.ownerGeneration, charged: false }
      : task.persistent
        ? await this.admitChildConversation(task, promptMessage)
        : undefined;
    const lastTurn = task.lastTurn && !admitted?.charged;
    const payer = task.payer ?? this;
    // Admitted, so its prompt reaches the child: a question it asked before is answered.
    unanswered.delete(task.publicConversationKey);
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
      ownerGeneration: admitted?.ownerGeneration,
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
          abortSignal: AbortSignal.any([
            budget.signal,
            this.childStop.signal,
            payer.childStop.signal,
          ]),
          ...(task.persistent && !lastTurn
            ? {
                parentLink: {
                  note: (message: AgentMessage): Promise<AgentMessageResult> =>
                    payer.noteFromChild(
                      task.taskId,
                      message,
                      this.pendingMetadata.get(task.taskId) ??
                        this.detached.get(task.taskId),
                    ),
                },
              }
            : {}),
          ...(task.persistent
            ? {
                stopMessage: PARENT_STOP_MESSAGE,
                subagentWatch: {
                  takeParentMessages: (): Promise<IngressUserMessage[]> =>
                    this.takeInbox(childSession, task),
                },
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
      const question = stream.parentQuestion();
      const finish: ChildFinish | undefined =
        question !== undefined
          ? { status: "awaiting_input", message: question }
          : finalResponse === undefined
            ? undefined
            : { status: "completed", response: finalResponse };
      if (!finish) {
        throw new Error("Subagent task returned an empty response");
      }

      return await this.completeRun(childSession, task, finish);
    } catch (error) {
      await this.recordOutcome(childSession, task, {
        status: "failed",
        error: toErrorMessage(error),
      }).catch((settlementError: unknown): void => {
        logError("Failed to record subagent failure", {
          taskId: task.taskId,
          error: toErrorMessage(settlementError),
        });
      });
      await childSession.releaseConversationLease().catch((): void => {});
      throw error;
    } finally {
      clearTimeout(budgetTimer);
    }
  }

  // Row and envelope first, then the conversation is let go, and only then is the parent told
  // (by the caller), so a parent that replies at once finds the child idle.
  private async completeRun(
    childSession: Session,
    task: ResolvedSubagentTask,
    finish: ChildFinish,
  ): Promise<SubagentCompletion> {
    if (finish.status === "awaiting_input") {
      // History pruning drops older tool calls, so without this line the resumed child no longer
      // sees that it asked. Losing it risks a repeated question, never the question itself.
      await childSession
        .persistModelMessages([
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `I messaged my parent and am waiting for the reply (exchange ${finish.message.exchangeId}): ${finish.message.text}`,
              },
            ],
          },
        ])
        .catch((error: unknown): void => {
          logError("Failed to save a subagent's waiting line", {
            taskId: task.taskId,
            error: toErrorMessage(error),
          });
        });
    }
    await this.recordOutcome(
      childSession,
      task,
      finish.status === "completed"
        ? finish
        : { status: "awaiting_input", question: finish.message.text },
    );
    // The durable outcome is authoritative: a release failure must not fail the task.
    await childSession.releaseConversationLease().catch((): void => {});

    return {
      ...taskMetadata(task),
      ...(finish.status === "completed"
        ? finish
        : {
            status: "awaiting_input",
            question: finish.message.text,
            exchangeId: finish.message.exchangeId,
          }),
    };
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
    // A child that saves no history: the answer's write stores the results the model read.
    const toolResultIds =
      !task.persistent && outcome.status === "completed"
        ? [...childSession.unsavedToolResults]
        : [];
    if (!settled) {
      await recordAsyncAgentResult(
        task.eventId,
        outcome,
        toolResultIds.length > 0 ? { toolResultIds: toolResultIds } : {},
      );
    }
    this.recorded.add(task.eventId);
    this.notifyCompletion();
  }

  // Paid by `task.payer`'s message turns when set: given back unless admitted, or when either
  // run stopped during the claim. Unpaid, only a last turn runs. A child another task of this
  // process runs is busy too.
  private async admitChildConversation(
    task: ResolvedSubagentTask,
    promptMessage: UserModelMessage,
  ): Promise<{ ownerGeneration: number; charged: boolean }> {
    const payer = task.payer;
    const live = liveChildren.get(task.conversationKey);
    const ours = live?.taskId === task.taskId ? live : undefined;
    let charged = false;
    let admitted = false;
    try {
      charged =
        payer !== undefined &&
        (await payer.parentSession.claimMessageTurn(MESSAGE_TURN_BUDGET));
      if (payer && !charged && !task.lastTurn) {
        throw new Error(MESSAGE_TURNS_SPENT);
      }
      if (this.childStop.signal.aborted || payer?.childStop.signal.aborted) {
        throw new Error(USER_STOP_MESSAGE);
      }
      const ownerGeneration = ownedGeneration(
        ours
          ? await acceptIngress(this.childCandidate(task, [promptMessage]))
          : { outcome: "rejected" },
      );
      admitted = true;

      return { ownerGeneration: ownerGeneration, charged: charged };
    } catch (error) {
      if (charged) await payer?.parentSession.releaseMessageTurn();
      throw error;
    } finally {
      if (ours) settleLive(task.conversationKey, ours, admitted);
    }
  }

  /** The envelope of one turn of `task` on its child conversation, refused while it is busy. */
  private childCandidate(
    task: ResolvedSubagentTask,
    events: ModelMessage[],
  ): IngressCandidate {
    return {
      accountId: requireParentAccountId(this.parentSession),
      agentId: task.agentId,
      eventId: task.eventId,
      runId: task.runId,
      ownerTaskId: task.taskId,
      conversationKey: task.conversationKey,
      events: events,
      requestedMode: "reject",
      idempotencyKey: task.eventId,
      delivery: {
        kind: "async",
        publicEventId: task.taskId,
        publicConversationKey: task.publicConversationKey,
        statusUrl: subagentStatusPath(task),
      },
    };
  }

  // The polling row of one child turn, `pending` for this parent from the start.
  private createChildResultRow(task: ResolvedSubagentTask): Promise<boolean> {
    return createPendingAsyncAgentResult({
      eventId: task.eventId,
      conversationKey: task.conversationKey,
      subagent: {
        ...(task.description ? { description: task.description } : {}),
        parentConversationKey: this.parentSession.conversationKey,
        ...(this.parentSession.delivery
          ? { parentDelivery: this.parentSession.delivery }
          : {}),
      },
    });
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

  // `payer` resumes the parent with what no pass of this run reads, and wakes a question's child.
  private async completeTask(
    completion: SubagentCompletion,
    payer: SubagentCoordinator = this,
  ): Promise<void> {
    // Before any await: a next turn's admission must find it to clear it.
    if (completion.status === "awaiting_input") {
      unanswered.set(completion.conversationKey, completion.eventId);
    }
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
    // Read after the hook: the parent may have stopped waiting meanwhile. A detached child's
    // question still goes to a live pass, this run's or else its payer's.
    const live = !this.detached.has(completion.taskId)
      ? this
      : visible?.status === "awaiting_input"
        ? [this, payer].find((run): boolean => !run.closed)
        : undefined;
    if (visible) {
      if (live) {
        live.enqueue(visible);
        live.notifyCompletion();
      } else {
        await payer.resumeParentWith(
          completionToParentMessage(visible),
          visible,
        );
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

  // Failures are only logged: the row holds it for the sweep. A question's parent turn takes a
  // message turn, never refused so it arrives, and wakes its child, since no pass waits on it.
  private async resumeParentWith(
    message: IngressUserMessage,
    completion: SubagentCompletion,
  ): Promise<void> {
    const question = completion.status === "awaiting_input";
    if (question) {
      await this.parentSession
        .claimMessageTurn(MESSAGE_TURN_BUDGET)
        .catch((): boolean => false);
    }
    // Keyed by the turn's own row, as the sweep keys it: a later turn shares its first's taskId.
    const taskId = rowTaskId(completion.eventId) || completion.taskId;
    await this.resumeParent(
      this.parentSession,
      taskId,
      message,
      completion.eventId,
    ).catch((error: unknown): void => {
      logError("Failed to resume the parent with a late subagent message", {
        parentEventId: this.parentSession.eventId,
        taskId: taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    if (question) await this.wakeChild(completion);
  }

  // A question wakes the parent before the rest finish, so it does not wait on siblings.
  private hasChildMessage(): boolean {
    return this.outbox.some(
      ({ completion }): boolean => completion.status === "awaiting_input",
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
      [handback, "awaiting_input", settledBefore],
      [handback, "processing", abandonedBefore],
    );
  }
  const held = new Map<string, IngressUserMessage>();
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
        ).catch((error: unknown): IngressUserMessage | undefined => {
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
  held: IngressUserMessage | undefined,
): Promise<IngressUserMessage | undefined> {
  const task = row.subagent;
  const child = parseAccountAgentScopedKey(row.eventId);
  const taskId = rowTaskId(row.eventId);
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
        ...rowOutcome(row),
      },
      target.agentConfig,
      createAgentHookDispatcher(scope.accountId, target.agentConfig),
    ).then((visible): IngressUserMessage | undefined =>
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

/** The address message-agents reaches a child at: `<agentId>/<conversationKey>`. */
function childAddress(child: {
  agentId: string;
  conversationKey: string;
}): string {
  return `${child.agentId}/${child.conversationKey}`;
}

/** The parent's message for a child's result, keyed so saving it stores the result once. */
function completionToParentMessage(
  completion: SubagentCompletion,
): IngressUserMessage {
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
  if (completion.status === "awaiting_input") {
    return {
      role: "user",
      dedupeKey: subagentResultDedupeKey(completion.eventId, completion.status),
      content: [
        {
          type: "text",
          text: `Subagent message for the parent${completion.exchangeId ? ` (exchange ${completion.exchangeId})` : ""}. The subagent ended its turn waiting on your reply. Reply with message-agents to "${childAddress(completion)}"; it resumes with its work so far.\n${metadata}\n\nMessage:\n${completion.question ?? "(no message)"}`,
        },
      ],
    };
  }
  const prefix = `Subagent and async agent result injected into parent conversation.\n${metadata}\n\nResult:\n`;
  const detail =
    completion.status === "running"
      ? STILL_RUNNING_NOTE
      : (completion.error ?? "(no result)");

  return {
    role: "user",
    dedupeKey: subagentResultDedupeKey(completion.eventId, completion.status),
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

// A note's UUID from its task and text, so every try of one note shares its ids.
function noteNonce(taskId: string, text: string): string {
  const hex = createHash("sha256").update(`${taskId}\0${text}`).digest("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function noteToParentMessage(
  child: SubagentTaskMetadata,
  message: AgentMessage,
  nonce: string,
): IngressUserMessage {
  return {
    role: "user",
    dedupeKey: `subagent-note:${nonce}`,
    content: [
      {
        type: "text",
        text: `Subagent note for the parent (exchange ${message.exchangeId}${message.followUp ? ", follow-up" : ""}). It keeps working; no reply is needed, but you can send one with message-agents to "${childAddress(child)}".\ntaskId: ${child.taskId}\nagentId: ${child.agentId}\n\nNote:\n${message.text}`,
      },
    ],
  };
}

/** The fencing token of an admission that made the caller the owner. */
function ownedGeneration(admission: IngressAdmission): number {
  if (
    admission.outcome !== "owner" ||
    admission.ownerGeneration === undefined
  ) {
    throw new Error(
      `Subagent conversation is busy (${admission.outcome}). Message it with message-agents, or try again in a few minutes.`,
    );
  }

  return admission.ownerGeneration;
}

function pendingAdmission(): Pick<LiveChild, "started" | "settle"> {
  let settle = (_started: boolean): void => {};
  const started = new Promise<boolean>((resolve): void => {
    settle = resolve;
  });

  return { started: started, settle: settle };
}

function requireParentAccountId(session: Session): string {
  if (!session.accountId) {
    throw new Error("Subagents require an account-scoped parent session");
  }

  return session.accountId;
}

// Live from before its admission, so a message sent meanwhile waits to join this turn.
function reserveLive(key: string, task: ResolvedSubagentTask): LiveChild {
  const live: LiveChild = {
    taskId: task.taskId,
    inbox: [],
    ...pendingAdmission(),
  };
  liveChildren.set(key, live);

  return live;
}

/** What a lost result's row recorded, as the parent is told it. */
function rowOutcome(
  row: AsyncAgentResultRecord,
): Pick<SubagentCompletion, "status" | "response" | "error" | "question"> {
  return {
    status:
      row.status === "completed" || row.status === "awaiting_input"
        ? row.status
        : "failed",
    ...(row.response !== undefined ? { response: row.response } : {}),
    ...(row.error !== undefined ? { error: row.error } : {}),
    ...(row.question !== undefined ? { question: row.question } : {}),
  };
}

// The task id a child turn's row is keyed by: `scopedDirectEventId(account, agent, taskId)`.
function rowTaskId(eventId: string): string {
  const child = parseAccountAgentScopedKey(eventId);

  return child
    ? publicEventIdForScope(eventId, child.accountId, child.agentId, "")
    : "";
}

// Not started: the child is let go before the messages that waited on it look again.
function settleLive(key: string, live: LiveChild, started: boolean): void {
  if (!started && liveChildren.get(key) === live) liveChildren.delete(key);
  live.settle(started);
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

function taskMetadata(task: ResolvedSubagentTask): SubagentTaskMetadata {
  return {
    taskId: task.taskId,
    eventId: task.eventId,
    agentId: task.agentId,
    ...(task.description ? { description: task.description } : {}),
    conversationKey: task.publicConversationKey,
  };
}

function toDispatch(task: ResolvedSubagentTask): RunSubagentTaskDispatch {
  return {
    taskId: task.taskId,
    agentId: task.agentId,
    ...(task.description ? { description: task.description } : {}),
    conversationKey: task.publicConversationKey,
    ...(task.persistent
      ? {
          address: childAddress({
            agentId: task.agentId,
            conversationKey: task.publicConversationKey,
          }),
        }
      : {}),
    runId: task.runId,
    statusPath: subagentStatusPath(task),
    status: "running",
  };
}

function userText(text: string): UserModelMessage {
  return { role: "user", content: [{ type: "text", text: text }] };
}
