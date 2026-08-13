/**
 * In-process subagent dispatch coordinator.
 * Keep parent/child orchestration here; the model-facing schema stays in tools.
 */

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
import { logError, logInfo } from "../shared/log.ts";
import { LiveNatsPublisher, type NatsPublisher } from "../shared/nats.ts";
import { getObservabilityContext } from "../shared/otel.ts";
import {
  createSubagentTaskId,
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../shared/runtime-keys.ts";
import { getStorage } from "../shared/storage.ts";
import {
  createPendingAsyncAgentResult,
  markAsyncAgentResultCompleted,
  markAsyncAgentResultFailed,
} from "./async-agent-result.ts";
import {
  runAgentLoop,
  USER_STOP_MESSAGE,
  type SubagentParentContext,
} from "./harness.ts";
import {
  createAgentHookDispatcher,
  type HookDispatcher,
} from "./hook-dispatcher.ts";
import { acceptIngress } from "./ingress.ts";
import type { IngressDispatchScope } from "./integrations.ts";
import {
  createAgentLifecycleEmitter,
  toLifecycleValue,
  type AgentLifecycleEmitter,
  type AgentLifecycleEventPayload,
} from "./lifecycle.ts";
import { Session } from "./session.ts";
import type {
  RunSubagentDispatch,
  RunSubagentDispatchResult,
  RunSubagentTaskDispatch,
  RunSubagentTaskInput,
} from "./tools/run-subagent.tool.ts";
import {
  modelValueToUserParts,
  prependTextToUserParts,
} from "./tools/utils.ts";

const DEFAULT_SUBAGENT_WAIT_BUDGET_MS = 8 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const VIRTUAL_AGENT_PREFIX = "virtual_subagent_";

interface SubagentCompletion {
  taskId: string;
  eventId: string;
  agentId: string;
  description?: string;
  conversationKey: string;
  status: "completed" | "failed";
  response?: JSONValue;
  error?: string;
  // What the parent actually sees, after subagent.visibility + an onSubagentFinish
  // hook. Undefined => render the raw response.
  visibleResult?: JSONValue;
}

interface ResolvedSubagentTask {
  taskId: string;
  eventId: string;
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
}

interface SubagentStreamState {
  emittedError: boolean;
}

type AgentLoopStream = Awaited<ReturnType<typeof runAgentLoop>>;
type SubagentPublisherFactory = (
  task: ResolvedSubagentTask,
) => NatsPublisher | undefined;
type SubagentIngressDispatcher = (
  session: Session,
  scope: IngressDispatchScope,
) => Promise<boolean>;

// Collaborators the handler owns. Every one has a working default, so tests and
// non-handler callers override only what they exercise.
interface SubagentCoordinatorDependencies {
  lifecycle?: AgentLifecycleEmitter;
  publisherFactory?: SubagentPublisherFactory;
  dispatchNextIngress?: SubagentIngressDispatcher;
}

export class SubagentCoordinator {
  private readonly completions: SubagentCompletion[] = [];
  private readonly pending = new Map<string, Promise<void>>();
  private readonly pendingMetadata = new Map<
    string,
    Omit<SubagentCompletion, "status" | "response" | "error" | "visibleResult">
  >();
  private readonly waiters = new Set<() => void>();
  private hooksPromise?: Promise<HookDispatcher>;

  private readonly lifecycle: AgentLifecycleEmitter;
  private readonly publisherFactory: SubagentPublisherFactory;
  private readonly dispatchNextIngress: SubagentIngressDispatcher;

  constructor(
    private readonly parentSession: Session,
    private readonly parentAgentConfig: AgentConfig,
    private readonly waitUntilMs: number = Date.now() +
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
  }

  private get isPersistentMode(): boolean {
    return resolveSubagentMode(this.parentAgentConfig) === "persistent";
  }

  dispatch: RunSubagentDispatch = async (
    tasks: RunSubagentTaskInput[],
    parentMessages: ModelMessage[],
    parentEphemeralSystem: SystemModelMessage[] = [],
  ): Promise<RunSubagentDispatchResult> => {
    // Capture the parent's trace/task id now, while the parent's observability
    // context is still active (this runs synchronously inside the parent's
    // run_subagent tool call). Each child is its own top-level trace that links
    // back to the parent. Read here, not in the detached child, because concurrent
    // children overwrite the module-global observability context.
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

  async waitForIdle(
    options: {
      onHeartbeat?: (pendingCount: number) => void;
    } = {},
  ): Promise<"idle" | "timeout"> {
    while (this.pending.size > 0 && Date.now() < this.waitUntilMs) {
      const heartbeatAt = Math.min(
        Date.now() + HEARTBEAT_INTERVAL_MS,
        this.waitUntilMs,
      );
      await Promise.race([
        this.nextStateChange(),
        sleep(Math.max(heartbeatAt - Date.now(), 0)),
      ]);

      if (this.pending.size > 0) {
        options.onHeartbeat?.(this.pending.size);
      }
    }

    return this.pending.size === 0 ? "idle" : "timeout";
  }

  async drainCompletionsToParent(): Promise<number> {
    if (this.completions.length === 0) {
      return 0;
    }

    const completions = this.completions.splice(0);
    await this.parentSession.persistModelMessages(
      completions.map(completionToParentMessage),
    );

    return completions.length;
  }

  async drainCompletionsAndTimeoutsToParent(): Promise<number> {
    if (this.completions.length === 0 && this.pending.size === 0) {
      return 0;
    }

    const completions = this.completions.splice(0);
    const timeouts = [...this.pending.keys()].map(
      (taskId): SubagentCompletion => {
        const metadata = this.pendingMetadata.get(taskId);

        return {
          taskId: metadata?.taskId ?? taskId,
          eventId: metadata?.eventId ?? taskId,
          agentId: metadata?.agentId ?? "unknown",
          ...(metadata?.description
            ? { description: metadata.description }
            : {}),
          conversationKey: metadata?.conversationKey ?? "unknown",
          status: "failed",
          error:
            "Subagent task is still pending near the parent request timeout.",
        };
      },
    );

    this.pending.clear();
    this.pendingMetadata.clear();
    const batch = [...completions, ...timeouts];
    await this.parentSession.persistModelMessages(
      batch.map(completionToParentMessage),
    );

    return batch.length;
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
    const taskId = createSubagentTaskId(this.parentSession.eventId);
    const resuming = persistent && task.conversationKey !== undefined;
    const publicConversationKey =
      task.conversationKey ??
      (persistent
        ? `subagent-persistent-${crypto.randomUUID()}`
        : `subagent-${taskId}`);
    const inheritedContext =
      this.parentAgentConfig.subagent?.context === "inherited";
    if (task.agentId) {
      const agent = await this.resolveAllowedAgent(accountId, task.agentId);

      return {
        taskId: taskId,
        eventId: scopedDirectEventId(accountId, agent.agentId, taskId),
        agentId: agent.agentId,
        agentConfig: withoutNestedSubagents(agent.config),
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
      };
    }

    const virtualAgentId = `${VIRTUAL_AGENT_PREFIX}${taskId}`;

    return {
      taskId: taskId,
      eventId: scopedDirectEventId(accountId, virtualAgentId, taskId),
      agentId: virtualAgentId,
      agentConfig: withoutNestedSubagents(this.parentAgentConfig),
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
    };
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
    if (!agent || agent.status !== "active") {
      throw new Error(`Subagent not found: ${agentId}`);
    }

    return agent;
  }

  /**
   * Starts one child run in the background and tracks its lifecycle.
   *
   * This method intentionally does not await `runTask`. The parent model gets
   * task ids back immediately while the promise keeps progressing in the same
   * request or worker. Completion or failure is normalized into the coordinator
   * queue so the parent loop can inject it later.
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
    const promise = this.runTask(task, subagentParent, trackedPublisher)
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
   * Executes a one-shot child agent turn and records the result.
   *
   * Ephemeral child turns use an in-memory session wrapper. Persistent child
   * turns write the task prompt and generated child messages to the child
   * conversation while keeping inherited parent context ephemeral.
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
    // Initialize an isolated child session using the generated conversation key.
    // Inherit the parent's deployment scope (endpoint/project/stage) so the
    // child's spans and logs publish to the same live dashboard subscription and
    // its usage rows are counted in the right stage.
    const childSession = new Session(
      task.eventId,
      task.conversationKey,
      requireParentAccountId(this.parentSession),
      task.agentId,
      task.agentConfig,
      undefined,
      this.parentSession.endpointId,
      this.parentSession.projectSlug,
      this.parentSession.stageSlug,
      ownerGeneration,
    );
    let finalResponse: JSONValue | undefined;
    let approvalRequested = false;
    try {
      // Persistent mode writes the task prompt first so the child model response
      // and tool messages append to that conversation.
      const turnContext = await this.createChildTurnContext(
        childSession,
        task,
        incoming,
      );
      const session = task.persistent
        ? childSession
        : createEphemeralChildSession(childSession, turnContext.system);
      const stream = await runAgentLoop(
        session,
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
        subagentParent ? { subagentParent: subagentParent } : {},
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
      await childSession
        .settleIngress("failed", { error: errorText })
        .catch((settlementError) => {
          logError("Failed to settle subagent ingress failure", {
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
    }
  }

  private async completeSuccessfulRun(
    childSession: Session,
    task: ResolvedSubagentTask,
    finalResponse: JSONValue,
    subagentParent?: SubagentParentContext,
    publisher?: NatsPublisher,
  ): Promise<void> {
    await markAsyncAgentResultCompleted({
      eventId: task.eventId,
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
    // The durable result is authoritative. Settlement and queued-drain failures
    // must not turn this completed task into a second failed completion.
    await childSession
      .settleIngress("completed", { result: finalResponse })
      .catch((error) => {
        logError("Failed to settle completed subagent ingress", {
          taskId: task.taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
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
    // Past the parent's wait budget there is no live parent turn left to inject
    // into, so hand the envelope to a standalone worker instead of running it
    // here and dropping the answer.
    if (Date.now() >= this.waitUntilMs) {
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
          ...(next.agentConfig ? { agentConfig: next.agentConfig } : {}),
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
      agentConfig: task.agentConfig,
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
      agentConfig: task.agentConfig,
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
  ) {
    if (!task.persistent) {
      return childSession.createEphemeralTurnContext(
        [...(task.inheritedContext ? task.parentMessages : []), ...incoming],
        task.parentEphemeralSystem,
      );
    }

    await childSession.persistModelMessages(incoming);
    // `resuming` means the caller supplied an existing public conversationKey.
    // That is enough to load prior child history; when omitted, this is a new
    // persistent child conversation with a generated public key.
    if (task.resuming || !task.inheritedContext) {
      return childSession.createTurnContext(task.parentEphemeralSystem);
    }

    return childSession.createEphemeralTurnContext(
      [...task.parentMessages, ...incoming],
      task.parentEphemeralSystem,
    );
  }

  private async completeTask(completion: SubagentCompletion): Promise<void> {
    const shouldInjectToParent = this.pending.has(completion.taskId);

    if (completion.status === "failed") {
      await markAsyncAgentResultFailed({
        eventId: completion.eventId,
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

    // A stopped child was cancelled on purpose, so its partial progress is not
    // an answer the parent asked for. Record it, but keep it out of the transcript.
    if (completion.error === USER_STOP_MESSAGE) {
      this.notifyCompletion();
      logInfo("Subagent task stopped", {
        parentEventId: this.parentSession.eventId,
        taskId: completion.taskId,
        agentId: completion.agentId,
      });
      await this.emitTaskFinished({
        taskId: completion.taskId,
        agentId: completion.agentId,
        conversationKey: completion.conversationKey,
        status: "failed",
        error: completion.error,
      });

      return;
    }

    // Decide what the parent sees from this child: an onSubagentFinish hook wins;
    // otherwise subagent.visibility ("none" hides it, "result"/"full" show it).
    let inject = true;
    if (completion.status === "completed") {
      // The durable result is already written, so a hook that cannot load or
      // that throws only loses its override — it never fails the child.
      const hookVisible = await this.runSubagentFinishHook(completion).catch(
        (error) => {
          logError("Subagent finish hook failed", {
            taskId: completion.taskId,
            error: error instanceof Error ? error.message : String(error),
          });

          return undefined;
        },
      );
      if (hookVisible !== undefined) {
        completion.visibleResult = hookVisible;
      } else if (
        (this.parentAgentConfig.subagent?.visibility ?? "result") === "none"
      ) {
        inject = false;
      }
    }
    if (inject) {
      this.completions.push(completion);
    }
    this.notifyCompletion();
    logInfo("Subagent task completed", {
      parentEventId: this.parentSession.eventId,
      taskId: completion.taskId,
      agentId: completion.agentId,
      status: completion.status,
    });
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

  // Runs an onSubagentFinish (subagent.task.finished) hook and returns what it
  // wants the parent to see, or undefined when there is no such hook / no override.
  private async runSubagentFinishHook(
    completion: SubagentCompletion,
  ): Promise<JSONValue | undefined> {
    const hooks = await this.getHooks();
    const mutation = await hooks.runMutation("subagent.task.finished", {
      taskId: completion.taskId,
      agentId: completion.agentId,
      result:
        completion.response === undefined
          ? null
          : toLifecycleValue(completion.response),
    });

    return mutation?.visibleResult as JSONValue | undefined;
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

export async function pipeSubagentNatsStream(
  stream: AgentLoopStream,
  publisher: NatsPublisher,
): Promise<void> {
  const reader = stream.stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      await publisher.publish(value as Record<string, unknown>);
    }
  } finally {
    await stream.ensureFinalized();
  }

  const finalResponse = stream.finalResponse();
  if (stream.hasStructuredOutput() && finalResponse !== undefined) {
    await publisher.publish({
      type: "structured-output",
      output: finalResponse,
    });
  }
}

export function createEphemeralChildSession(
  childSession: Session,
  system: SystemModelMessage[],
): Session {
  return {
    accountId: childSession.accountId,
    agentId: childSession.agentId,
    conversationKey: childSession.conversationKey,
    eventId: childSession.eventId,
    // Carry the deployment scope through to the child run. runAgentLoop reads
    // these off the session to stamp project/stage/endpoint_id on the
    // subtask span and to build the live NATS subject. Omitting them (the prior
    // bug) left subagent spans with only account_id, so publishSpan early-returned
    // (no live span) AND the dashboard's project+stage-scoped Tempo backfill
    // never matched them — subagents were invisible in tracing and a reload didn't
    // bring them back.
    endpointId: childSession.endpointId,
    projectSlug: childSession.projectSlug,
    stageSlug: childSession.stageSlug,
    filesystemNamespace: () => childSession.filesystemNamespace(),
    resolvedWorkspaces: () => childSession.resolvedWorkspaces(),
    agentSandbox: () => childSession.agentSandbox(),
    agentSandboxPermissionMode: () => childSession.agentSandboxPermissionMode(),
    persistModelMessages: async () => [],
    loadSkillPrompt: (
      allowedSkillPaths: string[],
      skillPath: string,
      resourcePaths?: string[],
    ) =>
      childSession.loadSkillPrompt(allowedSkillPaths, skillPath, resourcePaths),
    loadRefreshedSystemPromptParts: async (options: {
      systemContextSnapshot: {
        cursor: string | null;
        messages: SystemModelMessage[];
      };
      ephemeralSystem?: SystemModelMessage[];
    }) => {
      const refreshed = await childSession.createEphemeralTurnContext(
        [],
        options.ephemeralSystem ?? [],
      );

      return {
        systemContextSnapshot: options.systemContextSnapshot,
        system: refreshed.system.length > 0 ? refreshed.system : system,
      };
    },
  } as unknown as Session;
}

function toDispatch(task: ResolvedSubagentTask): RunSubagentTaskDispatch {
  return {
    taskId: task.taskId,
    agentId: task.agentId,
    ...(task.description ? { description: task.description } : {}),
    conversationKey: task.publicConversationKey,
    statusPath: subagentStatusPath(task),
    status: "running",
  };
}

function subagentStatusPath(task: ResolvedSubagentTask): string {
  return `/status/${encodeURIComponent(task.taskId)}?agentId=${encodeURIComponent(task.agentId)}`;
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

  return {
    role: "user",
    content:
      resultParts.length > 0
        ? prependTextToUserParts(prefix, resultParts)
        : [
            {
              type: "text",
              text: `${prefix}${completion.error ?? "(no result)"}`,
            },
          ],
  };
}

function createSubagentPublisher(
  parentSession: Session,
  task: ResolvedSubagentTask,
): NatsPublisher | undefined {
  const natsUrl = process.env.NATS_URL?.trim();
  if (!natsUrl) {
    return undefined;
  }

  return new LiveNatsPublisher(
    natsUrl,
    {
      accountId: requireParentAccountId(parentSession),
      agentId: task.agentId,
      conversationKey: task.publicConversationKey,
      eventId: task.taskId,
      connectionId: task.taskId,
    },
    process.env.NATS_TOKEN?.trim() || undefined,
  );
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

function withoutNestedSubagents(config: AgentConfig): AgentConfig {
  return {
    ...config,
    subagent: {
      ...(config.subagent ?? {}),
      enabled: false,
    },
  };
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
