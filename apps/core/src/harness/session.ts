/**
 * Session lifecycle for harness-processing.
 * Keep event persistence, context projection, leases, and prompt loading here.
 */

import type { HarnessAgentSkill } from "@ai-sdk/harness/agent";
import {
  systemModelMessageSchema,
  type AssistantModelMessage,
  type FilePart,
  type ImagePart,
  type ModelMessage,
  type SystemModelMessage,
  type ToolModelMessage,
  type UserContent,
  type UserModelMessage,
} from "ai";
import type { Attachment } from "chat";
import type { ChannelActions } from "../shared/channels.ts";
import { runtime } from "../shared/convex/runtime.ts";
import type {
  ChannelPartition,
  AgentConfig,
} from "../shared/domain/agent-config.ts";
import type { SandboxPermissionMode } from "../shared/domain/sandbox-config.ts";
import {
  workspaceGuidanceEnabled,
  workspaceMemoryHarnessEnabled,
} from "../shared/domain/workspace-config.ts";
import { logDebug, logError } from "../shared/log.ts";
import { isPlainObject } from "../shared/object.ts";
import { channelScopeKeyFromConversation } from "../shared/runtime-keys.ts";
import { isMissingS3Error, readS3Text } from "../shared/s3.ts";
import { getStorage } from "../shared/storage.ts";
import {
  resolveAgentRuntime,
  type ResolvedAgentRuntime,
  type ResolvedWorkspace,
} from "../shared/workspaces.ts";
import type { AsyncToolDelivery } from "./async-tool-result.ts";
import { ingestInboundAttachments } from "./channel-media.ts";
import {
  compactSessionContext,
  isCompactionSummaryMessage,
} from "./compaction.ts";
import {
  applySteering,
  DEFAULT_CONVERSATION_LEASE_TTL_MS,
  settleIngress,
  takeNextIngress,
  type AppliedIngress,
} from "./ingress.ts";
import {
  modelIdentityFromModelConfig,
  withoutStoredItemId,
} from "./provider.ts";
import { pruneSessionMessages, retainsReasoningParts } from "./pruning.ts";
import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "./sandbox/s3-mount.ts";
import type { SandboxExecutorConfig } from "./sandbox/types.ts";
import {
  listConfiguredSkillMetadata,
  loadConfiguredHarnessSkills,
  loadConfiguredSkillPrompt,
  type SkillMetadata,
} from "./skills.ts";
import { MEMORY_INDEX_PATH } from "./tools/memory.tool.ts";

// What started a run when it was not a person asking: so far only the scheduler
// firing a cron. It names the root trace span and withholds every schedule tool.
export type RunTrigger = "cron";

export type ConversationIngressEvent =
  // `metadata` is opaque hook data persisted on the stored-event envelope,
  // never inside the model message. See StoredEventBase.
  | (UserModelMessage & { metadata?: unknown })
  | AssistantModelMessage
  | ToolModelMessage
  | (SystemModelMessage & { persist?: boolean });

export interface TurnContextSnapshot {
  messages: ModelMessage[];
  system: SystemModelMessage[];
  // Request-local system messages. These are already included in `system`, but
  // the harness keeps the source list so prepareStep can rebuild system prompts
  // during the same model run without dropping temporary instructions.
  ephemeralSystem: SystemModelMessage[];
  // Cursor-backed system context that prepareStep can refresh incrementally mid-run.
  systemContextSnapshot: SystemContextSnapshot;
  // Wall-clock windows for the work that precedes the model run, so the harness
  // can surface them as trace phase spans. Absent for in-memory ephemeral turns.
  timings?: TurnContextTimings;
}

export interface TurnContextTimings {
  // Whole createTurnContext span (load + project + system prompt + prune).
  prepareStartedMs: number;
  prepareEndedMs: number;
  // Present only when compaction actually produced a summary this turn.
  compaction?: { startedMs: number; endedMs: number };
}

export interface SystemContextSnapshot {
  // Highest conversation row already folded into the dynamic system-context view.
  // `loadRefreshedSystemPromptParts` uses this as a Convex cursor so each
  // prepareStep only loads newly persisted system messages instead of
  // rebuilding system context from the full conversation every time.
  cursor: string | null;
  // Persisted system-role events accumulated up to cursor.
  // These are not normal chat history. `buildSystemPromptParts` appends them
  // to the model's `system` prompt while `projectEntriesToMessages` omits them
  // from the user/assistant/tool message list.
  messages: SystemModelMessage[];
}

interface SubagentMetadata {
  agentId: string;
  name: string;
  description?: string;
}

export interface StoredHarnessSession {
  harnessType: "claude-code" | "codex" | "deepagents" | "opencode" | "pi";
  sessionId: string;
  resumeState: unknown;
}

/**
 * Shared fields for every stored conversation event.
 * `version` gives us a migration hook for future schema changes, and
 * `sourceEventId` ties projected rows back to the inbound request/webhook event
 * that created them for dedupe/debugging.
 * `metadata` is opaque channel.message.received hook data; core never
 * interprets it, only persists and re-exposes it on hook payloads.
 */
interface StoredEventBase {
  version: 1;
  sourceEventId: string;
  metadata?: unknown;
  // Which model produced an assistant message, as `provider/modelId`. Reasoning
  // and the stored-item ids beside it are only replayable to that same model,
  // so projection needs to know. Absent on rows written before we recorded it,
  // and on every message a model did not write.
  model?: string;
}

/**
 * The model behind a message being persisted. `retainsReasoning` is what the
 * provider will actually replay: storing reasoning nobody sends back is dead
 * weight, and on a stored-item provider dropping it breaks the next turn.
 */
interface MessageProducer {
  model?: string;
  retainsReasoning?: boolean;
}

// Internal normalized shapes persisted in Convex. We use AI SDK-style roles
// here as well so an event is effectively a stored model message plus metadata.
interface StoredConversationEventBase<
  TMessage extends ModelMessage,
> extends StoredEventBase {
  message: TMessage;
}

type StoredConversationEvent =
  | StoredConversationEventBase<UserModelMessage>
  | StoredConversationEventBase<AssistantModelMessage>
  | StoredConversationEventBase<ToolModelMessage>
  | StoredConversationEventBase<SystemModelMessage>;

// Query results need both the stored event payload and its ordered cursor so
// we can build point-in-time snapshots and later fetch only prompt deltas after
// a known cursor.
interface StoredConversationEntry {
  createdAt: string;
  event: StoredConversationEvent;
}

