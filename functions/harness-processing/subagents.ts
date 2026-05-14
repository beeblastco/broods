/**
 * In-process subagent dispatch coordinator.
 * Keep parent/child orchestration here; the model-facing schema stays in tools.
 */

import type { ModelMessage, SystemModelMessage, UserModelMessage } from "ai";
import type { AccountConfig } from "../_shared/accounts.ts";
import { getAgent, type AgentRecord } from "../_shared/agents.ts";
import { logError, logInfo } from "../_shared/log.ts";
import {
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../_shared/runtime-keys.ts";
import { runAgentLoop } from "./harness.ts";
import { Session } from "./session.ts";
import {
  createPendingAsyncResult,
  markAsyncResultCompleted,
  markAsyncResultFailed,
} from "./status.ts";
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
  name: string;
  description?: string;
  conversationKey: string;
  status: "completed" | "failed";
  response?: string;
  error?: string;
}

interface ResolvedSubagentTask {
  taskId: string;
  eventId: string;
  agentId: string;
  accountConfig: AccountConfig;
  name: string;
  description?: string;
  publicConversationKey: string;
  conversationKey: string;
  prompt: string;
  inheritedContext: boolean;
  parentMessages: ModelMessage[];
  parentEphemeralSystem: SystemModelMessage[];
}

