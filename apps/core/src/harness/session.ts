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
  type ToolResultPart,
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
  type ResolvedAgentSandbox,
  type ResolvedWorkspace,
} from "../shared/workspaces.ts";
import type { AsyncToolDelivery } from "./async-tool-result.ts";
import {
  ingestInboundAttachments,
  MEDIA_REFERENCE_SCHEME,
  rehydrateStoredMedia,
} from "./channel-media.ts";
import {
  compactSessionContext,
  isCompactionSummaryMessage,
  summarizeConversation,
} from "./compaction.ts";
import {
  applySteering,
  DEFAULT_CONVERSATION_LEASE_TTL_MS,
  releaseIngressOwner,
  settleIngress,
  takeNextIngress,
  type AppliedIngress,
  type IngressSettlement,
} from "./ingress.ts";
import {
  modelIdentityFromModelConfig,
  withoutStoredItemId,
} from "./provider.ts";
import {
  hasPendingToolApprovalResponse,
  pruneSessionMessages,
  retainsReasoningParts,
} from "./pruning.ts";
import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "./sandbox/s3-mount.ts";
import { truncateText } from "./sandbox/utils.ts";
import {
  listConfiguredSkillMetadata,
  loadConfiguredHarnessSkills,
  loadConfiguredSkillPrompt,
  type SkillMetadata,
} from "./skills.ts";
import { bashTargetLines } from "./tools/filesystem-utils.ts";
import { MEMORY_INDEX_PATH } from "./tools/memory.tool.ts";

// Convex caps one mutation's arguments at 16 MiB. Half of that leaves room for
// the fence fields and for the encoding the client adds around each event.
const APPEND_EVENT_BYTES = 8 * 1_024 * 1_024;
// Convex also caps one mutation at 16,000 written documents, which many small
// events reach long before the byte cap does.
const APPEND_EVENT_COUNT = 8_000;
const ATTACHMENT_NOT_RETAINED = "[attachment not retained]";
// Convex refuses a document over 1 MiB. One tool message shares this budget
// across its results, which leaves room for the rest of the row.
const STORED_TOOL_MESSAGE_BYTES = 768 * 1024;

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
  // createTurnContext up to where compaction starts, or to the end when no
  // summary is written: load, project, system prompt, prune.
  prepareStartedMs: number;
  prepareEndedMs: number;
  phases: ContextPreparePhases;
  // Present only when compaction actually produced a summary this turn. Starts
  // where prepare ends and covers the summary call, its write and the rebuild.
  compaction?: { startedMs: number; endedMs: number };
}

// Each prepare load's own wall time. The loads overlap, so these do not add up
// to the prepare span.
export interface ContextPreparePhases {
  historyMs: number;
  historyRows: number;
  mediaMs: number;
  memoryMs: number;
  runtimeMs: number;
  skillsMs: number;
  subagentsMs: number;
}

interface MemoryFile {
  content: string;
  workspace: ResolvedWorkspace;
}