interface StoredConversationEventPage {
  page: Array<{ cursor: string; event: StoredConversationEvent }>;
  isDone: boolean;
  continueCursor: string | null;
}

/**
 * What a turn carries into its session. Only the event and its conversation are
 * always known; every other field depends on how the run arrived.
 */
export interface SessionOptions {
  eventId: string;
  conversationKey: string;
  accountId?: string;
  agentId?: string;
  agentConfig?: AgentConfig;
  // Where a deferred result spawned in this turn (a detached background job)
  // should be delivered when it settles in a later invocation. Carries the
  // originating chat channel or WebSocket connection; absent for plain
  // direct/async API turns, which fall back to status polling.
  delivery?: AsyncToolDelivery;
  // Per-deployment id from the runtime key that authorized this turn. Present
  // for deployment-key traffic and resolved channel integrations.
  // Used to scope realtime telemetry to the dashboard's deployment view.
  endpointId?: string;
  // Project and stage slugs from the runtime key scope. Present for
  // deployment-key traffic and resolved channel integrations. Used to build
  // NATS observability subjects (tracesSubject, logsSubject) for live streaming.
  projectSlug?: string;
  stageSlug?: string;
  // Monotonic Convex fencing token. Present for every coordinator-admitted run;
  // absent only on context-only writes that do not execute a model turn.
  ownerGeneration?: number;
  // Bound to the current inbound message so model-facing channel tools retain
  // the credential holder and exact provider reply target.
  channelActions?: ChannelActions;
  // Absent for the ordinary channel/API paths, where a person is waiting.
  trigger?: RunTrigger;
}

/**
 * Agent conversation session.
 * Owns persistence, leases, prompt assembly, and in-memory child turns.
 */
export class Session {
  readonly eventId: string;
  readonly conversationKey: string;
  readonly accountId: string | undefined;
  readonly agentId: string | undefined;
  readonly delivery: AsyncToolDelivery | undefined;
  readonly endpointId: string | undefined;
  readonly projectSlug: string | undefined;
  readonly stageSlug: string | undefined;
  readonly ownerGeneration: number | undefined;
  readonly channelActions: ChannelActions | undefined;
  readonly trigger: RunTrigger | undefined;
  private readonly agentConfig: AgentConfig;
  private messageSequence = 0;
  private hasLoggedMissingMemoryFile = false;
  // One clock reading for the whole run: the system prompt is rebuilt before
  // every step, so a moving timestamp would break the provider's prompt cache.
  private readonly startedAt = new Date();
  private loadedSkillPrompts: SystemModelMessage[] = [];
  private subagentMetadataPromise: Promise<SubagentMetadata[]> | undefined;
  // Resolved sandbox + workspace records (from the agent's `sandbox`/`workspaces`
  // refs). Resolved once per session at turn-context construction; the sync
  // getters below read the cached value.
  private resolvedRuntime: ResolvedAgentRuntime | undefined;
  private resolvedRuntimePromise: Promise<ResolvedAgentRuntime> | undefined;

  constructor(options: SessionOptions) {
    this.eventId = options.eventId;
    this.conversationKey = options.conversationKey;
    this.accountId = options.accountId;
    this.agentId = options.agentId;
    this.agentConfig = options.agentConfig ?? {};
    this.delivery = options.delivery;
    this.endpointId = options.endpointId;
    this.projectSlug = options.projectSlug;
    this.stageSlug = options.stageSlug;
    this.ownerGeneration = options.ownerGeneration;
    this.channelActions = options.channelActions;
    this.trigger = options.trigger;
  }

  /** Rejects a side effect when this run no longer owns the conversation. */
  async assertCurrentOwner(): Promise<void> {
    if (this.ownerGeneration === undefined) return;
    const current = await runtime.query<boolean>("isCurrentIngressOwner", {
      conversationKey: this.conversationKey,
      ownerEventId: this.eventId,
      ownerGeneration: this.ownerGeneration,
    });
    if (!current) throw new Error("Stale conversation owner generation");
  }

  async claim(): Promise<boolean> {
    if (!this.accountId) {
      throw new Error("Account ID is required for runtime claims");
    }

    return runtime.mutate("claimEvent", {
      accountId: this.accountId,
      key: this.eventId,
      ttlSeconds: 86400,
    });
  }

  async release(): Promise<void> {
    if (!this.accountId) {
      throw new Error("Account ID is required for runtime claims");
    }

    await runtime.mutate("releaseClaim", {
      accountId: this.accountId,
      key: this.eventId,
    });
  }

  async releaseConversationLease(): Promise<void> {
    if (this.ownerGeneration === undefined) return;
    await runtime.mutate("releaseIngressOwner", {
      conversationKey: this.conversationKey,
      ownerEventId: this.eventId,
      ownerGeneration: this.ownerGeneration,
    });
  }

  /** Renews the current fenced owner before another model/tool boundary. */
  async renewConversationLease(): Promise<"renewed" | "stopped" | "stale"> {
    if (this.ownerGeneration === undefined) return "renewed";

    return runtime.mutate("renewIngressOwner", {
      conversationKey: this.conversationKey,
      ownerEventId: this.eventId,
      ownerGeneration: this.ownerGeneration,
      leaseTtlMs: DEFAULT_CONVERSATION_LEASE_TTL_MS,
    });
  }

  /**
   * Persists the given ingress events into the stored conversation.
   */
  async appendIngressEvents(
    events: ConversationIngressEvent[],
  ): Promise<SystemModelMessage[]> {
    const ephemeralSystem: SystemModelMessage[] = [];
    const persistedMessages: ModelMessage[] = [];

    for (const event of events) {
      if (event.role === "system") {
        const message = systemModelMessageSchema.parse(event);

        if (event.persist === false) {
          // Direct API system injections are one-turn instructions. They are
          // returned to the caller and included in the current turn's system
          // prompt, but never written to Convex.
          ephemeralSystem.push(message);
          continue;
        }

        persistedMessages.push(message);
        continue;
      }

      persistedMessages.push(event);
    }

    await this.persistModelMessages(persistedMessages);

    return ephemeralSystem;
  }

  /** Applies all queued steer envelopes to this active event. */
  async applySteeringIngress(): Promise<AppliedIngress | null> {
    if (this.ownerGeneration === undefined) return null;

    return applySteering({
      conversationKey: this.conversationKey,
      ownerEventId: this.eventId,
      ownerGeneration: this.ownerGeneration,
    });
  }

