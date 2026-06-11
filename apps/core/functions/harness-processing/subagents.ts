/**
 * In-process subagent dispatch coordinator.
 * Keep parent/child orchestration here; the model-facing schema stays in tools.
 */

import type { ModelMessage, SystemModelMessage, UserModelMessage, JSONValue } from "ai";
import type { AgentConfig } from "../_shared/storage/index.ts";
import { getStorage, type AgentRecord } from "../_shared/storage/index.ts";
import { logError, logInfo } from "../_shared/log.ts";
import {
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../_shared/runtime-keys.ts";
import { runAgentLoop } from "./harness.ts";
import { createAgentLifecycleEmitter, type AgentLifecycleEmitter, toLifecycleValue } from "./lifecycle.ts";
import { Session } from "./session.ts";
import {
  createPendingAsyncAgentResult,
  markAsyncAgentResultCompleted,
  markAsyncAgentResultFailed,
} from "./async-agent-result.ts";
import type {
  RunSubagentDispatch,
  RunSubagentDispatchResult,
  RunSubagentTaskDispatch,
  RunSubagentTaskInput,
} from "./tools/run-subagent.tool.ts";

const DEFAULT_SUBAGENT_WAIT_BUDGET_MS = 8 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const VIRTUAL_AGENT_PREFIX = "virtual_subagent_";

interface SubagentCompletion {
  taskId: string;
  agentId: string;
  description?: string;
  conversationKey: string;
  status: "completed" | "failed";
  response?: JSONValue;
  error?: string;
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

export class SubagentCoordinator {
  private readonly completions: SubagentCompletion[] = [];
  private readonly pending = new Map<string, Promise<void>>();
  private readonly pendingMetadata = new Map<string, Omit<SubagentCompletion, "status" | "response" | "error">>();
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly parentSession: Session,
    private readonly parentAgentConfig: AgentConfig,
    private readonly waitUntilMs: number = Date.now() + DEFAULT_SUBAGENT_WAIT_BUDGET_MS,
    private readonly lifecycle: AgentLifecycleEmitter = createAgentLifecycleEmitter(parentSession, parentAgentConfig),
  ) { }

  private get isPersistentMode(): boolean {
    return this.parentAgentConfig.subagent?.mode === "persistent";
  }

  dispatch: RunSubagentDispatch = async (
    tasks: RunSubagentTaskInput[],
    parentMessages: ModelMessage[],
    parentEphemeralSystem: SystemModelMessage[] = [],
  ): Promise<RunSubagentDispatchResult> => {
    // Resolve all inputs before launching anything. If one task is invalid,
    // the tool call fails without starting a partial batch of child runs.
    const resolvedTasks = await Promise.all(
      tasks.map((task) => this.resolveTask(task, parentMessages, parentEphemeralSystem)),
    );

    // Create status rows before returning task ids so clients can poll the ids
    // as soon as the model sees the tool result.
    await Promise.all(resolvedTasks.map((task) =>
      createPendingAsyncAgentResult({
        eventId: task.eventId,
        conversationKey: task.conversationKey,
      })
    ));

    await Promise.all(resolvedTasks.map((task) =>
      this.lifecycle.emit("subagent.task.started", {
        taskId: task.taskId,
        agentId: task.agentId,
        conversationKey: task.publicConversationKey,
        inheritedContext: task.inheritedContext,
        persistent: task.persistent,
        resuming: task.resuming,
      })
    ));

    const dispatches = resolvedTasks.map((task) => {
      // Intentionally not awaited: child agents run concurrently while the
      // parent model can keep streaming or later wait for injected results.
      this.startTask(task);
      return toDispatch(task);
    });

    return { tasks: dispatches };
  };

  get pendingCount(): number {
    return this.pending.size;
  }

  async waitForIdle(options: {
    onHeartbeat?: (pendingCount: number) => void;
  } = {}): Promise<"idle" | "timeout"> {
    while (this.pending.size > 0 && Date.now() < this.waitUntilMs) {
      const heartbeatAt = Math.min(Date.now() + HEARTBEAT_INTERVAL_MS, this.waitUntilMs);
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
    await this.parentSession.persistModelMessages(completions.map(completionToParentMessage));
    return completions.length;
  }

  async drainCompletionsAndTimeoutsToParent(): Promise<number> {
    if (this.completions.length === 0 && this.pending.size === 0) {
      return 0;
    }

    const completions = this.completions.splice(0);
    const timeouts = [...this.pending.keys()].map((taskId): SubagentCompletion => {
      const metadata = this.pendingMetadata.get(taskId);
      return {
        taskId: metadata?.taskId ?? taskId,
        agentId: metadata?.agentId ?? "unknown",
        ...(metadata?.description ? { description: metadata.description } : {}),
        conversationKey: metadata?.conversationKey ?? "unknown",
        status: "failed",
        error: "Subagent task is still pending near the parent request timeout.",
      };
    });

    this.pending.clear();
    this.pendingMetadata.clear();
    const batch = [...completions, ...timeouts];
    await this.parentSession.persistModelMessages(batch.map(completionToParentMessage));
    return batch.length;
  }

  private async resolveTask(
    task: RunSubagentTaskInput,
    parentMessages: ModelMessage[],
    parentEphemeralSystem: SystemModelMessage[],
  ): Promise<ResolvedSubagentTask> {
    const accountId = requireParentAccountId(this.parentSession);
    const taskId = `subagent_${crypto.randomUUID()}`;
    const persistent = this.isPersistentMode;
    if (!persistent && task.conversationKey !== undefined) {
      throw new Error("Subagent conversationKey is only supported in persistent mode");
    }
    const resuming = persistent && task.conversationKey !== undefined;
    const publicConversationKey = task.conversationKey
      ?? (persistent ? `subagent-persistent-${crypto.randomUUID()}` : `subagent-${taskId}`);
    const inheritedContext = this.parentAgentConfig.subagent?.context === "inherited";
    if (task.agentId) {
      const agent = await this.resolveAllowedAgent(accountId, task.agentId);
      return {
        taskId,
        eventId: scopedDirectEventId(accountId, agent.agentId, taskId),
        agentId: agent.agentId,
        agentConfig: withoutNestedSubagents(agent.config),
        ...(agent.description ? { description: agent.description } : {}),
        publicConversationKey,
        conversationKey: scopedDirectConversationKey(accountId, agent.agentId, publicConversationKey),
        prompt: task.prompt,
        inheritedContext,
        parentMessages,
        parentEphemeralSystem,
        persistent,
        resuming,
      };
    }

    const virtualAgentId = `${VIRTUAL_AGENT_PREFIX}${taskId}`;
    return {
      taskId,
      eventId: scopedDirectEventId(accountId, virtualAgentId, taskId),
      agentId: virtualAgentId,
      agentConfig: withoutNestedSubagents(this.parentAgentConfig),
      publicConversationKey,
      conversationKey: scopedDirectConversationKey(accountId, virtualAgentId, publicConversationKey),
      prompt: task.prompt,
      inheritedContext,
      parentMessages,
      parentEphemeralSystem,
      persistent,
      resuming,
    };
  }

  private async resolveAllowedAgent(accountId: string, agentId: string): Promise<AgentRecord> {
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
   * Lambda invocation. Completion or failure is normalized into the coordinator
   * queue so the parent loop can inject it later.
   */
  private startTask(task: ResolvedSubagentTask): void {
    const promise = this.runTask(task)
      .catch((error) => this.completeTask({
        taskId: task.taskId,
        agentId: task.agentId,
        ...(task.description ? { description: task.description } : {}),
        conversationKey: task.publicConversationKey,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        this.pending.delete(task.taskId);
        this.pendingMetadata.delete(task.taskId);
        this.notifyCompletion();
      });

    this.pending.set(task.taskId, promise);
    this.pendingMetadata.set(task.taskId, {
      taskId: task.taskId,
      agentId: task.agentId,
      ...(task.description ? { description: task.description } : {}),
      conversationKey: task.publicConversationKey,
    });
  }

  /**
   * Executes a one-shot child agent turn and records the result.
   *
   * Ephemeral child turns use an in-memory session wrapper. Persistent child
   * turns write the task prompt and generated child messages to the child
   * conversation while keeping inherited parent context ephemeral.
   */
  private async runTask(task: ResolvedSubagentTask): Promise<void> {
    logInfo("Subagent task started", {
      parentEventId: this.parentSession.eventId,
      taskId: task.taskId,
      agentId: task.agentId,
      conversationKey: task.conversationKey,
      inheritedContext: task.inheritedContext,
      persistent: task.persistent,
      resuming: task.resuming,
    });

    // Initialize an isolated child session using the generated conversation key.
    const childSession = new Session(
      task.eventId,
      task.conversationKey,
      requireParentAccountId(this.parentSession),
      task.agentId,
      task.agentConfig,
    );
    const promptMessage: UserModelMessage = {
      role: "user",
      content: [{ type: "text", text: task.prompt }],
    };
    // `persistent` controls whether the child uses a real persisted Session or
    // the in-memory wrapper. Persistent mode writes the task prompt first so
    // the child model response and any tool messages append to that conversation.
    const turnContext = await this.createChildTurnContext(childSession, task, promptMessage);
    let finalResponse: JSONValue | undefined;
    let approvalRequested = false;

    const session = task.persistent
      ? childSession
      : createEphemeralChildSession(childSession, turnContext.system);
    const stream = await runAgentLoop(session, turnContext, task.agentConfig, {
      onFinalText: async (response) => {
        finalResponse = response;
      },
      onErrorText: async (error) => {
        throw new Error(error);
      },
      onApprovalRequired: async () => {
        approvalRequested = true;
      },
    });

    await stream.consumeStream();
    if (approvalRequested) {
      throw new Error("Subagent task stopped for tool approval");
    }
    if (stream.didFail()) {
      throw new Error(stream.failureText() ?? "Subagent task failed");
    }
    if (finalResponse === undefined) {
      throw new Error("Subagent task returned an empty response");
    }

    await markAsyncAgentResultCompleted({
      eventId: task.eventId,
      response: finalResponse,
    });
    await this.completeTask({
      taskId: task.taskId,
      agentId: task.agentId,
      ...(task.description ? { description: task.description } : {}),
      conversationKey: task.publicConversationKey,
      status: "completed",
      response: finalResponse,
    });
  }

  private async createChildTurnContext(
    childSession: Session,
    task: ResolvedSubagentTask,
    promptMessage: UserModelMessage,
  ) {
    if (!task.persistent) {
      return childSession.createEphemeralTurnContext([
        ...(task.inheritedContext ? task.parentMessages : []),
        promptMessage,
      ], task.parentEphemeralSystem);
    }

    await childSession.persistModelMessages([promptMessage]);
    // `resuming` means the caller supplied an existing public conversationKey.
    // That is enough to load prior child history; when omitted, this is a new
    // persistent child conversation with a generated public key.
    if (task.resuming || !task.inheritedContext) {
      return childSession.createTurnContext(task.parentEphemeralSystem);
    }

    return childSession.createEphemeralTurnContext([
      ...task.parentMessages,
      promptMessage,
    ], task.parentEphemeralSystem);
  }

  private async completeTask(completion: SubagentCompletion): Promise<void> {
    const shouldInjectToParent = this.pending.has(completion.taskId);

    if (completion.status === "failed") {
      await markAsyncAgentResultFailed({
        eventId: scopedDirectEventId(
          requireParentAccountId(this.parentSession),
          completion.agentId,
          completion.taskId,
        ),
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

    this.completions.push(completion);
    this.notifyCompletion();
    logInfo("Subagent task completed", {
      parentEventId: this.parentSession.eventId,
      taskId: completion.taskId,
      agentId: completion.agentId,
      status: completion.status,
    });
    await this.lifecycle.emit("subagent.task.finished", {
      taskId: completion.taskId,
      agentId: completion.agentId,
      conversationKey: completion.conversationKey,
      status: completion.status,
      ...(completion.response !== undefined ? { response: toLifecycleValue(completion.response) } : {}),
      ...(completion.error ? { error: completion.error } : {}),
    });
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

function createEphemeralChildSession(childSession: Session, system: SystemModelMessage[]): Session {
  return {
    accountId: childSession.accountId,
    agentId: childSession.agentId,
    conversationKey: childSession.conversationKey,
    eventId: childSession.eventId,
    filesystemNamespace: () => childSession.filesystemNamespace(),
    resolvedWorkspaces: () => childSession.resolvedWorkspaces(),
    statelessSandbox: () => childSession.statelessSandbox(),
    statelessPermissionMode: () => childSession.statelessPermissionMode(),
    persistModelMessages: async () => [],
    loadSkillPrompt: (allowedSkillPaths: string[], skillPath: string, resourcePaths?: string[]) =>
      childSession.loadSkillPrompt(allowedSkillPaths, skillPath, resourcePaths),
    loadRefreshedSystemPromptParts: async (options: {
      systemContextSnapshot: { cursor: string | null; messages: SystemModelMessage[] };
      ephemeralSystem?: SystemModelMessage[];
    }) => {
      const refreshed = await childSession.createEphemeralTurnContext([], options.ephemeralSystem ?? []);
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
    statusPath: `/status/${encodeURIComponent(task.taskId)}?agentId=${encodeURIComponent(task.agentId)}`,
    status: "running",
  };
}

function completionToParentMessage(completion: SubagentCompletion): UserModelMessage {
  const metadata = [
    `taskId: ${completion.taskId}`,
    `agentId: ${completion.agentId}`,
    ...(completion.description ? [`agentDescription: ${completion.description}`] : []),
    `conversationKey: ${completion.conversationKey}`,
    `status: ${completion.status}`,
  ].join("\n");
  const result = completion.status === "completed"
    ? completion.response === undefined ? "(no result)" : formatModelValue(completion.response)
    : completion.error;

  return {
    role: "user",
    content: [{
      type: "text",
      text: `Subagent and async agent result injected into parent conversation.\n${metadata}\n\nResult:\n${result ?? "(no result)"}`,
    }],
  };
}

function formatModelValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
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