export class SubagentCoordinator {
  private readonly completions: SubagentCompletion[] = [];
  private readonly pending = new Map<string, Promise<void>>();
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly parentSession: Session,
    private readonly parentAccountConfig: AccountConfig,
    private readonly waitUntilMs: number = Date.now() + DEFAULT_SUBAGENT_WAIT_BUDGET_MS,
  ) { }

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
      createPendingAsyncResult({
        eventId: task.eventId,
        conversationKey: task.conversationKey,
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

  hasCompletions(): boolean {
    return this.completions.length > 0;
  }

  async waitForNextCompletion(options: {
    onHeartbeat?: (pendingCount: number) => void;
  } = {}): Promise<boolean> {
    while (this.pending.size > 0 && this.completions.length === 0 && Date.now() < this.waitUntilMs) {
      const heartbeatAt = Math.min(Date.now() + HEARTBEAT_INTERVAL_MS, this.waitUntilMs);
      await Promise.race([
        this.nextCompletion(),
        sleep(Math.max(heartbeatAt - Date.now(), 0)),
      ]);

      if (this.completions.length === 0 && this.pending.size > 0) {
        options.onHeartbeat?.(this.pending.size);
      }
    }

    return this.completions.length > 0;
  }

  async drainCompletionsToParent(): Promise<number> {
    if (this.completions.length === 0) {
      return 0;
    }

    const completions = this.completions.splice(0);
    await this.parentSession.persistModelMessages(completions.map(completionToParentMessage));
    return completions.length;
  }

  async injectTimeoutsToParent(): Promise<number> {
    if (this.pending.size === 0) {
      return 0;
    }

    const timeouts = [...this.pending.keys()].map((taskId): SubagentCompletion => ({
      taskId,
      agentId: "unknown",
      name: "Pending subagent",
      conversationKey: "unknown",
      status: "failed",
      error: "Subagent task is still pending near the parent request timeout.",
    }));

    this.pending.clear();
    await this.parentSession.persistModelMessages(timeouts.map(completionToParentMessage));
    return timeouts.length;
  }

  private async resolveTask(
    task: RunSubagentTaskInput,
    parentMessages: ModelMessage[],
    parentEphemeralSystem: SystemModelMessage[],
  ): Promise<ResolvedSubagentTask> {
    const accountId = requireParentAccountId(this.parentSession);
    const taskId = `subagent_${crypto.randomUUID()}`;
    const publicConversationKey = `subagent-${taskId}`;
    const inheritedContext = task.shareContext ?? this.parentAccountConfig.subagent?.context === "inherited";
    if (task.agentId) {
      const agent = await this.resolveAllowedAgent(accountId, task.agentId);
      return {
        taskId,
        eventId: scopedDirectEventId(accountId, agent.agentId, taskId),
        agentId: agent.agentId,
        accountConfig: withoutNestedSubagents(agent.config),
        name: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
        publicConversationKey,
        conversationKey: scopedDirectConversationKey(accountId, agent.agentId, publicConversationKey),
        prompt: task.prompt,
        inheritedContext,
        parentMessages,
        parentEphemeralSystem,
      };
    }

    const virtualAgentId = `${VIRTUAL_AGENT_PREFIX}${taskId}`;
    return {
      taskId,
      eventId: scopedDirectEventId(accountId, virtualAgentId, taskId),
      agentId: virtualAgentId,
      accountConfig: withoutNestedSubagents(this.parentAccountConfig),
      name: task.name ?? "Virtual subagent",
      publicConversationKey,
      conversationKey: scopedDirectConversationKey(accountId, virtualAgentId, publicConversationKey),
      prompt: task.prompt,
      inheritedContext,
      parentMessages,
      parentEphemeralSystem,
    };
  }

  private async resolveAllowedAgent(accountId: string, agentId: string): Promise<AgentRecord> {
    const allowed = this.parentAccountConfig.subagent?.allowed ?? [];
    if (!allowed.includes(agentId)) {
      throw new Error(`Subagent is not allowed: ${agentId}`);
    }

    const agent = await getAgent(accountId, agentId);
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
        name: task.name,
        ...(task.description ? { description: task.description } : {}),
        conversationKey: task.publicConversationKey,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        this.pending.delete(task.taskId);
        this.notifyCompletion();
      });

    this.pending.set(task.taskId, promise);
  }

  /**
   * Executes a one-shot child agent turn and records the result.
   *
   * Child turns use an ephemeral session wrapper: inherited parent context and
   * generated child messages are visible to the model, but they are not copied
   * into the child conversation table. Only task status and the final result or
   * error are persisted for polling and parent continuation.
   */
  private async runTask(task: ResolvedSubagentTask): Promise<void> {
    logInfo("Subagent task started", {
      parentEventId: this.parentSession.eventId,
      taskId: task.taskId,
      agentId: task.agentId,
      conversationKey: task.conversationKey,
      inheritedContext: task.inheritedContext,
    });

    // Initialize an isolated child session using the generated conversation key.
    const childSession = new Session(
      task.eventId,
      task.conversationKey,
      requireParentAccountId(this.parentSession),
      task.agentId,
      task.accountConfig,
    );
    const promptMessage: UserModelMessage = {
      role: "user",
      content: [{ type: "text", text: task.prompt }],
    };
    const messages = [
      ...(task.inheritedContext ? task.parentMessages : []),
      promptMessage,
    ] satisfies ModelMessage[];
    // Child runs are in-memory turns. Forward parent ephemeral system messages
    // so request-local instructions survive delegation without being persisted.
    const turnContext = await childSession.createEphemeralTurnContext(messages, task.parentEphemeralSystem);
    let finalText = "";
    let approvalRequested = false;

    const session = createEphemeralChildSession(childSession, turnContext.system);
    const stream = await runAgentLoop(session, turnContext, task.accountConfig, {
      onFinalText: async (text) => {
        finalText = text;
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
    if (!finalText.trim()) {
      throw new Error("Subagent task returned an empty response");
    }

    await markAsyncResultCompleted({
      eventId: task.eventId,
      response: finalText,
    });
    await this.completeTask({
      taskId: task.taskId,
      agentId: task.agentId,
      name: task.name,
      ...(task.description ? { description: task.description } : {}),
      conversationKey: task.publicConversationKey,
      status: "completed",
      response: finalText,
    });
  }

  private async completeTask(completion: SubagentCompletion): Promise<void> {
    if (completion.status === "failed") {
      await markAsyncResultFailed({
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

    this.completions.push(completion);
    this.notifyCompletion();
    logInfo("Subagent task completed", {
      parentEventId: this.parentSession.eventId,
      taskId: completion.taskId,
      agentId: completion.agentId,
      status: completion.status,
    });
  }

  private nextCompletion(): Promise<void> {
    if (this.completions.length > 0) {
      return Promise.resolve();
    }

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
    name: task.name,
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
    `agentName: ${completion.name}`,
    ...(completion.description ? [`agentDescription: ${completion.description}`] : []),
    `conversationKey: ${completion.conversationKey}`,
    `status: ${completion.status}`,
  ].join("\n");
  const result = completion.status === "completed"
    ? completion.response
    : completion.error;

  return {
    role: "user",
    content: [{
      type: "text",
      text: `Subagent result injected into parent conversation.\n${metadata}\n\nResult:\n${result ?? "(no result)"}`,
    }],
  };
}

function withoutNestedSubagents(config: AccountConfig): AccountConfig {
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