  /** Marks this event and every applied contributor terminal. */
  async settleIngress(
    status: "completed" | "failed",
    options: { result?: unknown; error?: string } = {},
  ): Promise<void> {
    if (this.ownerGeneration === undefined) return;
    await settleIngress({
      conversationKey: this.conversationKey,
      ownerEventId: this.eventId,
      ownerGeneration: this.ownerGeneration,
      status: status,
      ...options,
    });
  }

  /** Takes the next durable FIFO application after this event finishes. */
  async takeNextIngress(): Promise<AppliedIngress | null> {
    if (this.ownerGeneration === undefined) return null;

    return takeNextIngress({
      conversationKey: this.conversationKey,
      ownerEventId: this.eventId,
      ownerGeneration: this.ownerGeneration,
    });
  }

  async persistModelMessages(messages: ModelMessage[]): Promise<string[]> {
    const createdAtValues: string[] = [];
    const producer: MessageProducer = {
      model: modelIdentityFromModelConfig(this.agentConfig),
      retainsReasoning: retainsReasoningParts(this.agentConfig),
    };

    for (const message of messages) {
      const storedEvent = createStoredEventFromModelMessage(
        message,
        this.eventId,
        producer,
      );
      if (!storedEvent) {
        continue;
      }

      createdAtValues.push(await this.persistStoredEvent(storedEvent));
    }

    return createdAtValues;
  }

  async loadHarnessSession(): Promise<StoredHarnessSession | null> {
    return runtime.query("getHarnessSession", {
      conversationKey: this.conversationKey,
    });
  }

  async saveHarnessSession(state: StoredHarnessSession): Promise<void> {
    const serialized = JSON.stringify(state.resumeState);
    if (serialized === undefined) {
      throw new Error("Harness resume state must be JSON serializable");
    }
    await runtime.mutate("saveHarnessSession", {
      conversationKey: this.conversationKey,
      ...state,
    });
  }

  async createEphemeralTurnContext(
    messages: ModelMessage[],
    ephemeralSystem: SystemModelMessage[] = [],
  ): Promise<TurnContextSnapshot> {
    await this.ensureResolvedRuntime();

    // Ephemeral child turns are in-memory only, but they still need the same
    // source `ephemeralSystem` list so system prompt refreshes preserve it.
    return {
      messages: pruneSessionMessages(messages, this.agentConfig),
      system: await this.buildSystemPromptParts([], ephemeralSystem),
      ephemeralSystem: ephemeralSystem,
      systemContextSnapshot: { cursor: null, messages: [] },
    };
  }

  async createTurnContext(
    ephemeralSystem: SystemModelMessage[] = [],
  ): Promise<TurnContextSnapshot> {
    const prepareStartedMs = Date.now();
    // Runtime resolution and history load hit Convex independently, so overlap
    // them — the first token should not wait on two sequential round-trips.
    const [, entries] = await Promise.all([
      this.ensureResolvedRuntime(),
      this.loadConversationEntries(),
    ]);
    const activeEntries = projectActiveConversationEntries(entries);
    // Snapshot persisted system context separately from chat messages. The
    // harness passes this through prepareStep so long-running tool loops can
    // refresh system prompt parts without duplicating old system rows.
    const systemContextSnapshot = createSystemContextSnapshot(entries);
    let messages = projectEntriesToMessages(
      activeEntries,
      modelIdentityFromModelConfig(this.agentConfig),
    );
    const system = await this.buildSystemPromptParts(
      systemContextSnapshot.messages,
      ephemeralSystem,
    );

    const compactionStartedMs = Date.now();
    const compactionSummary = await compactSessionContext({
      conversationKey: this.conversationKey,
      system: system,
      // Compaction feeds these to a model, so envelope fields must not leak.
      messages: stripEnvelopeFieldsFromMessages(messages),
      agentConfig: this.agentConfig,
    }).catch((error) => {
      logError(
        "Session context compaction failed; continuing without compaction",
        {
          conversationKey: this.conversationKey,
          eventId: this.eventId,
          error: error instanceof Error ? error.message : String(error),
        },
      );

      return null;
    });
    const compactionEndedMs = Date.now();

    if (compactionSummary) {
      const [summaryCursor] = await this.persistModelMessages([
        compactionSummary,
      ]);
      const compactedSystemContextSnapshot = {
        cursor: summaryCursor ?? systemContextSnapshot.cursor,
        messages: [compactionSummary],
      };
      // Approval responses need their matching assistant request in model history.
      // Keep that pending pair outside the compacted summary so the AI SDK can resume it.
      messages = selectPostCompactionPendingMessages(messages);

      return {
        messages: pruneSessionMessages(messages, this.agentConfig),
        system: await this.buildSystemPromptParts(
          compactedSystemContextSnapshot.messages,
          ephemeralSystem,
        ),
        ephemeralSystem: ephemeralSystem,
        systemContextSnapshot: compactedSystemContextSnapshot,
        timings: {
          prepareStartedMs: prepareStartedMs,
          prepareEndedMs: Date.now(),
          compaction: {
            startedMs: compactionStartedMs,
            endedMs: compactionEndedMs,
          },
        },
      };
    }

    const prunedMessageCount = messages.length;
    messages = pruneSessionMessages(messages, this.agentConfig);
    logDebug("Session context pruned", {
      conversationKey: this.conversationKey,
      eventId: this.eventId,
      beforeCount: prunedMessageCount,
      afterCount: messages.length,
    });

    return {
      messages: messages,
      system: system,
      ephemeralSystem: ephemeralSystem,
      systemContextSnapshot: systemContextSnapshot,
      timings: {
        prepareStartedMs: prepareStartedMs,
        prepareEndedMs: Date.now(),
      },
    };
  }

  /**
   * Called from harness.ts prepareStep. Keep `systemContextSnapshot` updated across
   * model steps so newly persisted system rows become visible while prior
   * system rows remain included exactly once.
   */
  async loadRefreshedSystemPromptParts(options: {
    systemContextSnapshot: SystemContextSnapshot;
    ephemeralSystem?: SystemModelMessage[];
  }): Promise<{
    systemContextSnapshot: SystemContextSnapshot;
    system: SystemModelMessage[];
  }> {
    // Incremental refresh for prepareStep: load only conversation rows newer
    // than the cursor, then fold any system-role rows into the snapshot.
    const entries = await this.loadConversationEntries({
      afterCreatedAt: options.systemContextSnapshot.cursor,
    });

    const systemContextSnapshot: SystemContextSnapshot =
      entries.length === 0
        ? options.systemContextSnapshot
        : {
            cursor:
              entries.at(-1)?.createdAt ?? options.systemContextSnapshot.cursor,
            messages: [
              ...options.systemContextSnapshot.messages,
              ...projectSystemContextMessages(entries),
            ],
          };

    return {
      systemContextSnapshot: systemContextSnapshot,
      system: await this.buildSystemPromptParts(
        systemContextSnapshot.messages,
        options.ephemeralSystem ?? [],
      ),
    };
  }

