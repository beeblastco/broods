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
import type { Principal } from "../shared/domain/principal.ts";
import { getHarnessPublicUrl } from "../shared/env.ts";
import {
  workspaceGuidanceEnabled,
  workspaceMemoryHarnessEnabled,
} from "../shared/domain/workspace-config.ts";
import { collectSecretValues, logDebug, logError } from "../shared/log.ts";
import { isPlainObject } from "../shared/object.ts";
import { sealRunToken } from "../shared/run-token.ts";
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
  sealConversationMedia,
} from "./channel-media.ts";
import {
  COMPACTION_MARKER,
  type CompactionResult,
  isCompactionSummaryMessage,
  summarizeConversation,
} from "./compaction.ts";
import {
  applySteering,
  DEFAULT_CONVERSATION_LEASE_TTL_MS,
  releaseIngressOwner,
  renewIngressOwner,
  settleIngress,
  takeNextIngress,
  type AppliedIngress,
  type AsyncResultSettlement,
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
import type { SandboxRunPrincipal } from "./sandbox/types.ts";
import { truncateText } from "./sandbox/utils.ts";
import {
  listConfiguredSkillMetadata,
  loadConfiguredHarnessSkills,
  loadConfiguredSkillPrompt,
  type SkillMetadata,
} from "./skills.ts";
import { bashTargetLines } from "./tools/filesystem-utils.ts";
import { MEMORY_INDEX_PATH } from "./tools/memory.tool.ts";

// Half of Convex's per-mutation caps (16 MiB of arguments, 16,000 written documents).
const APPEND_EVENT_BYTES = 8 * 1_024 * 1_024;
const APPEND_EVENT_COUNT = 8_000;
const ATTACHMENT_NOT_RETAINED = "[attachment not retained]";
// Only our own hand-off or lease expiry moves ownership, and a fenced write proves it too.
export const OWNER_CHECK_INTERVAL_MS = 2_000;
// Under Convex's 1 MiB document cap, leaving room for the rest of the row.
const STORED_TOOL_MESSAGE_BYTES = 768 * 1024;

export type RunTrigger = "cron";

export type ConversationIngressEvent =
  // Opaque hook data, stored on the event envelope and never in the model message.
  | (UserModelMessage & { metadata?: unknown })
  | AssistantModelMessage
  | ToolModelMessage
  | (SystemModelMessage & { persist?: boolean });

export interface StepBoundary {
  renewal: "renewed" | "stopped" | "stale";
  steering: AppliedIngress | null;
}

export interface TurnContextSnapshot {
  messages: ModelMessage[];
  system: SystemModelMessage[];
  // Also inside `system`; kept apart so a prepareStep rebuild does not drop them.
  ephemeralSystem: SystemModelMessage[];
  systemContextSnapshot: SystemContextSnapshot;
  timings?: TurnContextTimings;
}

export interface TurnContextTimings {
  prepareStartedMs: number;
  prepareEndedMs: number;
  phases: ContextPreparePhases;
}

// The loads overlap, so these do not add up to the prepare span.
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
  cursor: string | null;
  messages: SystemModelMessage[];
}

interface SystemPromptParts {
  system: SystemModelMessage[];
  storedSystemEnd: number;
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
  // The base key, before the adapter version is appended.
  reservationKey?: string;
}

interface StoredEventBase {
  version: 1;
  sourceEventId: string;
  metadata?: unknown;
  // `provider/modelId` of an assistant row: its reasoning and item ids replay to it alone.
  model?: string;
}

interface MessageProducer {
  model?: string;
  // Whether the provider replays reasoning; a stored-item provider breaks without it.
  retainsReasoning?: boolean;
}

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

interface StoredConversationEntry {
  createdAt: string;
  event: StoredConversationEvent;
}

// Convex stores one row per `dedupeKey` in a conversation, so a retried append is safe.
interface AppendedConversationEvent {
  cursor: string;
  dedupeKey?: string;
  event: StoredConversationEvent;
}

export interface StoredConversationEventPage {
  page: Array<{ cursor: string; event: StoredConversationEvent }>;
  isDone: boolean;
  continueCursor: string | null;
}