interface TurnHistory {
  entries: StoredConversationEntry[];
  messages: ModelMessage[];
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

// Internal normalized shapes persisted in Convex: AI SDK roles here too, so an
// event is a stored model message plus metadata.
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

export interface StoredConversationEventPage {
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
  // A subagent replies to its parent, not to the channel, so it has no
  // `delivery`. Its policy input still has to name the parent's place and person.
  policyDelivery?: AsyncToolDelivery;
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
  // false keeps an ephemeral subagent's messages out of Convex.
  persist?: boolean;
}

/**
 * A channel message's events after attachment ingestion, split by durability.
 * `events` carries only sealed links and text, safe for admission to queue or
 * persist. `turnEvents` adds the byte-backed parts an agent with no workspace
 * gets for the current turn; those must never reach a stored record.
 */
export interface IngestedChannelEvents {
  events: ConversationIngressEvent[];
  turnEvents: ConversationIngressEvent[];
}

export class Session {
  readonly eventId: string;
  readonly conversationKey: string;
  readonly accountId: string | undefined;
  readonly agentId: string | undefined;
  readonly delivery: AsyncToolDelivery | undefined;
  readonly policyDelivery: AsyncToolDelivery | undefined;
  readonly endpointId: string | undefined;
  readonly projectSlug: string | undefined;
  readonly stageSlug: string | undefined;
  readonly ownerGeneration: number | undefined;
  readonly channelActions: ChannelActions | undefined;
  readonly trigger: RunTrigger | undefined;
  private readonly agentConfig: AgentConfig;
  private readonly persist: boolean;
  private messageSequence = 0;
  private lastSystemCursor: string | null = null;
  private ownerHandedOff = false;
  private hasLoggedMissingMemoryFile = false;
  // One clock reading for the whole run: the system prompt is rebuilt before
  // every step, so a moving timestamp would break the provider's prompt cache.
  private readonly startedAt = new Date();
  private loadedSkillPrompts: SystemModelMessage[] = [];
  private subagentMetadataPromise: Promise<SubagentMetadata[]> | undefined;
  // Read once per run. prepareStep rebuilds the system prompt before every step
  // and would otherwise go back to S3 each time. No re-read after memory_save
  // either: it writes through the sandbox mount, which reaches S3 a minute or
  // two later, so the run would get the same index back.
  private memoryFilesPromise: Promise<MemoryFile[]> | undefined;
  private skillMetadataPromise: Promise<SkillMetadata[]> | undefined;
  // Resolved sandbox + workspace records (from the agent's `sandboxes`/`workspaces`
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
    this.policyDelivery = options.policyDelivery ?? options.delivery;
    this.endpointId = options.endpointId;
    this.projectSlug = options.projectSlug;
    this.stageSlug = options.stageSlug;
    this.ownerGeneration = options.ownerGeneration;
    this.channelActions = options.channelActions;
    this.trigger = options.trigger;
    this.persist = options.persist ?? true;
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
    if (this.ownerGeneration === undefined || this.ownerHandedOff) return;
    await releaseIngressOwner({
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

  /**
   * Transfers to the next durable FIFO application, or atomically releases
   * ownership. With `settle`, this event is settled in the same mutation; if
   * that mutation fails, the settle is written on its own before the error
   * reaches the caller, so the turn's outcome is never lost.
   */
  async takeNextIngress(
    settle?: IngressSettlement,
  ): Promise<AppliedIngress | null> {
    if (this.ownerGeneration === undefined) return null;
    const owner = {
      conversationKey: this.conversationKey,
      ownerEventId: this.eventId,
      ownerGeneration: this.ownerGeneration,
    };
    const next = await takeNextIngress(owner, settle).catch(
      async (err: unknown): Promise<never> => {
        if (settle) await settleIngress({ ...owner, ...settle }).catch(() => 0);
        throw err;
      },
    );
    this.ownerHandedOff = true;

    return next;
  }

  async persistModelMessages(messages: ModelMessage[]): Promise<string[]> {
    if (!this.persist) return [];
    const producer: MessageProducer = {
      model: modelIdentityFromModelConfig(this.agentConfig),
      retainsReasoning: retainsReasoningParts(this.agentConfig),
    };
    const events = messages.flatMap(
      (message): { cursor: string; event: StoredConversationEvent }[] => {
        const event = createStoredEventFromModelMessage(
          message,
          this.eventId,
          producer,
        );

        return event ? [{ cursor: this.nextCreatedAt(), event: event }] : [];
      },
    );
    if (events.length === 0) return [];

    // A step fits one mutation, but a harness run hands over its whole history
    // at once and that can pass what Convex accepts in a single call.
    let batch: typeof events = [];
    let batchBytes = 0;
    for (const entry of events) {
      const entryBytes = Buffer.byteLength(JSON.stringify(entry));
      if (
        batch.length > 0 &&
        (batchBytes + entryBytes > APPEND_EVENT_BYTES ||
          batch.length >= APPEND_EVENT_COUNT)
      ) {
        await this.appendConversationEvents(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(entry);
      batchBytes += entryBytes;
    }
    await this.appendConversationEvents(batch);
    const systemCursor = events.findLast(
      (entry): boolean => entry.event.message.role === "system",
    )?.cursor;
    if (
      systemCursor !== undefined &&
      (this.lastSystemCursor === null || systemCursor > this.lastSystemCursor)
    ) {
      this.lastSystemCursor = systemCursor;
    }

    return events.map((entry): string => entry.cursor);
  }

  async loadHarnessSession(): Promise<StoredHarnessSession | null> {
    return runtime.query("getHarnessSession", {
      conversationKey: this.conversationKey,
    });
  }

  async saveHarnessSession(state: StoredHarnessSession): Promise<void> {
    if (!this.persist) return;
    const serialized = JSON.stringify(state.resumeState);
    if (serialized === undefined) {
      throw new Error("Harness resume state must be JSON serializable");
    }
    await runtime.mutate("saveHarnessSession", {
      conversationKey: this.conversationKey,
      ...state,
    });
  }

  /**
   * Compacts the stored conversation now, regardless of the agent's compaction
   * config or context size. Serves the /compact channel command; the caller
   * holds the fenced clear lease, so no run or queued ingress can interleave
   * and the whole history folds into the summary. Returns how many messages
   * were summarized; 0 means there was nothing to compact.
   */
  async compactConversation(instructions: string): Promise<number> {
    const entries = await this.loadConversationEntries();
    const activeEntries = projectActiveConversationEntries(entries);
    const systemContextSnapshot = createSystemContextSnapshot(entries);
    // Stored media stays as its persisted reference parts: the summarizer only
    // needs the text around them, not the rehydrated bytes.
    const messages = projectEntriesToMessages(
      activeEntries,
      modelIdentityFromModelConfig(this.agentConfig),
    );
    if (hasPendingToolApprovalResponse(messages)) {
      return 0;
    }
    const summary = await summarizeConversation({
      conversationKey: this.conversationKey,
      priorSummaries: systemContextSnapshot.messages.filter(
        isCompactionSummaryMessage,
      ),
      messages: stripEnvelopeFieldsFromMessages(messages),
      agentConfig: this.agentConfig,
      instructions: instructions,
    });
    if (!summary) {
      return 0;
    }
    await this.persistModelMessages([summary]);

    return messages.length;
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
    const phases: ContextPreparePhases = {
      historyMs: 0,
      historyRows: 0,
      mediaMs: 0,
      memoryMs: 0,
      runtimeMs: 0,
      skillsMs: 0,
      subagentsMs: 0,
    };
    // Every load behind the turn starts at once; buildSystemPromptParts below
    // reads the memoized results.
    const [history] = await Promise.all([
      this.loadTurnHistory(phases),
      timePhase(phases, "runtimeMs", () => this.ensureResolvedRuntime()),
      timePhase(phases, "memoryMs", () => this.loadMemoryFiles()),
      timePhase(phases, "skillsMs", () => this.loadSkillMetadata()),
      timePhase(phases, "subagentsMs", () => this.loadSubagentMetadata()),
    ]);
    // Snapshot persisted system context separately from chat messages. The
    // harness passes this through prepareStep so long-running tool loops can
    // refresh system prompt parts without duplicating old system rows.
    const systemContextSnapshot = createSystemContextSnapshot(history.entries);
    let messages = history.messages;
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
          prepareEndedMs: compactionStartedMs,
          phases: phases,
          compaction: {
            startedMs: compactionStartedMs,
            endedMs: Date.now(),
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
        phases: phases,
      },
    };
  }

  /**
   * Called from harness.ts prepareStep. Keep `systemContextSnapshot` updated across
   * model steps so newly persisted system rows become visible while prior
   * system rows remain included exactly once. Reads Convex only when this
   * session wrote a system row the snapshot does not cover yet.
   */
  async loadRefreshedSystemPromptParts(options: {
    systemContextSnapshot: SystemContextSnapshot;
    ephemeralSystem?: SystemModelMessage[];
  }): Promise<{
    systemContextSnapshot: SystemContextSnapshot;
    system: SystemModelMessage[];
  }> {
    const snapshotCursor = options.systemContextSnapshot.cursor;
    const entries =
      this.lastSystemCursor === null ||
      (snapshotCursor !== null && this.lastSystemCursor <= snapshotCursor)
        ? []
        : await this.loadConversationEntries({
            afterCreatedAt: snapshotCursor,
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
   * Live state the agent would otherwise spend steps probing for. The harness
   * sends it after the history and never stores it, so the system prompt and
   * the history stay a cached prefix and only this block is new. Built from
   * what the run already holds: no extra storage read.
   */
  environmentText(): string {
    const workspaces = this.resolvedWorkspaces();
    const sandboxes = this.sandboxes();
    const canBash =
      sandboxes.length > 0 || workspaces.some((workspace) => workspace.sandbox);

    return formatEnvironmentPrompt({
      now: this.startedAt,
      channel: this.channelLabel(),
      bashTargets: canBash
        ? bashTargetLines({ workspaces: workspaces, sandboxes: sandboxes })
        : [],
    });
  }

  // Resolved config.sandboxes; the first is the default. Empty when none.
  sandboxes(): ResolvedAgentSandbox[] {
    return this.resolvedRuntime?.sandboxes ?? [];
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

  /** One append mutation, fenced against the owner generation when there is one. */
  private async appendConversationEvents(
    events: { cursor: string; event: StoredConversationEvent }[],
  ): Promise<void> {
    if (this.ownerGeneration !== undefined) {
      await runtime.mutate("appendFencedConversationEvent", {
        conversationKey: this.conversationKey,
        ownerEventId: this.eventId,
        ownerGeneration: this.ownerGeneration,
        events: events,
      });

      return;
    }
    await runtime.mutate("appendConversationEvent", {
      conversationKey: this.conversationKey,
      events: events,
    });
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
              content: formatSchedulerSystemPrompt(),
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

  private channelLabel(): string {
    if (this.trigger === "cron") return "none, this is a scheduled run";
    if (this.delivery?.kind === "channel") return this.delivery.channelName;

    return this.delivery?.kind === "nats" ? "live session" : "direct API";
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
    if (!this.persist) return [];
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
    // Reads memory/MEMORY.md over the S3 API, not the sandbox mount, so a workspace
    // with no sandbox still serves memory. A mount write reaches S3 only once
    // Mountpoint uploads it on close, so this can be briefly stale; memory
    // converges across turns. See docs/internals/storage.md.
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

  private async loadMemoryFiles(): Promise<MemoryFile[]> {
    // The runtime names the workspaces, so this waits on it and its phase time
    // includes that wait.
    await this.ensureResolvedRuntime();
    if (!this.isWorkspaceEnabled()) {
      return [];
    }

    // harness.memory.enabled: false is a full opt-out. The index is not loaded
    // into the model context either.
    this.memoryFilesPromise ??= Promise.all(
      this.resolvedWorkspaces()
        .filter((workspace) => workspaceMemoryHarnessEnabled(workspace.config))
        .map(async (workspace): Promise<MemoryFile | null> => {
          const content = await this.loadMemoryFile(workspace);

          return content == null
            ? null
            : { content: content, workspace: workspace };
        }),
    ).then((files) =>
      files.filter((file): file is MemoryFile => file !== null),
    );

    return this.memoryFilesPromise;
  }

  private async loadSkillMetadata(): Promise<SkillMetadata[]> {
    this.skillMetadataPromise ??= listConfiguredSkillMetadata(
      this.accountId,
      this.agentConfig,
    );

    return this.skillMetadataPromise;
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
          if (!agent) {
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

  // Media the rows only point at is read back here, before anything else looks
  // at the history: compaction, the system prompt and the model all see the
  // same messages, and none of them should have to know how it got there.
  private async loadTurnHistory(
    phases: ContextPreparePhases,
  ): Promise<TurnHistory> {
    const entries = await timePhase(phases, "historyMs", () =>
      this.loadConversationEntries(),
    );
    phases.historyRows = entries.length;
    const messages = await timePhase(phases, "mediaMs", () =>
      rehydrateStoredMedia(
        projectEntriesToMessages(
          projectActiveConversationEntries(entries),
          modelIdentityFromModelConfig(this.agentConfig),
        ),
        this.agentConfig,
      ),
    );

    return { entries: entries, messages: messages };
  }

  private nextCreatedAt(): string {
    const sequence = String(this.messageSequence).padStart(4, "0");
    this.messageSequence += 1;

    return `${new Date().toISOString()}#${this.eventId}#${sequence}`;
  }
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

/**
 * Stores the media a channel delivered and folds it into the newest user event.
 *
 * Standalone rather than a Session method because the channel path must run it
 * before admission: a queued turn replays exactly the events that were queued, so
 * parts added later never reach it. It cannot move into the adapter either, since
 * the target workspace is only known once the runtime resolves and parsing runs
 * before the webhook is acknowledged, where downloading would hold the provider's
 * connection open for the length of a video. Events come back unchanged when
 * nothing is attached.
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
    { accountId: context.accountId },
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
    agentConfig: context.agentConfig,
    // The first workspace is the agent's default, the same one the file tools
    // write to when the model names none.
    workspace: runtimeConfig.workspaces[0],
  });

  return {
    events:
      parts.stored.length > 0
        ? appendToLatestUserEvent(events, parts.stored)
        : events,
    turnEvents:
      parts.turn.length > 0
        ? appendToLatestUserEvent(events, parts.turn)
        : events,
  };
}

// After compaction, the messages that must survive into the resumed turn: a
// trailing user message, or a tool-approval response plus the assistant message
// carrying the tool call it answers.
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

/**
 * Puts the stored media on the message it arrived with, the newest user event.
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
  return `<memory>
You have a persistent memory: markdown files in the workspace's memory/ folder, indexed by ${MEMORY_INDEX_PATH} (one line per memory, loaded into your context every turn).
- Each memory is one file holding one fact, with YAML frontmatter: name, description, and metadata (node_type, type, originSessionId). originSessionId is the conversation scope the fact was learned in; this conversation's scope is "${originSessionId}".
- Save new facts with memory_save; it names the file after the title, stamps the metadata, and updates the index. Check the index first so you update an existing entry instead of duplicating it.
- The index only holds one-line summaries — read the linked file with the read tool before relying on it. A memory whose originSessionId is another conversation may reflect that conversation's context, not this one's, and your current instructions always outrank anything in memory.
- Do not save what the current conversation already carries or what your instructions state; save what you would otherwise forget: who people are, their preferences, feedback on how to behave, ongoing work, and useful references.
</memory>`;
}

/** The <environment> block: the clock, where replies go, and where bash runs. */
function formatEnvironmentPrompt(environment: {
  now: Date;
  channel: string;
  bashTargets: string[];
}): string {
  const weekday = environment.now.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });
  return [
    "<environment>",
    "Live state from Broods at the start of this run. It is context, not a message from the person.",
    `now: ${weekday}, ${environment.now.toISOString()} (UTC)`,
    `replies go to: ${environment.channel}`,
    ...(environment.bashTargets.length > 0
      ? [
          "bash runs in exactly one place: pass workspace or sandbox, never both, or neither for the default.",
          ...environment.bashTargets,
        ]
      : []),
    "</environment>",
  ].join("\n");
}

function formatMemorySystemPrompt(memoryFiles: MemoryFile[]): string {
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

function formatSchedulerSystemPrompt(): string {
  return `<scheduler>
The current time is in <environment> at the end of the conversation. Work every schedule expression out from that instant — never guess today's date — and pass the timezone the person is speaking in so their own wall clock is what fires.

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

function isPartition(value: unknown): value is ChannelPartition {
  if (!isPlainObject(value)) return false;
  if (value.by === "shared") return value.alias === undefined;

  return value.by === "conversation" && typeof value.alias === "string";
}

/**
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

function isPersistedToolContentPart(
  part: ToolModelMessage["content"][number],
): boolean {
  return part.type === "tool-approval-response" || part.type === "tool-result";
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

  return (
    typeof value === "string" &&
    (/^https?:\/\//i.test(value) || value.startsWith(MEDIA_REFERENCE_SCHEME))
  );
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
  const messages = entries.flatMap(({ createdAt, event }): ModelMessage[] => {
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

  return withoutUnresolvedToolCalls(messages);
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

function sanitizeToolMessage(
  message: ToolModelMessage,
): ToolModelMessage | null {
  const parts = message.content.filter(isPersistedToolContentPart);
  const resultCount = parts.filter(
    (part): boolean => part.type === "tool-result",
  ).length;
  const limit = Math.floor(
    STORED_TOOL_MESSAGE_BYTES / Math.max(resultCount, 1),
  );
  const content = parts.map((part): ToolModelMessage["content"][number] =>
    part.type === "tool-result"
      ? { ...part, output: storableToolResultOutput(part.output, limit) }
      : part,
  );

  return content.length > 0 ? { ...message, content: content } : null;
}

/**
 * Filters a user message to what a stored row can hold.
 *
 * Text and media named by URL keep their part: a sealed media link is a short
 * string that still resolves on every later turn, which is the whole reason
 * inbound attachments are stored and linked rather than inlined. Media carrying
 * its own bytes is dropped. A base64 picture is megabytes of row per turn, and
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
        content: [{ type: "text", text: ATTACHMENT_NOT_RETAINED }],
      }
    : null;
}

/**
 * A tool result as a stored row can hold it. Media follows the rule in
 * `sanitizeUserMessage`: bytes are dropped, a URL stays. Whatever is still over
 * `limit` is stored as truncated text, so one oversized result can not fail the
 * write and end the run.
 */
function storableToolResultOutput(
  output: ToolResultPart["output"],
  limit: number,
): ToolResultPart["output"] {
  if (output.type === "execution-denied") {
    return output;
  }
  let stored = output;
  if (output.type === "content") {
    const value = output.value.filter((part): boolean => {
      switch (part.type) {
        case "file-data":
        case "image-data":
          return false;
        case "file":
          return part.data.type === "url"
            ? isStorableMediaReference(part.data)
            : part.data.type !== "data";
        case "file-url":
        case "image-url":
          return isStorableMediaReference(part.url);
        default:
          return true;
      }
    });
    stored = {
      ...output,
      value:
        value.length > 0
          ? value
          : [{ type: "text", text: ATTACHMENT_NOT_RETAINED }],
    };
  }
  const text = truncateText(
    typeof stored.value === "string"
      ? stored.value
      : JSON.stringify(stored.value),
    limit,
  );
  if (!text.truncated) {
    return stored;
  }

  return {
    type:
      output.type === "error-text" || output.type === "error-json"
        ? "error-text"
        : "text",
    value: text.value,
  };
}

async function timePhase<T>(
  phases: ContextPreparePhases,
  key: Exclude<keyof ContextPreparePhases, "historyRows">,
  load: () => Promise<T>,
): Promise<T> {
  const startedMs = Date.now();
  const result = await load();
  phases[key] = Date.now() - startedMs;

  return result;
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
 * assistant message the current model did not write. Another model cannot
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

/**
 * Drops a tool call the history never answers: an abandoned approval, or a step
 * cut short. The AI SDK refuses such a history on every later turn. The call's
 * message loses its stored-item state too, because the provider refuses a
 * reasoning item without the call it produced. The approval the last message
 * answers is still pending, so its call stays.
 */
function withoutUnresolvedToolCalls(messages: ModelMessage[]): ModelMessage[] {
  const lastMessage = messages.at(-1);
  const pendingApprovalIds = new Set(
    isToolApprovalResponseMessage(lastMessage)
      ? lastMessage.content.flatMap((part): string[] =>
          part.type === "tool-approval-response" ? [part.approvalId] : [],
        )
      : [],
  );
  const resolvedToolCallIds = new Set(
    messages.flatMap((message): string[] =>
      typeof message.content === "string"
        ? []
        : message.content.flatMap((part): string[] =>
            part.type === "tool-result" ||
            (part.type === "tool-approval-request" &&
              pendingApprovalIds.has(part.approvalId))
              ? [part.toolCallId]
              : [],
          ),
    ),
  );

  return messages.flatMap((message): ModelMessage[] => {
    if (message.role !== "assistant" || typeof message.content === "string") {
      return [message];
    }
    const content = message.content.filter(
      (part): boolean =>
        (part.type !== "tool-call" && part.type !== "tool-approval-request") ||
        (part.type === "tool-call" && part.providerExecuted === true) ||
        resolvedToolCallIds.has(part.toolCallId),
    );
    if (content.length === message.content.length) {
      return [message];
    }
    const repaired = withoutStoredItems({ ...message, content: content });

    return repaired.content.length > 0 ? [repaired] : [];
  });
}