  async loadHarnessSkills(): Promise<HarnessAgentSkill[]> {
    return loadConfiguredHarnessSkills(this.accountId, this.agentConfig);
  }

  async loadSkillPrompt(
    allowedSkillPaths: string[],
    skillPath: string,
    resourcePaths?: string[],
  ): Promise<{
    path: string;
    loadedPaths: string[];
    stagedPath?: string;
    stagedFiles: string[];
    bytes: number;
  }> {
    const loaded = await loadConfiguredSkillPrompt(
      allowedSkillPaths,
      skillPath,
      resourcePaths,
      this.defaultWorkspaceHasSandbox()
        ? this.filesystemNamespace()
        : undefined,
    );
    this.loadedSkillPrompts.push(loaded.prompt);

    return loaded;
  }

  /**
   * The agent's own sandbox (`config.sandbox`). Backs bash when no workspace is
   * attached, is the fallback sandbox for workspaces that declare none, and stays
   * separately reachable when every workspace borrows a different one. Undefined
   * when the agent references no sandbox.
   */
  agentSandbox(): SandboxExecutorConfig | undefined {
    return this.resolvedRuntime?.sandbox;
  }

  agentSandboxPermissionMode(): SandboxPermissionMode {
    return this.resolvedRuntime?.sandbox?.permissionMode ?? "ask";
  }

  // Namespace of the default (first) workspace, used for memory/skill staging
  // S3 reads. Empty string when no workspace is attached.
  filesystemNamespace(): string {
    return this.resolvedWorkspaces()[0]?.namespace ?? "";
  }

  /** Resolved workspaces for this turn (first is the default). Empty when none. */
  resolvedWorkspaces(): ResolvedWorkspace[] {
    return this.resolvedRuntime?.workspaces ?? [];
  }

  private async buildSystemPromptParts(
    promptMessages: SystemModelMessage[],
    ephemeralSystem: SystemModelMessage[] = [],
  ): Promise<SystemModelMessage[]> {
    const [memoryFiles, skillMetadata, subagentMetadata] = await Promise.all([
      this.loadMemoryFiles(),
      this.loadSkillMetadata(),
      this.loadSubagentMetadata(),
    ]);
    const memorySystem: SystemModelMessage[] =
      memoryFiles.length === 0
        ? []
        : [
            {
              role: "system",
              content: formatMemorySystemPrompt(memoryFiles),
            },
          ];
    const memoryToolEnabled = this.isMemoryToolEnabled();
    const workspaceHarnessSystem: SystemModelMessage[] =
      this.enableDefaultHarness()
        ? [
            {
              role: "system",
              content: formatWorkspaceHarnessSystemPrompt(
                this.resolvedWorkspaces(),
                memoryToolEnabled,
              ),
            },
          ]
        : [];
    const memoryHarnessSystem: SystemModelMessage[] = memoryToolEnabled
      ? [
          {
            role: "system",
            content: formatMemoryHarnessSystemPrompt(
              channelScopeKeyFromConversation(this.conversationKey),
            ),
          },
        ]
      : [];
    // Scheduling is the one surface that needs a clock: without one the model
    // guesses the date behind an at(...) expression.
    const schedulerSystem: SystemModelMessage[] =
      this.agentConfig.scheduler?.enabled === true
        ? [
            {
              role: "system",
              content: formatSchedulerSystemPrompt(this.startedAt),
            },
          ]
        : [];
    const skillsSystem: SystemModelMessage[] =
      skillMetadata.length > 0
        ? [
            {
              role: "system",
              content: formatSkillsSystemPrompt(skillMetadata),
            },
          ]
        : [];
    const subagentSystem: SystemModelMessage[] =
      this.agentConfig.subagent?.enabled === true
        ? [
            {
              role: "system",
              content: formatSubagentSystemPrompt(subagentMetadata),
            },
          ]
        : [];

    return [
      ...agentSystemMessages(this.agentConfig.agent?.system),
      ...memorySystem,
      ...workspaceHarnessSystem,
      ...memoryHarnessSystem,
      ...schedulerSystem,
      ...skillsSystem,
      ...subagentSystem,
      ...this.loadedSkillPrompts,
      ...promptMessages,
      ...ephemeralSystem,
    ];
  }

  private channelPartition(): ChannelPartition | undefined {
    return this.delivery?.kind === "channel"
      ? channelPartitionFromConfig(this.agentConfig, this.delivery.channelName)
      : undefined;
  }

  private defaultWorkspaceHasSandbox(): boolean {
    return Boolean(this.resolvedWorkspaces()[0]?.sandbox);
  }

  // The <workspace> prompt is the default harness's own guidance. An AI SDK
  // harness brings its own, and takes over the tools this prompt describes.
  private enableDefaultHarness(): boolean {
    if (this.agentConfig.harness !== undefined) {
      return false;
    }

    return (this.resolvedRuntime?.workspaces ?? []).some((workspace) =>
      workspaceGuidanceEnabled(workspace.config),
    );
  }

  /**
   * Lazily fetches and caches the resolved runtime (sandbox + workspaces hydrated
   * from their storage IDs). Promise-memoized so concurrent callers share one fetch.
   */
  private async ensureResolvedRuntime(): Promise<ResolvedAgentRuntime> {
    const channelScopeKey = channelScopeKeyFromConversation(
      this.conversationKey,
    );
    const conversationScopeKey = channelScopeKeyFromConversation(
      this.conversationKey,
      "conversation",
    );
    this.resolvedRuntimePromise ??= resolveAgentRuntime(
      this.agentConfig,
      { accountId: this.accountId, agentId: this.agentId },
      {
        channelName:
          this.delivery?.kind === "channel"
            ? this.delivery.channelName
            : undefined,
        channelScopeKey: channelScopeKey,
        conversationKey: conversationScopeKey,
        partition: this.channelPartition(),
      },
    ).then((resolved) => {
      this.resolvedRuntime = resolved;

      return resolved;
    });

    return this.resolvedRuntimePromise;
  }

  // Mirrors the registry condition in tools/index.ts: memory_save exists when a
  // sandbox-backed workspace has the memory harness enabled (default: on).
  private isMemoryToolEnabled(): boolean {
    return this.resolvedWorkspaces().some(
      (workspace) =>
        workspace.sandbox && workspaceMemoryHarnessEnabled(workspace.config),
    );
  }