export interface SessionOptions {
  eventId: string;
  conversationKey: string;
  accountId?: string;
  agentId?: string;
  agentConfig?: AgentConfig;
  // Absent on plain direct/async API turns: their deferred results are read by polling.
  delivery?: AsyncToolDelivery;
  // A subagent replies to its parent, so it has no `delivery`, but policy names the parent's.
  policyDelivery?: AsyncToolDelivery;
  endpointId?: string;
  projectSlug?: string;
  stageSlug?: string;
  // Convex fencing token; absent only on context-only writes that run no model turn.
  ownerGeneration?: number;
  channelActions?: ChannelActions;
  trigger?: RunTrigger;
  persist?: boolean;
  principal?: Principal;
}

export interface IngestedChannelEvents {
  events: ConversationIngressEvent[];
  // Adds this turn's byte-backed media for an agent with no workspace: never store it.
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
  readonly principal: Principal | undefined;
  private readonly agentConfig: AgentConfig;
  private readonly persist: boolean;
  private messageSequence = 0;
  private lastSystemCursor: string | null = null;
  private ownerHandedOff = false;
  // Taken before the call, so the proof is never newer than the commit that gave it.
  private ownerConfirmedAt = Number.NEGATIVE_INFINITY;
  // They ride the next fenced mutation (step boundary, settle, takeNext), not an append.
  private pendingStoredEvents: AppendedConversationEvent[] = [];
  private hasLoggedMissingMemoryFile = false;
  private loadedSkillPrompts: SystemModelMessage[] = [];
  private subagentMetadataPromise: Promise<SubagentMetadata[]> | undefined;
  // Read once per run: a memory_save goes through the mount and reaches S3 minutes later.
  private memoryFilesPromise: Promise<MemoryFile[]> | undefined;
  private skillMetadataPromise: Promise<SkillMetadata[]> | undefined;
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
    this.principal = options.principal;
    this.persist = options.persist ?? true;
  }

  // Called per exec, so no `brt_` token ages in the queue while the run waits for a slot.
  sandboxPrincipal(): SandboxRunPrincipal | undefined {
    if (!this.principal) return undefined;
    const baseUrl = getHarnessPublicUrl();

    return {
      accountId: this.principal.accountId,
      agentId: this.principal.agentId,
      runToken: sealRunToken(this.principal),
      ...(baseUrl ? { baseUrl: baseUrl } : {}),
    };
  }

  async assertCurrentOwner(): Promise<void> {
    if (this.ownerGeneration === undefined) return;
    const startedAt = performance.now();
    const current = await runtime.query("isCurrentIngressOwner", {
      conversationKey: this.conversationKey,
      ownerEventId: this.eventId,
      ownerGeneration: this.ownerGeneration,
    });
    if (!current) throw new Error("Stale conversation owner generation");
    this.confirmOwner(startedAt);
  }

  async assertRecentOwner(): Promise<void> {
    if (
      !this.ownerHandedOff &&
      performance.now() - this.ownerConfirmedAt < OWNER_CHECK_INTERVAL_MS
    ) {
      return;
    }
    await this.assertCurrentOwner();
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
    // The release must happen either way: a held lease blocks the conversation.
    await this.flushPendingStoredEvents().catch((err: unknown): void => {
      logError("History rows lost before the lease release", {
        eventId: this.eventId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    await releaseIngressOwner({
      conversationKey: this.conversationKey,
      ownerEventId: this.eventId,
      ownerGeneration: this.ownerGeneration,
    });
    this.ownerHandedOff = true;
  }

  async renewConversationLease(): Promise<"renewed" | "stopped" | "stale"> {
    if (this.ownerGeneration === undefined) return "renewed";
    const startedAt = performance.now();
    const renewal = await renewIngressOwner({
      conversationKey: this.conversationKey,
      ownerEventId: this.eventId,
      ownerGeneration: this.ownerGeneration,
    });
    if (renewal === "renewed") this.confirmOwner(startedAt);

    return renewal;
  }

  // A stale boundary stores nothing and drops its rows: the conversation has moved on.
  async stepBoundary(
    messages: ModelMessage[],
    options: { claimSteering: boolean } = { claimSteering: true },
  ): Promise<StepBoundary> {
    const events = await this.storedEvents(messages);
    if (this.ownerGeneration === undefined) {
      await this.appendStoredEvents(events);

      return { renewal: "renewed", steering: null };
    }
    const ownerGeneration = this.ownerGeneration;

    return this.writeFenced(
      events,
      async (inline, rows): Promise<StepBoundary> => {
        const startedAt = performance.now();
        const boundary = await runtime.mutate("stepIngressBoundary", {
          conversationKey: this.conversationKey,
          ownerEventId: this.eventId,
          ownerGeneration: ownerGeneration,
          leaseTtlMs: DEFAULT_CONVERSATION_LEASE_TTL_MS,
          ...(inline.length > 0 ? { events: inline } : {}),
          claimSteering: options.claimSteering,
        });
        if (boundary.renewal !== "stale") this.trackSystemCursor(rows);
        if (boundary.renewal === "renewed") this.confirmOwner(startedAt);

        return boundary;
      },
    );
  }

  async flushPendingStoredEvents(): Promise<void> {
    if (this.pendingStoredEvents.length === 0) return;
    await this.writeFenced([], (inline) => this.appendStoredEvents(inline));
  }

  async appendIngressEvents(
    events: ConversationIngressEvent[],
  ): Promise<SystemModelMessage[]> {
    const { ephemeralSystem, persisted } = splitIngressEvents(events);
    await this.persistModelMessages(persisted);

    return ephemeralSystem;
  }

  async applySteeringIngress(
    options: { textOnly?: boolean } = {},
  ): Promise<AppliedIngress | null> {
    if (this.ownerGeneration === undefined) return null;
    const startedAt = performance.now();
    const steering = await applySteering({
      conversationKey: this.conversationKey,
      ownerEventId: this.eventId,
      ownerGeneration: this.ownerGeneration,
      ...(options.textOnly ? { textOnly: true } : {}),
    });
    this.confirmOwner(startedAt);

    return steering;
  }

  async settleIngress(
    status: "completed" | "failed",
    options: {
      result?: unknown;
      error?: string;
      asyncResult?: AsyncResultSettlement;
    } = {},
  ): Promise<boolean> {
    if (this.ownerGeneration === undefined) return false;
    const ownerGeneration = this.ownerGeneration;
    const settle = async (rows: AppendedConversationEvent[]): Promise<void> => {
      const startedAt = performance.now();
      await settleIngress({
        conversationKey: this.conversationKey,
        ownerEventId: this.eventId,
        ownerGeneration: ownerGeneration,
        status: status,
        ...options,
        ...(rows.length > 0 ? { events: rows } : {}),
      });
      this.confirmOwner(startedAt);
    };
    await this.writeFenced([], settle).catch(
      async (err: unknown): Promise<void> => {
        // The outcome beats the history: on a second failure, settle without the rows.
        if (this.pendingStoredEvents.length === 0) throw err;
        const retried = await this.writeFenced([], settle).then(
          (): boolean => true,
          (): boolean => false,
        );
        if (retried) return;
        logError("History rows dropped so the turn could settle", {
          eventId: this.eventId,
          rows: this.pendingStoredEvents.length,
          error: err instanceof Error ? err.message : String(err),
        });
        this.pendingStoredEvents = [];
        await settle([]);
      },
    );

    return true;
  }

  async takeNextIngress(
    settle?: IngressSettlement,
  ): Promise<AppliedIngress | null> {
    if (this.ownerGeneration === undefined) return null;
    const owner = {
      conversationKey: this.conversationKey,
      ownerEventId: this.eventId,
      ownerGeneration: this.ownerGeneration,
    };
    const next = await this.writeFenced([], (inline) =>
      takeNextIngress(owner, settle, inline),
    ).catch(async (err: unknown): Promise<never> => {
      if (settle) {
        const { status, ...outcome } = settle;
        await this.settleIngress(status, outcome).catch(
          (settleErr: unknown): boolean => {
            logError("Turn outcome lost: settle after a failed takeNext", {
              eventId: this.eventId,
              error:
                settleErr instanceof Error
                  ? settleErr.message
                  : String(settleErr),
            });

            return false;
          },
        );
      }
      throw err;
    });
    this.ownerHandedOff = true;

    return next;
  }

  async persistModelMessages(
    messages: ModelMessage[],
    onSaved?: (saved: number) => void,
    dedupeKeys?: string[],
  ): Promise<string[]> {
    const events = await this.storedEvents(messages, dedupeKeys);
    await this.appendStoredEvents(events, onSaved);

    return events.map((entry): string => entry.cursor);
  }

  async loadHarnessSession(): Promise<StoredHarnessSession | null> {
    return runtime.query("getHarnessSession", {
      conversationKey: this.conversationKey,
    });
  }

  async saveHarnessSession(state: StoredHarnessSession): Promise<void> {
    if (!this.persist) return;
    if (this.ownerGeneration === undefined) {
      throw new Error("Harness checkpoint needs a conversation owner");
    }
    const serialized = JSON.stringify(state.resumeState);
    if (serialized === undefined) {
      throw new Error("Harness resume state must be JSON serializable");
    }
    const startedAt = performance.now();
    await runtime.mutate("saveHarnessSession", {
      conversationKey: this.conversationKey,
      ownerEventId: this.eventId,
      ownerGeneration: this.ownerGeneration,
      ...state,
    });
    this.confirmOwner(startedAt);
  }

  async compactConversation(
    instructions: string,
  ): Promise<CompactionResult | null> {
    const entries = await this.loadConversationEntries();
    const activeEntries = projectActiveConversationEntries(entries);
    const systemContextSnapshot = createSystemContextSnapshot(entries);
    // Not rehydrated: the summarizer needs only the text around stored media.
    const messages = projectEntriesToMessages(
      activeEntries,
      modelIdentityFromModelConfig(this.agentConfig),
    );
    if (messages.length === 0 || hasPendingToolApprovalResponse(messages)) {
      return null;
    }
    const summary = await summarizeConversation({
      accountId: this.accountId,
      conversationKey: this.conversationKey,
      priorSummaries: systemContextSnapshot.messages.filter(
        isCompactionSummaryMessage,
      ),
      messages: stripEnvelopeFieldsFromMessages(messages),
      agentConfig: this.agentConfig,
      instructions: instructions,
    });
    if (!summary) {
      return null;
    }
    const { message, ...cost } = summary;
    await this.persistModelMessages([message]);

    return { ...cost, messageCount: messages.length };
  }

  async createEphemeralTurnContext(
    messages: ModelMessage[],
    ephemeralSystem: SystemModelMessage[] = [],
  ): Promise<TurnContextSnapshot> {
    await this.ensureResolvedRuntime();

    return {
      messages: pruneSessionMessages(messages, this.agentConfig),
      system: (await this.buildSystemPromptParts([], ephemeralSystem)).system,
      ephemeralSystem: ephemeralSystem,
      systemContextSnapshot: { cursor: null, messages: [] },
    };
  }

  async createTurnContext(
    extraEphemeralSystem: SystemModelMessage[] = [],
    ingress: ConversationIngressEvent[] = [],
  ): Promise<TurnContextSnapshot> {
    const prepareStartedMs = Date.now();
    const input = splitIngressEvents(ingress);
    const ephemeralSystem = [...input.ephemeralSystem, ...extraEphemeralSystem];
    const appended: AppendedConversationEvent[] = [];
    const turnContent = new Map<string, UserContent>();
    for (const message of input.persisted) {
      const [row] = await this.storedEvents([message]);
      if (!row) continue;
      appended.push(row);
      if (message.role === "user") turnContent.set(row.cursor, message.content);
    }
    // A fenced turn writes its rows with the first step boundary: one mutation fewer.
    const unwritten = [...this.pendingStoredEvents, ...appended];
    const fenced = this.ownerGeneration !== undefined;
    if (fenced) this.pendingStoredEvents.push(...appended);
    const phases: ContextPreparePhases = {
      historyMs: 0,
      historyRows: 0,
      mediaMs: 0,
      memoryMs: 0,
      runtimeMs: 0,
      skillsMs: 0,
      subagentsMs: 0,
    };
    const [history] = await Promise.all([
      this.loadTurnHistory(phases, unwritten, turnContent),
      fenced ? undefined : this.appendStoredEvents(appended),
      timePhase(phases, "runtimeMs", () => this.ensureResolvedRuntime()),
      timePhase(phases, "memoryMs", () => this.loadMemoryFiles()),
      timePhase(phases, "skillsMs", () => this.loadSkillMetadata()),
      timePhase(phases, "subagentsMs", () => this.loadSubagentMetadata()),
    ]);
    const systemContextSnapshot = createSystemContextSnapshot(history.entries);
    let messages = history.messages;
    const { system } = await this.buildSystemPromptParts(
      systemContextSnapshot.messages,
      ephemeralSystem,
    );

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

  async loadRefreshedSystemPromptParts(options: {
    systemContextSnapshot: SystemContextSnapshot;
    ephemeralSystem?: SystemModelMessage[];
  }): Promise<
    SystemPromptParts & { systemContextSnapshot: SystemContextSnapshot }
  > {
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
      ...(await this.buildSystemPromptParts(
        systemContextSnapshot.messages,
        options.ephemeralSystem ?? [],
      )),
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
      this.accountId,
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

  // Sent after the history and never stored, so the prompt and history stay a cached prefix.
  environmentText(machine: string[] = []): string {
    const workspaces = this.resolvedWorkspaces();
    const sandboxes = this.sandboxes();
    const canBash =
      sandboxes.length > 0 || workspaces.some((workspace) => workspace.sandbox);

    return formatEnvironmentPrompt({
      now: new Date(),
      channel: this.channelLabel(),
      bashTargets: canBash
        ? bashTargetLines({ workspaces: workspaces, sandboxes: sandboxes })
        : [],
      machine: machine,
    });
  }

  sandboxes(): ResolvedAgentSandbox[] {
    return this.resolvedRuntime?.sandboxes ?? [];
  }

  filesystemNamespace(): string {
    return this.resolvedWorkspaces()[0]?.namespace ?? "";
  }

  resolvedWorkspaces(): ResolvedWorkspace[] {
    return this.resolvedRuntime?.workspaces ?? [];
  }

  secretValues(): string[] {
    return collectSecretValues([
      this.agentConfig,
      this.sandboxes(),
      this.resolvedWorkspaces(),
    ]);
  }

  private async appendConversationEvents(
    events: AppendedConversationEvent[],
  ): Promise<void> {
    if (this.ownerGeneration !== undefined) {
      const startedAt = performance.now();
      await runtime.mutate("appendFencedConversationEvent", {
        conversationKey: this.conversationKey,
        ownerEventId: this.eventId,
        ownerGeneration: this.ownerGeneration,
        events: events,
      });
      this.confirmOwner(startedAt);

      return;
    }
    await runtime.mutate("appendConversationEvent", {
      conversationKey: this.conversationKey,
      events: events,
    });
  }

  private async appendStoredEvents(
    events: AppendedConversationEvent[],
    onSaved?: (saved: number) => void,
  ): Promise<void> {
    if (events.length === 0) return;
    let saved = 0;
    for (const batch of storedEventBatches(events)) {
      await this.appendConversationEvents(batch);
      saved += batch.length;
      onSaved?.(saved);
    }
    this.trackSystemCursor(events);
  }

  // `write` carries the last batch once the rest are appended. Rows keyed by cursor survive
  // a failed write for the next one, and a commit whose reply was lost stores none twice.
  private async writeFenced<T>(
    events: AppendedConversationEvent[],
    write: (
      inline: AppendedConversationEvent[],
      rows: AppendedConversationEvent[],
    ) => Promise<T>,
  ): Promise<T> {
    const rows = [...this.pendingStoredEvents, ...events].map(
      (row): AppendedConversationEvent => ({
        ...row,
        dedupeKey: row.dedupeKey ?? row.cursor,
      }),
    );
    this.pendingStoredEvents = [];
    try {
      const batches = storedEventBatches(rows);
      const inline = batches.pop() ?? [];
      for (const batch of batches) await this.appendConversationEvents(batch);

      return await write(inline, rows);
    } catch (err) {
      this.pendingStoredEvents = [...rows, ...this.pendingStoredEvents];
      throw err;
    }
  }

  private confirmOwner(startedAt: number): void {
    this.ownerConfirmedAt = Math.max(this.ownerConfirmedAt, startedAt);
  }

  private trackSystemCursor(
    events: { cursor: string; event: StoredConversationEvent }[],
  ): void {
    const systemCursor = events.findLast(
      (entry): boolean => entry.event.message.role === "system",
    )?.cursor;
    if (
      systemCursor !== undefined &&
      (this.lastSystemCursor === null || systemCursor > this.lastSystemCursor)
    ) {
      this.lastSystemCursor = systemCursor;
    }
  }

  private async buildSystemPromptParts(
    promptMessages: SystemModelMessage[],
    ephemeralSystem: SystemModelMessage[] = [],
  ): Promise<SystemPromptParts> {
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

    const stored = [
      ...agentSystemMessages(this.agentConfig.agent?.system),
      ...memorySystem,
      ...workspaceHarnessSystem,
      ...memoryHarnessSystem,
      ...schedulerSystem,
      ...skillsSystem,
      ...subagentSystem,
      ...this.loadedSkillPrompts,
      ...promptMessages,
    ];

    return {
      system: [...stored, ...ephemeralSystem],
      storedSystemEnd: stored.length - 1,
    };
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

  // An AI SDK harness brings its own workspace guidance and takes over these tools.
  private enableDefaultHarness(): boolean {
    if (this.agentConfig.harness !== undefined) {
      return false;
    }

    return (this.resolvedRuntime?.workspaces ?? []).some((workspace) =>
      workspaceGuidanceEnabled(workspace.config),
    );
  }

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

  // Must match the memory_save registry condition in tools/index.ts.
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
    const afterCursor = options.afterCreatedAt ?? undefined;
    // A full read pages back and stops at the latest compaction summary: none reads past it.
    const backward = afterCursor === undefined;
    const pages: StoredConversationEntry[][] = [];
    let cursor = afterCursor;
    for (;;) {
      const result = await runtime.query(
        "listConversationEvents",
        backward
          ? {
              conversationKey: this.conversationKey,
              beforeCursor: cursor,
              fromSystemPrefix: COMPACTION_MARKER,
            }
          : { conversationKey: this.conversationKey, afterCursor: cursor },
      );
      pages.push(
        result.page.map((row) => ({
          createdAt: row.cursor,
          event: row.event,
        })),
      );
      if (result.isDone) {
        return (backward ? pages.reverse() : pages).flat();
      }
      if (!result.continueCursor || result.continueCursor === cursor) {
        throw new Error("Conversation event pagination did not advance");
      }
      cursor = result.continueCursor;
    }
  }

  private async loadMemoryFile(
    workspace: ResolvedWorkspace,
  ): Promise<string | null> {
    // S3 API, not the mount, so a workspace with no sandbox still serves its memory.
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
    await this.ensureResolvedRuntime();
    if (!this.isWorkspaceEnabled()) {
      return [];
    }

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

  // `turnContent` puts this turn's own input, media included, back over its stored rows.
  private async loadTurnHistory(
    phases: ContextPreparePhases,
    appended: { cursor: string; event: StoredConversationEvent }[],
    turnContent: ReadonlyMap<string, UserContent>,
  ): Promise<TurnHistory> {
    const entries = await timePhase(phases, "historyMs", () =>
      this.loadConversationEntries(),
    );
    // A lease-free context write can land before this run's rows: merge by cursor.
    const read = new Set(entries.map((entry): string => entry.createdAt));
    const missing = appended.filter((row): boolean => !read.has(row.cursor));
    if (missing.length > 0) {
      entries.push(
        ...missing.map((row): StoredConversationEntry => ({
          createdAt: row.cursor,
          event: row.event,
        })),
      );
      entries.sort((left, right): number =>
        left.createdAt < right.createdAt ? -1 : 1,
      );
    }
    phases.historyRows = entries.length;
    const turnEntries = entries.map((entry): StoredConversationEntry => {
      const content = turnContent.get(entry.createdAt);

      return content !== undefined && entry.event.message.role === "user"
        ? {
            ...entry,
            event: {
              ...entry.event,
              message: { ...entry.event.message, content: content },
            },
          }
        : entry;
    });
    const messages = await timePhase(phases, "mediaMs", () =>
      rehydrateStoredMedia(
        projectEntriesToMessages(
          projectActiveConversationEntries(turnEntries),
          modelIdentityFromModelConfig(this.agentConfig),
        ),
        this.agentConfig,
        this.accountId,
      ),
    );

    return { entries: entries, messages: messages };
  }

  private nextCreatedAt(): string {
    const sequence = String(this.messageSequence).padStart(4, "0");
    this.messageSequence += 1;

    return `${new Date().toISOString()}#${this.eventId}#${sequence}`;
  }

  private async storedEvents(
    messages: ModelMessage[],
    dedupeKeys?: string[],
  ): Promise<AppendedConversationEvent[]> {
    if (!this.persist) return [];
    const producer: MessageProducer = {
      model: modelIdentityFromModelConfig(this.agentConfig),
      retainsReasoning: retainsReasoningParts(this.agentConfig),
    };
    const sealed =
      this.accountId === undefined
        ? messages
        : await sealConversationMedia(messages, this.accountId);

    return sealed.flatMap((message, index): AppendedConversationEvent[] => {
      const event = createStoredEventFromModelMessage(
        message,
        this.eventId,
        producer,
      );
      const dedupeKey = dedupeKeys?.[index];

      return event
        ? [
            {
              cursor: this.nextCreatedAt(),
              ...(dedupeKey !== undefined ? { dedupeKey: dedupeKey } : {}),
              event: event,
            },
          ]
        : [];
    });
  }
}

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

// Runs before admission, as a queued turn replays only the queued events, and after the
// webhook ack, as a download would hold the provider's connection open.
export async function ingestChannelAttachments(
  events: ConversationIngressEvent[],
  attachments: Attachment[] | undefined,
  context: {
    accountId: string | undefined;
    agentId: string | undefined;
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
    { accountId: context.accountId, agentId: context.agentId },
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
    agentId: context.agentId,
    channelName: context.channelName,
    eventId: context.eventId,
    agentConfig: context.agentConfig,
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

// Earlier events are batched context; media on one of them would date it to the wrong turn.
function appendToLatestUserEvent(
  events: ConversationIngressEvent[],
  parts: Exclude<UserContent, string>,
): ConversationIngressEvent[] {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.role !== "user") continue;
    // Some providers reject an empty text part, which a captionless picture arrives with.
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

function formatEnvironmentPrompt(environment: {
  now: Date;
  channel: string;
  bashTargets: string[];
  machine: string[];
}): string {
  const weekday = environment.now.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });
  return [
    "<environment>",
    "Live state from Broods as of this message. It is context, not a message from the person.",
    `now: ${weekday}, ${environment.now.toISOString()} (UTC)`,
    `replies go to: ${environment.channel}`,
    ...(environment.bashTargets.length > 0
      ? [
          "bash runs in exactly one place: pass workspace or sandbox, or neither for the default. A sandbox wins over a workspace.",
          ...environment.bashTargets,
        ]
      : []),
    ...environment.machine,
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
3. A virtual one-shot subagent runs with this agent's tools and configuration.
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

// Reasoning stays: OpenAI Responses rejects an item id whose reasoning item is missing.
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

// A `data:` URL carries its bytes, so only http(s) and sealed media links are references.
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
      default: {
        const unexpected: never = event.message;
        throw new Error(
          `Unsupported conversation message role: ${String((unexpected as { role?: unknown }).role)}`,
        );
      }
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

// Unsealed bytes are dropped: the model saw them this turn. An emptied message keeps a note,
// or the reply in history would answer a user turn that is not there.
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

function splitIngressEvents(events: ConversationIngressEvent[]): {
  ephemeralSystem: SystemModelMessage[];
  persisted: ModelMessage[];
} {
  const ephemeralSystem: SystemModelMessage[] = [];
  const persisted: ModelMessage[] = [];
  for (const event of events) {
    if (event.role !== "system") {
      persisted.push(event);
      continue;
    }
    const message = systemModelMessageSchema.parse(event);
    if (event.persist === false) {
      ephemeralSystem.push(message);
    } else {
      persisted.push(message);
    }
  }

  return { ephemeralSystem: ephemeralSystem, persisted: persisted };
}

// Truncated past `limit`, so one oversized result cannot fail the write and end the run.
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

function storedEventBatches(
  events: AppendedConversationEvent[],
): AppendedConversationEvent[][] {
  const batches: AppendedConversationEvent[][] = [];
  let batch: typeof events = [];
  let batchBytes = 0;
  for (const entry of events) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry));
    if (
      batch.length > 0 &&
      (batchBytes + entryBytes > APPEND_EVENT_BYTES ||
        batch.length >= APPEND_EVENT_COUNT)
    ) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(entry);
    batchBytes += entryBytes;
  }
  if (batch.length > 0) batches.push(batch);

  return batches;
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

// Another model cannot decrypt this reasoning, and the provider resolves item ids through it.
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

// The AI SDK refuses a history with an unanswered tool call, and the provider a reasoning
// item without its call. The approval the last message answers is pending, so it stays.
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