  private isWorkspaceEnabled(): boolean {
    return (this.resolvedRuntime?.workspaces.length ?? 0) > 0;
  }

  private async loadConversationEntries(
    options: {
      afterCreatedAt?: string | null;
    } = {},
  ): Promise<StoredConversationEntry[]> {
    const entries: StoredConversationEntry[] = [];
    let afterCursor = options.afterCreatedAt ?? undefined;
    for (;;) {
      const result = await runtime.query<StoredConversationEventPage>(
        "listConversationEvents",
        {
          conversationKey: this.conversationKey,
          afterCursor: afterCursor,
        },
      );
      entries.push(
        ...result.page.map((row) => ({
          createdAt: row.cursor,
          event: row.event,
        })),
      );
      if (result.isDone) {
        return entries;
      }
      if (!result.continueCursor || result.continueCursor === afterCursor) {
        throw new Error("Conversation event pagination did not advance");
      }
      afterCursor = result.continueCursor;
    }
  }

  private async loadMemoryFile(
    workspace: ResolvedWorkspace,
  ): Promise<string | null> {
    // Reads the memory/MEMORY.md index via the S3 API (not the sandbox mount). If the
    // agent edited it through the mount less than ~1-2 min ago, S3 Files may not have
    // synced it yet, so this can be briefly stale. Accepted: memory converges across
    // turns and a per-turn sandbox round-trip is costly. Reading via S3 also lets a
    // workspace serve memory without any sandbox attached. See docs/workspace/storage.md.

    const target = await resolveS3ReadTarget(
      workspaceReadContext(workspace.config.storage, workspace.namespace),
    );
    const key = `${target.prefix}${MEMORY_INDEX_PATH}`;

    try {
      return target.access
        ? await readS3Text(target.bucket, key, target.access)
        : await readS3Text(target.bucket, key);
    } catch (error) {
      if (!isMissingS3Error(error)) {
        logError("Failed to load the memory index for session prompt", {
          conversationKey: this.conversationKey,
          workspace: workspace.name,
          key: key,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    if (!this.hasLoggedMissingMemoryFile) {
      logDebug("No memory index found for session prompt", {
        conversationKey: this.conversationKey,
        workspace: workspace.name,
        key: key,
      });
      this.hasLoggedMissingMemoryFile = true;
    }

    return null;
  }

  private async loadMemoryFiles(): Promise<
    Array<{ workspace: ResolvedWorkspace; content: string }>
  > {
    if (!this.isWorkspaceEnabled()) {
      return [];
    }

    const memoryFiles: Array<{
      workspace: ResolvedWorkspace;
      content: string;
    }> = [];
    for (const workspace of this.resolvedWorkspaces()) {
      // harness.memory.enabled: false is a full opt-out — the index is not
      // loaded into the model context either.
      if (!workspaceMemoryHarnessEnabled(workspace.config)) {
        continue;
      }
      const content = await this.loadMemoryFile(workspace);
      if (content != null) {
        memoryFiles.push({ workspace: workspace, content: content });
      }
    }

    return memoryFiles;
  }

  private async loadSkillMetadata(): Promise<SkillMetadata[]> {
    return listConfiguredSkillMetadata(this.accountId, this.agentConfig);
  }

  private async loadSubagentMetadata(): Promise<SubagentMetadata[]> {
    if (this.agentConfig.subagent?.enabled !== true || !this.accountId) {
      return [];
    }
    if (!this.subagentMetadataPromise) {
      this.subagentMetadataPromise = Promise.all(
        (this.agentConfig.subagent.allowed ?? []).map(async (agentId) => {
          const agent = await getStorage().agents.getById(
            this.accountId!,
            agentId,
          );
          if (!agent || agent.status !== "active") {
            return null;
          }

          return {
            agentId: agent.agentId,
            name: agent.name,
            ...(agent.description ? { description: agent.description } : {}),
          };
        }),
      ).then((metadata) =>
        metadata.filter((entry): entry is SubagentMetadata => entry !== null),
      );
    }

    return this.subagentMetadataPromise;
  }

  private nextCreatedAt(): string {
    const sequence = String(this.messageSequence).padStart(4, "0");
    this.messageSequence += 1;

    return `${new Date().toISOString()}#${this.eventId}#${sequence}`;
  }

  private async persistStoredEvent(
    event: StoredConversationEvent,
  ): Promise<string> {
    const createdAt = this.nextCreatedAt();
    if (this.ownerGeneration !== undefined) {
      await runtime.mutate("appendFencedConversationEvent", {
        conversationKey: this.conversationKey,
        ownerEventId: this.eventId,
        ownerGeneration: this.ownerGeneration,
        cursor: createdAt,
        event: event,
      });
    } else {
      await runtime.mutate("appendConversationEvent", {
        conversationKey: this.conversationKey,
        cursor: createdAt,
        event: event,
      });
    }

    return createdAt;
  }
}

/**
 * A channel message's events after attachment ingestion, split by durability.
 * `events` carries only sealed links and text — safe for admission to queue or
 * persist. `turnEvents` adds the byte-backed parts an agent with no workspace
 * gets for the current turn; those must never reach a stored record.
 */
export interface IngestedChannelEvents {
  events: ConversationIngressEvent[];
  turnEvents: ConversationIngressEvent[];
}

/**
 * Stores the media a channel delivered and folds it into the newest user event.
 *
 * Standalone rather than a Session method because the channel path must run it
 * before admission: a turn that arrives while another owns the conversation is
 * queued as its events alone, and the drain loop replays exactly what was
 * queued — parts added after admission would never reach a queued turn. It runs
 * here rather than in the adapter because the workspace the bytes land in is
 * only known once the runtime resolves, and because parsing happens before the
 * webhook is acknowledged — downloading there would hold the provider's
 * connection open for the length of a video. The events come back unchanged
 * when there is nothing attached, so every caller can route through it.
 */
export async function ingestChannelAttachments(
  events: ConversationIngressEvent[],
  attachments: Attachment[] | undefined,
  context: {
    accountId: string | undefined;
    agentConfig: AgentConfig;
    channelName: string;
    conversationKey: string;
    eventId: string;
  },
): Promise<IngestedChannelEvents> {
  if (!attachments?.length) {
    return { events: events, turnEvents: events };
  }
  const runtimeConfig = await resolveAgentRuntime(
    context.agentConfig,
    context.accountId,
    {
      channelName: context.channelName,
      channelScopeKey: channelScopeKeyFromConversation(context.conversationKey),
      conversationKey: channelScopeKeyFromConversation(
        context.conversationKey,
        "conversation",
      ),
      partition: channelPartitionFromConfig(
        context.agentConfig,
        context.channelName,
      ),
    },
  );
  const parts = await ingestInboundAttachments(attachments, {
    accountId: context.accountId,
    channelName: context.channelName,
    eventId: context.eventId,
    provider: context.agentConfig.model?.provider,
    // The first workspace is the agent's default, the same one the file tools
    // write to when the model names none.
    workspace: runtimeConfig.workspaces[0],
  });
  const durable =
    parts.durable.length > 0
      ? appendToLatestUserEvent(events, parts.durable)
      : events;

  return {
    events: durable,
    turnEvents:
      parts.transient.length > 0
        ? appendToLatestUserEvent(durable, parts.transient)
        : durable,
  };
}

// Message persistence sanitization. Exported so tests can verify the
// metadata-envelope split without going through Convex.
export function createStoredEventFromModelMessage(
  message: ModelMessage | undefined,
  sourceEventId: string,
  producer: MessageProducer = {},
): StoredConversationEvent | null {
  if (!message) {
    return null;
  }

  switch (message.role) {
    case "user": {
      // Opaque hook metadata rides the stored envelope; the persisted model
      // message stays a clean AI SDK shape.
      const { metadata, ...userMessage } = message as UserModelMessage & {
        metadata?: unknown;
      };

      return toStoredConversationEvent(
        sanitizeUserMessage(userMessage),
        sourceEventId,
        metadata,
      );
    }
    case "assistant":
      return toStoredConversationEvent(
        sanitizeAssistantMessage(message, producer.retainsReasoning === true),
        sourceEventId,
        undefined,
        producer.model,
      );
    case "tool":
      return toStoredConversationEvent(
        sanitizeToolMessage(message),
        sourceEventId,
      );
    case "system":
      return toStoredConversationEvent(
        systemModelMessageSchema.parse(message),
        sourceEventId,
      );
    default:
      return null;
  }
}

// Compaction resume support.
export function selectPostCompactionPendingMessages(
  messages: ModelMessage[],
): ModelMessage[] {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role === "user") {
    return [lastMessage];
  }

  if (!isToolApprovalResponseMessage(lastMessage)) {
    return [];
  }

  const approvalIds = new Set(
    lastMessage.content
      .filter((part) => part.type === "tool-approval-response")
      .map((part) => part.approvalId),
  );
  // The approval response references only approvalId; the prior assistant message
  // carries the tool call details needed to execute or deny the tool on resume.
  const approvalRequestMessages = messages.filter(
    (message): message is AssistantModelMessage =>
      message.role === "assistant" &&
      typeof message.content !== "string" &&
      message.content.some(
        (part) =>
          part.type === "tool-approval-request" &&
          approvalIds.has(part.approvalId),
      ),
  );

  return approvalRequestMessages.length > 0
    ? [...approvalRequestMessages, lastMessage]
    : [lastMessage];
}

// Projection attaches metadata/createdAt for hook payloads; model calls must
// receive clean AI SDK message shapes, so they pass through this first.
export function stripEnvelopeFieldsFromMessages(
  messages: ModelMessage[],
): ModelMessage[] {
  return messages.map((message) => {
    if (!("metadata" in message) && !("createdAt" in message)) {
      return message;
    }
    const {
      metadata: _metadata,
      createdAt: _createdAt,
      ...rest
    } = message as ModelMessage & { metadata?: unknown; createdAt?: string };

    return rest as ModelMessage;
  });
}

/**
 * Puts the stored media on the message it arrived with — the newest user event.
 * Earlier events are the context a channel batched ahead of it, and attaching a
 * picture to one of those would date it to the wrong turn. A string content is
 * widened to parts, since that is the only shape that holds a picture.
 */
function appendToLatestUserEvent(
  events: ConversationIngressEvent[],
  parts: Exclude<UserContent, string>,
): ConversationIngressEvent[] {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.role !== "user") continue;
    // An empty text part is dropped rather than carried: a picture sent with no
    // caption is a message whose text field a channel still filled in with "",
    // and some providers reject a text part that says nothing.
    const existing = (
      typeof event.content === "string"
        ? [{ type: "text" as const, text: event.content }]
        : event.content
    ).filter((part) => part.type !== "text" || part.text.length > 0);
    const next = [...events];
    next[index] = { ...event, content: [...existing, ...parts] };

    return next;
  }

  return [...events, { role: "user", content: parts }];
}

function agentSystemMessages(
  system: string | SystemModelMessage | SystemModelMessage[] | undefined,
): SystemModelMessage[] {
  if (system === undefined) {
    return [];
  }
  if (typeof system === "string") {
    return [{ role: "system", content: system }];
  }

  return Array.isArray(system) ? system : [system];
}

function createSystemContextSnapshot(
  entries: StoredConversationEntry[],
): SystemContextSnapshot {
  const systemEntries = entriesSinceLatestCompactionSummary(entries);

  return {
    cursor:
      systemEntries.at(-1)?.createdAt ?? entries.at(-1)?.createdAt ?? null,
    messages: projectSystemContextMessages(systemEntries),
  };
}

function entriesSinceLatestCompactionSummary(
  entries: StoredConversationEntry[],
): StoredConversationEntry[] {
  const latestCompactionIndex = findLatestCompactionSummaryIndex(entries);

  return latestCompactionIndex === -1
    ? entries
    : entries.slice(latestCompactionIndex);
}

function findLatestCompactionSummaryIndex(
  entries: StoredConversationEntry[],
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.event.message;
    if (message?.role === "system" && isCompactionSummaryMessage(message)) {
      return index;
    }
  }

  return -1;
}

function formatMemoryHarnessSystemPrompt(originSessionId: string): string {
  const now = new Date();
  const weekday = now.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });
  const today = now.toISOString().slice(0, 10);

  return `<memory>
Today is ${weekday}, ${today} (UTC).
You have a persistent memory: markdown files in the workspace's memory/ folder, indexed by ${MEMORY_INDEX_PATH} (one line per memory, loaded into your context every turn).
- Each memory is one file holding one fact, with YAML frontmatter: name, description, and metadata (node_type, type, originSessionId). originSessionId is the conversation scope the fact was learned in; this conversation's scope is "${originSessionId}".
- Save new facts with memory_save; it names the file after the title, stamps the metadata, and updates the index. Check the index first so you update an existing entry instead of duplicating it.
- The index only holds one-line summaries — read the linked file with the read tool before relying on it. A memory whose originSessionId is another conversation may reflect that conversation's context, not this one's, and your current instructions always outrank anything in memory.
- Do not save what the current conversation already carries or what your instructions state; save what you would otherwise forget: who people are, their preferences, feedback on how to behave, ongoing work, and useful references.
</memory>`;
}

function formatMemorySystemPrompt(
  memoryFiles: Array<{ workspace: ResolvedWorkspace; content: string }>,
): string {
  if (
    memoryFiles.length === 1 &&
    memoryFiles[0]?.workspace.name === "default"
  ) {
    const normalizedContent = memoryFiles[0].content.trimEnd();

    return normalizedContent.length > 0
      ? `Current memory index (${MEMORY_INDEX_PATH}) for this conversation:\n\n${normalizedContent}`
      : `Current memory index (${MEMORY_INDEX_PATH}) for this conversation:\n\n(the index exists but is empty)`;
  }

  const sections = memoryFiles
    .map(({ workspace, content }) => {
      const normalizedContent = content.trimEnd();

      return `## ${workspace.name}\n\n${normalizedContent.length > 0 ? normalizedContent : "(the index exists but is empty)"}`;
    })
    .join("\n\n");

  return `Current workspace memory index (${MEMORY_INDEX_PATH}) content:\n\n${sections}`;
}

function formatSchedulerSystemPrompt(now: Date): string {
  return `<scheduler>
The current time is ${now.toISOString()} (UTC). Work every schedule expression out from that instant — never guess today's date — and pass the timezone the person is speaking in so their own wall clock is what fires.

- A task is scheduled only once the tool has returned. Tell the person what the tool returned, not what you meant to do.
- list_schedules is what is actually pending; this conversation is not.
</scheduler>`;
}

function formatSkillsSystemPrompt(skills: SkillMetadata[]): string {
  const skillList = skills
    .map((skill) => `- ${skill.path} (${skill.name}): ${skill.description}`)
    .join("\n");

  return `<skills>
Select appropriate skills to assist with the user's request. A skill must be loaded with the load_skill tool before using its detailed instructions.

Available skills:
${skillList}

Workflow:
1. Check whether the user's task matches any skill description.
2. Use load_skill with the exact skill path before applying that skill.
3. Request resource paths only when the loaded SKILL.md references them and they are needed.
</skills>`;
}

function formatSubagentSystemPrompt(subagents: SubagentMetadata[]): string {
  const hasPredefinedSubagents = subagents.length > 0;
  const predefined = hasPredefinedSubagents
    ? subagents
        .map((agent) => {
          const description =
            agent.description?.trim() || "No description provided.";

          return `- ${agent.agentId} (${agent.name}): ${description}`;
        })
        .join("\n")
    : "- No predefined subagents are configured. Omit agentId to run a virtual one-shot subagent.";

  return `<subagent>
Use run_subagent to dispatch independent work that can continue while you keep working. The tool returns task ids immediately; results are injected into this conversation when the child work finishes.

Available predefined subagents:
${predefined}

Tool guidance:
1. Use the exact agentId from the predefined list when a listed subagent is suitable for the task.
2. Omit agentId only when no predefined subagent is suitable or the user explicitly asks for a virtual one-shot subagent.
3. A virtual one-shot subagent uses this agent's model and tool configuration.
</subagent>`;
}

function formatWorkspaceHarnessSystemPrompt(
  workspaces: ResolvedWorkspace[],
  memoryToolEnabled = false,
): string {
  const hasWritable = workspaces.some((ws) => ws.sandbox != null);
  const hasReadOnly = workspaces.some((ws) => ws.sandbox == null);

  const workspaceList = workspaces
    .map((workspace, index) => {
      const readOnlyTag =
        workspace.sandbox == null ? " [read-only: read, glob]" : "";

      return `- ${workspace.name}${index === 0 ? " (default)" : ""}${readOnlyTag}: ${workspace.namespace}${workspace.description ? ` - ${workspace.description}` : ""}`;
    })
    .join("\n");

  const toolsLine =
    hasWritable && hasReadOnly
      ? "Use the file tools (read, glob) on all workspaces; write, edit, grep, and bash are available only on writable workspaces."
      : hasWritable
        ? "Use the file tools (read, write, edit, glob, grep) and bash to work with the mounted filesystem; bash starts in the current workspace directory."
        : "Use the file tools (read, glob) to read the mounted filesystem. These workspaces are read-only, attempt to modify will get error.";

  const memoryIndexEnabled = workspaces.some((workspace) =>
    workspaceMemoryHarnessEnabled(workspace.config),
  );
  const memoryGuidance = memoryToolEnabled
    ? `3. Durable memory is managed through the memory_save tool and the ${MEMORY_INDEX_PATH} index — see <memory>.`
    : memoryIndexEnabled
      ? `3. Keep durable project facts, decisions, conventions, and context that should survive long-running work as markdown files under memory/, indexed in ${MEMORY_INDEX_PATH}.`
      : "3. Structured memory is disabled for this agent — do not create memory files unless explicitly asked.";
  const guidance = hasWritable
    ? `1. Use read/write/edit to inspect and change files, glob/grep to find files and content, and bash to run commands and programs (python3, node, and the usual tools are on PATH).
2. When more than one workspace is configured, pass the workspace field to select one; omitted means the default workspace.
${memoryGuidance}
4. Use TASKS.md or focused task markdown files for plans and progress tracking when that helps the work stay aligned.
5. Treat memory and task files as normal workspace files: read them before relying on them, update them when useful, and keep them concise.`
    : `1. Use read to inspect files and glob to find files by pattern.
2. When more than one workspace is configured, pass the workspace field to select one; omitted means the default workspace.`;

  return `<workspace>
A persistent workspace is attached. ${toolsLine}

Configured workspaces:
${workspaceList}

Guidance:
${guidance}
</workspace>`;
}

/**
 * Checks if assistant content part should be persisted.
 * Reasoning rides along because OpenAI's Responses API replays a stored
 * assistant message by item id and rejects the reference when the reasoning
 * item that produced it is missing. See `retainsReasoningParts` in pruning.ts.
 */
function isPersistedAssistantContentPart(
  part: Exclude<AssistantModelMessage["content"], string>[number],
): boolean {
  return (
    part.type === "reasoning" ||
    part.type === "text" ||
    part.type === "tool-call" ||
    part.type === "tool-approval-request" ||
    part.type === "tool-result"
  );
}

/**
 * Checks if tool content part should be persisted.
 */
function isPersistedToolContentPart(
  part: ToolModelMessage["content"][number],
): boolean {
  return part.type === "tool-approval-response" || part.type === "tool-result";
}

function isToolApprovalResponseMessage(
  message: ModelMessage | undefined,
): message is ToolModelMessage {
  return (
    message?.role === "tool" &&
    message.content.length > 0 &&
    message.content.every((part) => part.type === "tool-approval-response")
  );
}

// The partition one channel's config carries, shared by the Session and the
// pre-admission attachment path so both resolve the same runtime scope.
function channelPartitionFromConfig(
  agentConfig: AgentConfig,
  channelName: string,
): ChannelPartition | undefined {
  const config = agentConfig.channels?.[channelName];
  const partition = isPlainObject(config) ? config.partition : undefined;

  return isPartition(partition) ? partition : undefined;
}

function isPartition(value: unknown): value is ChannelPartition {
  if (!isPlainObject(value)) return false;
  if (value.by === "shared") return value.alias === undefined;

  return value.by === "conversation" && typeof value.alias === "string";
}

function projectActiveConversationEntries(
  entries: StoredConversationEntry[],
): StoredConversationEntry[] {
  const latestCompactionIndex = findLatestCompactionSummaryIndex(entries);

  return latestCompactionIndex === -1
    ? entries
    : entries.slice(latestCompactionIndex + 1);
}

// Conversation projection. User messages carry envelope metadata/createdAt for
// hook payloads; stripEnvelopeFieldsFromMessages removes both for model calls.
function projectEntriesToMessages(
  entries: StoredConversationEntry[],
  model: string | undefined,
): ModelMessage[] {
  return entries.flatMap(({ createdAt, event }): ModelMessage[] => {
    switch (event.message.role) {
      case "system":
        return [];
      case "user": {
        const projected: UserModelMessage & {
          metadata?: unknown;
          createdAt: string;
        } = {
          ...event.message,
          ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
          createdAt: createdAt,
        };

        return [projected];
      }
      case "assistant":
        return [
          event.model === model
            ? event.message
            : withoutStoredItems(event.message),
        ];
      case "tool":
        return [event.message];
    }
  });
}

function projectSystemContextMessages(
  entries: StoredConversationEntry[],
): SystemModelMessage[] {
  const latestCompactionIndex = findLatestCompactionSummaryIndex(entries);

  return entries.flatMap(({ event }, index) => {
    if (event.message.role !== "system") {
      return [];
    }

    if (isCompactionSummaryMessage(event.message)) {
      return index === latestCompactionIndex ? [event.message] : [];
    }

    return latestCompactionIndex === -1 || index > latestCompactionIndex
      ? [event.message]
      : [];
  });
}

/**
 * Filters assistant message to only persisted content parts.
 */
function sanitizeAssistantMessage(
  message: AssistantModelMessage,
  retainsReasoning: boolean,
): AssistantModelMessage | null {
  if (typeof message.content === "string") {
    return message;
  }

  const content = message.content.filter(
    (part) =>
      isPersistedAssistantContentPart(part) &&
      (retainsReasoning || part.type !== "reasoning"),
  );

  return content.length > 0 ? { ...message, content: content } : null;
}

/**
 * Filters tool message to only persisted content parts.
 */
function sanitizeToolMessage(
  message: ToolModelMessage,
): ToolModelMessage | null {
  const content = message.content.filter(isPersistedToolContentPart);

  return content.length > 0 ? { ...message, content: content } : null;
}

/**
 * Filters a user message to what a stored row can hold.
 *
 * Text and media named by URL keep their part: a sealed media link is a short
 * string that still resolves on every later turn, which is the whole reason
 * inbound attachments are stored and linked rather than inlined. Media carrying
 * its own bytes is dropped — a base64 picture is megabytes of row per turn, and
 * the model already saw it in the turn it arrived.
 *
 * A message left with nothing keeps a note rather than becoming null: dropping
 * the row entirely would leave the assistant's reply in history answering a user
 * turn that is not there.
 */
function sanitizeUserMessage(
  message: UserModelMessage,
): UserModelMessage | null {
  if (typeof message.content === "string") {
    return message;
  }

  const content = message.content.filter(
    (part) =>
      part.type === "text" ||
      (part.type === "image" && isStorableMediaReference(part.image)) ||
      (part.type === "file" && isStorableMediaReference(part.data)),
  );
  if (content.length > 0) {
    return { ...message, content: content };
  }

  return message.content.length > 0
    ? {
        ...message,
        content: [{ type: "text", text: "[attachment not retained]" }],
      }
    : null;
}

// Whether a media part points at its bytes instead of carrying them. A URL
// object or an `http(s)` string is a reference; a base64 string, a Buffer or a
// typed array is the payload itself. A `data:` URL is a payload wearing a URL's
// clothes, so it is excluded by the scheme check rather than by the type.
// A file part may also tag its data (`{ type: "url", url }`), which the direct
// API accepts, so that shape unwraps to the same check.
function isStorableMediaReference(
  value: ImagePart["image"] | FilePart["data"],
): boolean {
  if (value instanceof URL) {
    return value.protocol === "http:" || value.protocol === "https:";
  }
  if (typeof value === "object" && "type" in value && value.type === "url") {
    return isStorableMediaReference(value.url);
  }

  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function toStoredConversationEvent<
  TMessage extends StoredConversationEvent["message"],
>(
  message: TMessage | null,
  sourceEventId: string,
  metadata?: unknown,
  model?: string,
): StoredConversationEventBase<TMessage> | null {
  return message
    ? {
        version: 1,
        sourceEventId: sourceEventId,
        ...(metadata !== undefined ? { metadata: metadata } : {}),
        ...(model !== undefined ? { model: model } : {}),
        message: message,
      }
    : null;
}

/**
 * Drops what only the producing model can replay: its reasoning, and the ids
 * the provider would otherwise resolve that reasoning through. Applied to every
 * assistant message the current model did not write — another model cannot
 * decrypt that reasoning, and a row stored before we recorded a producer has no
 * reasoning to pair its ids with in the first place. The message still replays,
 * as plain content.
 */
function withoutStoredItems(
  message: AssistantModelMessage,
): AssistantModelMessage {
  if (typeof message.content === "string") {
    return message;
  }

  return {
    ...message,
    content: message.content
      .filter((part) => part.type !== "reasoning")
      .map(withoutStoredItemId),
  };
}
