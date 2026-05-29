/**
 * Session lifecycle for harness-processing.
 * Keep event persistence, context projection, leases, and prompt loading here.
 */

import {
  DeleteItemCommand,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import type {
  AssistantModelMessage,
  ModelMessage,
  SystemModelMessage,
  ToolModelMessage,
  UserModelMessage,
} from "ai";
import {
  modelMessageSchema,
  systemModelMessageSchema,
} from "ai";
import { DEFAULT_SYSTEM_PROMPT } from "../_shared/.generated/system-prompt.ts";
import type { AgentConfig } from "../_shared/storage/index.ts";
import { getStorage } from "../_shared/storage/index.ts";
import { isMissingS3Error, readS3Text } from "../_shared/s3.ts";
import { workspaceNamespacePrefix } from "../_shared/sandbox.ts";
import {
  dynamo,
  fromAttributeValue,
  isConditionalCheckFailed,
  toAttributeValue,
} from "../_shared/storage/dynamo/client.ts";
import { requireEnv } from "../_shared/env.ts";
import {
  conversationLeaseKey,
  normalizeFilesystemNamespace,
} from "../_shared/runtime-keys.ts";
import { logError, logInfo } from "../_shared/log.ts";
import {
  loadConfiguredSkillPrompt,
  listConfiguredSkillMetadata,
  publishStagedSkillBundle,
  type PublishedSkillFromWorkspace,
  type SkillMetadata,
} from "./skills.ts";
import { compactSessionContext, isCompactionSummaryMessage } from "./compaction.ts";
import { pruneSessionMessages } from "./pruning.ts";
import { createWorkspaceSandboxExecutor } from "./sandbox/index.ts";
import type { WorkspaceSandboxConfig } from "./sandbox/types.ts";

const CONVERSATIONS_TABLE_NAME = requireEnv("CONVERSATIONS_TABLE_NAME");
const PROCESSED_EVENTS_TABLE_NAME = requireEnv("PROCESSED_EVENTS_TABLE_NAME");
const FILESYSTEM_BUCKET_NAME = requireEnv("FILESYSTEM_BUCKET_NAME");

// Default conversation lease TTL of 15 minutes.
const CONVERSATION_LEASE_TTL_SECONDS = 15 * 60;

export type ConversationIngressEvent =
  | UserModelMessage
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
}

export interface SystemContextSnapshot {
  // Highest conversation row already folded into the dynamic system-context view.
  // `loadRefreshedSystemPromptParts` uses this as a DynamoDB cursor so each
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

/**
 * Shared fields for every stored conversation event.
 * `version` gives us a migration hook for future schema changes, and
 * `sourceEventId` ties projected rows back to the inbound Lambda/webhook event
 * that created them for dedupe/debugging.
 */
interface StoredEventBase {
  version: 1;
  sourceEventId: string;
}

// Internal normalized shapes persisted in DynamoDB. We use AI SDK-style roles
// here as well so an event is effectively a stored model message plus metadata.
interface StoredConversationEventBase<TMessage extends ModelMessage> extends StoredEventBase {
  message: TMessage;
}

type StoredConversationEvent =
  | StoredConversationEventBase<UserModelMessage>
  | StoredConversationEventBase<AssistantModelMessage>
  | StoredConversationEventBase<ToolModelMessage>
  | StoredConversationEventBase<SystemModelMessage>;

// Query results need both the stored event payload and its DynamoDB sort key so
// we can build point-in-time snapshots and later fetch only prompt deltas after
// a known cursor.
interface StoredConversationEntry {
  createdAt: string;
  event: StoredConversationEvent;
}

/**
 * Agent conversation session.
 * Owns persistence, leases, prompt assembly, and in-memory child turns.
 */
export class Session {
  private messageSequence = 0;
  private hasLoggedMissingMemoryFile = false;
  private loadedSkillPrompts: SystemModelMessage[] = [];
  private subagentMetadataPromise: Promise<SubagentMetadata[]> | undefined;

  constructor(
    public readonly eventId: string,
    public readonly conversationKey: string,
    public readonly accountId: string | undefined,
    public readonly agentId: string | undefined,
    private readonly agentConfig: AgentConfig = {},
  ) { }

  async claim(): Promise<boolean> {
    const ttl = Math.floor(Date.now() / 1000) + 86400;

    try {
      await dynamo.send(new PutItemCommand({
        TableName: PROCESSED_EVENTS_TABLE_NAME,
        Item: {
          eventId: { S: this.eventId },
          createdAt: { S: new Date().toISOString() },
          expiresAt: { N: String(ttl) },
        },
        ConditionExpression: "attribute_not_exists(eventId)",
      }));
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return false;
      }
      throw err;
    }
  }

  async release(): Promise<void> {
    await dynamo.send(new DeleteItemCommand({
      TableName: PROCESSED_EVENTS_TABLE_NAME,
      Key: { eventId: { S: this.eventId } },
    }));
  }

  async acquireConversationLease(): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const ttl = now + CONVERSATION_LEASE_TTL_SECONDS;

    try {
      await dynamo.send(new PutItemCommand({
        TableName: PROCESSED_EVENTS_TABLE_NAME,
        Item: {
          eventId: { S: this.conversationLeaseKey() },
          createdAt: { S: new Date().toISOString() },
          expiresAt: { N: String(ttl) },
          ownerEventId: { S: this.eventId },
          conversationKey: { S: this.conversationKey },
        },
        ConditionExpression: "attribute_not_exists(eventId) OR expiresAt < :now",
        ExpressionAttributeValues: {
          ":now": { N: String(now) },
        },
      }));
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return false;
      }
      throw err;
    }
  }

  async releaseConversationLease(): Promise<void> {
    try {
      await dynamo.send(new DeleteItemCommand({
        TableName: PROCESSED_EVENTS_TABLE_NAME,
        Key: { eventId: { S: this.conversationLeaseKey() } },
        ConditionExpression: "ownerEventId = :ownerEventId",
        ExpressionAttributeValues: {
          ":ownerEventId": { S: this.eventId },
        },
      }));
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return;
      }

      throw err;
    }
  }

  async appendIngressEvents(events: ConversationIngressEvent[]): Promise<SystemModelMessage[]> {
    const ephemeralSystem: SystemModelMessage[] = [];
    const persistedMessages: ModelMessage[] = [];

    for (const event of events) {
      if (event.role === "system") {
        const message = normalizeSystemMessage(event);

        if (event.persist === false) {
          // Direct API system injections are one-turn instructions. They are
          // returned to the caller and included in the current turn's system
          // prompt, but never written to DynamoDB.
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

  async persistModelMessages(messages: ModelMessage[]): Promise<string[]> {
    const createdAtValues: string[] = [];

    for (const message of messages) {
      const storedEvent = createStoredEventFromModelMessage(message, this.eventId);
      if (!storedEvent) {
        continue;
      }

      createdAtValues.push(await this.persistStoredEvent(storedEvent));
    }

    return createdAtValues;
  }

  async createTurnContext(ephemeralSystem: SystemModelMessage[] = []): Promise<TurnContextSnapshot> {
    const entries = await this.loadConversationEntries();
    const activeEntries = projectActiveConversationEntries(entries);
    // Snapshot persisted system context separately from chat messages. The
    // harness passes this through prepareStep so long-running tool loops can
    // refresh system prompt parts without duplicating old system rows.
    const systemContextSnapshot = createSystemContextSnapshot(entries);
    let messages = projectEntriesToMessages(activeEntries);
    const system = await this.buildSystemPromptParts(systemContextSnapshot.messages, ephemeralSystem);

    const compactionSummary = await compactSessionContext({
      conversationKey: this.conversationKey,
      system,
      messages,
      agentConfig: this.agentConfig,
    }).catch((error) => {
      logError("Session context compaction failed; continuing without compaction", {
        conversationKey: this.conversationKey,
        eventId: this.eventId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

    if (compactionSummary) {
      const [summaryCursor] = await this.persistModelMessages([compactionSummary]);
      const compactedSystemContextSnapshot = {
        cursor: summaryCursor ?? systemContextSnapshot.cursor,
        messages: [compactionSummary],
      };
      // Approval responses need their matching assistant request in model history.
      // Keep that pending pair outside the compacted summary so the AI SDK can resume it.
      messages = selectPostCompactionPendingMessages(messages);

      return {
        messages: pruneSessionMessages(messages, this.agentConfig),
        system: await this.buildSystemPromptParts(compactedSystemContextSnapshot.messages, ephemeralSystem),
        ephemeralSystem: ephemeralSystem,
        systemContextSnapshot: compactedSystemContextSnapshot,
      };
    }

    messages = pruneSessionMessages(messages, this.agentConfig);

    return { messages, system, ephemeralSystem, systemContextSnapshot };
  }

  async createEphemeralTurnContext(
    messages: ModelMessage[],
    ephemeralSystem: SystemModelMessage[] = [],
  ): Promise<TurnContextSnapshot> {
    // Ephemeral child turns are in-memory only, but they still need the same
    // source `ephemeralSystem` list so system prompt refreshes preserve it.
    return {
      messages: pruneSessionMessages(messages, this.agentConfig),
      system: await this.buildSystemPromptParts([], ephemeralSystem),
      ephemeralSystem: ephemeralSystem,
      systemContextSnapshot: { cursor: null, messages: [] },
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
  }): Promise<{ systemContextSnapshot: SystemContextSnapshot; system: SystemModelMessage[] }> {
    // Incremental refresh for prepareStep: load only conversation rows newer
    // than the cursor, then fold any system-role rows into the snapshot.
    const entries = await this.loadConversationEntries({
      afterCreatedAt: options.systemContextSnapshot.cursor,
    });

    const systemContextSnapshot: SystemContextSnapshot = entries.length === 0
      ? options.systemContextSnapshot
      : {
        cursor: entries.at(-1)?.createdAt ?? options.systemContextSnapshot.cursor,
        messages: [...options.systemContextSnapshot.messages, ...projectSystemContextMessages(entries)],
      };

    return {
      systemContextSnapshot: systemContextSnapshot,
      system: await this.buildSystemPromptParts(systemContextSnapshot.messages, options.ephemeralSystem ?? []),
    };
  }

  async loadSkillPrompt(
    allowedSkillPaths: string[],
    skillPath: string,
    resourcePaths?: string[],
  ): Promise<{ path: string; loadedPaths: string[]; stagedPath?: string; stagedFiles: string[]; bytes: number }> {
    const loaded = await loadConfiguredSkillPrompt(
      allowedSkillPaths,
      skillPath,
      resourcePaths,
      this.isWorkspaceEnabled() ? this.filesystemNamespace() : undefined,
      { preserveStagedEdits: this.isSkillPublishEnabled() },
    );
    this.loadedSkillPrompts.push(loaded.prompt);
    return loaded;
  }

  async publishSkillFromWorkspace(
    allowedSkillPaths: string[],
    skillPath: string,
    options: { force?: boolean } = {},
  ): Promise<PublishedSkillFromWorkspace> {
    if (!this.isWorkspaceEnabled()) {
      throw new Error("Workspace must be enabled to publish staged skill changes");
    }

    const sandboxConfig = (this.agentConfig.workspace?.sandbox ?? {}) as WorkspaceSandboxConfig;
    const executor = createWorkspaceSandboxExecutor(sandboxConfig);
    if (!executor.readDirectory) {
      throw new Error("Publishing staged skill changes requires a sandbox provider that can read the mount");
    }

    const namespace = this.filesystemNamespace();
    const workspaceRoot = workspaceRootFromConfig(sandboxConfig);
    // Read the working copy straight from the mount (not S3): the agent's edits take
    // ~1-2 min to sync into listable S3 objects, so an S3 read would miss them.
    const readMountDir = async (relativeDir: string): Promise<Array<{ path: string; base64: string }>> => {
      const result = await executor.readDirectory!({ namespace, path: relativeDir, workspaceRoot });
      if (!result.ok) {
        throw new Error(`Failed to read staged skill from the sandbox mount: ${result.error ?? "unknown error"}`);
      }
      if (result.truncated) {
        throw new Error("Staged skill bundle is too large to publish from the sandbox mount");
      }
      return result.files;
    };

    return publishStagedSkillBundle(
      allowedSkillPaths,
      skillPath,
      namespace,
      readMountDir,
      options,
    );
  }

  private async buildSystemPromptParts(
    promptMessages: SystemModelMessage[],
    ephemeralSystem: SystemModelMessage[] = [],
  ): Promise<SystemModelMessage[]> {
    const [memoryContent, skillMetadata, subagentMetadata] = await Promise.all([
      this.loadMemoryFile(),
      this.loadSkillMetadata(),
      this.loadSubagentMetadata(),
    ]);
    const memorySystem: SystemModelMessage[] = memoryContent == null
      ? []
      : [{
        role: "system",
        content: formatMemorySystemPrompt(memoryContent),
      }];
    const workspaceHarnessSystem: SystemModelMessage[] = this.isWorkspaceHarnessEnabled()
      ? [{
        role: "system",
        content: formatWorkspaceHarnessSystemPrompt(this.filesystemNamespace()),
      }]
      : [];
    const skillsSystem: SystemModelMessage[] = skillMetadata.length > 0
      ? [{
        role: "system",
        content: formatSkillsSystemPrompt(skillMetadata),
      }]
      : [];
    const subagentSystem: SystemModelMessage[] = this.agentConfig.subagent?.enabled === true
      ? [{
        role: "system",
        content: formatSubagentSystemPrompt(subagentMetadata),
      }]
      : [];

    return [
      {
        role: "system",
        content: loadEnvironmentContextPrompt(),
      },
      {
        role: "system",
        content: this.agentConfig.agent?.system ?? DEFAULT_SYSTEM_PROMPT,
      },
      ...memorySystem,
      ...workspaceHarnessSystem,
      ...skillsSystem,
      ...subagentSystem,
      ...this.loadedSkillPrompts,
      ...promptMessages,
      ...ephemeralSystem,
    ];
  }

  private async persistStoredEvent(event: StoredConversationEvent): Promise<string> {
    const createdAt = this.nextCreatedAt();
    await dynamo.send(new PutItemCommand({
      TableName: CONVERSATIONS_TABLE_NAME,
      Item: {
        conversationKey: { S: this.conversationKey },
        createdAt: { S: createdAt },
        event: toAttributeValue(event),
      },
    }));
    return createdAt;
  }

  private async loadConversationEntries(options: {
    afterCreatedAt?: string | null;
  } = {}): Promise<StoredConversationEntry[]> {
    const keyConditionExpression = options.afterCreatedAt
      ? "conversationKey = :conversationKey AND createdAt > :createdAt"
      : "conversationKey = :conversationKey";
    const result = await dynamo.send(new QueryCommand({
      TableName: CONVERSATIONS_TABLE_NAME,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: {
        ":conversationKey": { S: this.conversationKey },
        ...(options.afterCreatedAt ? { ":createdAt": { S: options.afterCreatedAt } } : {}),
      },
      ConsistentRead: true,
      ScanIndexForward: true,
    }));

    return (result.Items ?? [])
      .map(itemToStoredConversationEntry)
      .filter((entry): entry is StoredConversationEntry => entry != null);
  }

  private nextCreatedAt(): string {
    const sequence = String(this.messageSequence).padStart(4, "0");
    this.messageSequence += 1;
    return `${new Date().toISOString()}#${this.eventId}#${sequence}`;
  }

  private async loadMemoryFile(): Promise<string | null> {
    if (!this.isWorkspaceEnabled()) {
      return null;
    }

    const key = `${workspaceNamespacePrefix(this.filesystemNamespace())}/MEMORY.md`;

    try {
      return await readS3Text(FILESYSTEM_BUCKET_NAME, key);
    } catch (error) {
      if (!isMissingS3Error(error)) {
        logError("Failed to load MEMORY.md for session prompt", {
          conversationKey: this.conversationKey,
          key,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    if (!this.hasLoggedMissingMemoryFile) {
      logInfo("No MEMORY.md found for session prompt", {
        conversationKey: this.conversationKey,
        key,
      });
      this.hasLoggedMissingMemoryFile = true;
    }

    return null;
  }

  private conversationLeaseKey(): string {
    return conversationLeaseKey(this.conversationKey);
  }

  filesystemNamespace(): string {
    const logicalNamespace = this.agentConfig.workspace?.memory?.namespace ?? this.conversationKey;
    const accountScope = this.accountId && this.agentId ? `${this.accountId}:${this.agentId}` : this.accountId;
    const scopedNamespace = accountScope
      ? `${accountScope}:${logicalNamespace}`
      : logicalNamespace;

    return normalizeFilesystemNamespace(scopedNamespace);
  }

  private isWorkspaceEnabled(): boolean {
    return this.agentConfig.workspace?.enabled === true;
  }

  private isWorkspaceHarnessEnabled(): boolean {
    return this.isWorkspaceEnabled() && this.agentConfig.workspace?.harness?.enabled !== false;
  }

  private isSkillPublishEnabled(): boolean {
    return this.agentConfig.skills?.publish?.enabled === true;
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
          const agent = await getStorage().agents.getById(this.accountId!, agentId);
          if (!agent || agent.status !== "active") {
            return null;
          }

          return {
            agentId: agent.agentId,
            name: agent.name,
            ...(agent.description ? { description: agent.description } : {}),
          };
        }),
      ).then((metadata) => metadata.filter((entry): entry is SubagentMetadata => entry !== null));
    }

    return this.subagentMetadataPromise;
  }
}

function formatMemorySystemPrompt(memoryContent: string): string {
  const normalizedContent = memoryContent.trimEnd();
  return normalizedContent.length > 0
    ? `Current MEMORY.md content for this conversation:\n\n${normalizedContent}`
    : "Current MEMORY.md content for this conversation:\n\n(MEMORY.md exists but is empty)";
}

function workspaceRootFromConfig(sandboxConfig: WorkspaceSandboxConfig): string {
  const options = sandboxConfig.options && typeof sandboxConfig.options === "object" && !Array.isArray(sandboxConfig.options)
    ? sandboxConfig.options
    : {};
  const root = options.workspaceRoot;
  return typeof root === "string" && root.trim() ? root.trim() : "/mnt/workspaces";
}

function formatWorkspaceHarnessSystemPrompt(namespace: string): string {
  return `<workspace_harness>
Workspace is enabled. Use bash to work with the mounted filesystem rooted at /.

Workspace namespace:
${namespace}

Guidance:
1. Create, read, edit, move, and delete ordinary workspace files with bash commands.
2. Use MEMORY.md for durable project facts, decisions, conventions, and context that should survive long-running work.
3. Use TASKS.md or focused task markdown files for plans and progress tracking when that helps the work stay aligned.
4. Treat MEMORY.md and task files as normal workspace files: inspect them with bash before relying on them, update them when useful, and keep them concise.
5. Run code from workspace files instead of inline execution flags.
</workspace_harness>`;
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
4. If load_skill does not return a sandbox path, use the skill as read-only context; skill files can be edited or executed only when sandbox is enabled and the bundle is staged.
</skills>`;
}

function formatSubagentSystemPrompt(subagents: SubagentMetadata[]): string {
  const hasPredefinedSubagents = subagents.length > 0;
  const predefined = hasPredefinedSubagents
    ? subagents
      .map((agent) => {
        const description = agent.description?.trim() || "No description provided.";
        return `- ${agent.agentId} (${agent.name}): ${description}`;
      })
      .join("\n")
    : "- No predefined subagents are configured. Omit agentId to run a virtual one-shot subagent.";

  return `<subagent_system>
Use run_subagent to dispatch independent work that can continue while you keep working. The tool returns task ids immediately; results are injected into this conversation when the child work finishes.

Available predefined subagents:
${predefined}

Tool guidance:
1. Use the exact agentId from the predefined list when a listed subagent is suitable for the task.
2. Omit agentId only when no predefined subagent is suitable or the user explicitly asks for a virtual one-shot subagent.
3. A virtual one-shot subagent uses this agent's model and tool configuration.
</subagent_system>`;
}

// DynamoDB row decoding.

function normalizeSystemMessage(message: SystemModelMessage): SystemModelMessage {
  return systemModelMessageSchema.parse({
    role: "system",
    content: message.content,
  });
}

function itemToStoredConversationEntry(item: Record<string, AttributeValue>): StoredConversationEntry | null {
  const createdAt = item.createdAt?.S;
  if (!createdAt) {
    return null;
  }

  const event = item.event ? normalizeStoredConversationEvent(fromAttributeValue(item.event)) : null;
  return event ? { createdAt, event } : null;
}

function normalizeStoredConversationEvent(value: unknown): StoredConversationEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as {
    sourceEventId?: string;
    message?: unknown;
  };

  if (typeof candidate.sourceEventId !== "string") {
    return null;
  }

  const parsedMessage = modelMessageSchema.safeParse(candidate.message);
  return parsedMessage.success
    ? createStoredEventFromModelMessage(parsedMessage.data, candidate.sourceEventId)
    : null;
}

// Message persistence sanitization.

function createStoredEventFromModelMessage(
  message: ModelMessage | undefined,
  sourceEventId: string,
): StoredConversationEvent | null {
  if (!message) {
    return null;
  }

  switch (message.role) {
    case "user":
      return toStoredConversationEvent(sanitizeUserMessage(message), sourceEventId);
    case "assistant":
      return toStoredConversationEvent(sanitizeAssistantMessage(message), sourceEventId);
    case "tool":
      return toStoredConversationEvent(sanitizeToolMessage(message), sourceEventId);
    case "system":
      return toStoredConversationEvent(normalizeSystemMessage(message), sourceEventId);
    default:
      return null;
  }
}

function toStoredConversationEvent<TMessage extends StoredConversationEvent["message"]>(
  message: TMessage | null,
  sourceEventId: string,
): StoredConversationEventBase<TMessage> | null {
  return message ? {
    version: 1,
    sourceEventId,
    message,
  } : null;
}

// Conversation projection.

function projectEntriesToMessages(entries: StoredConversationEntry[]): ModelMessage[] {
  return entries.flatMap(({ event }) => {
    switch (event.message.role) {
      case "system":
        return [];
      case "user":
      case "assistant":
      case "tool":
        return [event.message];
    }
  });
}

function projectSystemContextMessages(entries: StoredConversationEntry[]): SystemModelMessage[] {
  const latestCompactionIndex = findLatestCompactionSummaryIndex(entries);

  return entries.flatMap(({ event }, index) => {
    if (event.message.role !== "system") {
      return [];
    }

    if (isCompactionSummaryMessage(event.message)) {
      return index === latestCompactionIndex ? [event.message] : [];
    }

    return latestCompactionIndex === -1 || index > latestCompactionIndex ? [event.message] : [];
  });
}

function createSystemContextSnapshot(entries: StoredConversationEntry[]): SystemContextSnapshot {
  const systemEntries = entriesSinceLatestCompactionSummary(entries);

  return {
    cursor: systemEntries.at(-1)?.createdAt ?? entries.at(-1)?.createdAt ?? null,
    messages: projectSystemContextMessages(systemEntries),
  };
}

function projectActiveConversationEntries(entries: StoredConversationEntry[]): StoredConversationEntry[] {
  const latestCompactionIndex = findLatestCompactionSummaryIndex(entries);
  return latestCompactionIndex === -1 ? entries : entries.slice(latestCompactionIndex + 1);
}

// Compaction resume support.

export function selectPostCompactionPendingMessages(messages: ModelMessage[]): ModelMessage[] {
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
  const approvalRequestMessages = messages.filter((message): message is AssistantModelMessage =>
    message.role === "assistant" &&
    typeof message.content !== "string" &&
    message.content.some((part) => part.type === "tool-approval-request" && approvalIds.has(part.approvalId))
  );

  return approvalRequestMessages.length > 0
    ? [...approvalRequestMessages, lastMessage]
    : [lastMessage];
}

function entriesSinceLatestCompactionSummary(entries: StoredConversationEntry[]): StoredConversationEntry[] {
  const latestCompactionIndex = findLatestCompactionSummaryIndex(entries);
  return latestCompactionIndex === -1 ? entries : entries.slice(latestCompactionIndex);
}

function findLatestCompactionSummaryIndex(entries: StoredConversationEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.event.message;
    if (message?.role === "system" && isCompactionSummaryMessage(message)) {
      return index;
    }
  }

  return -1;
}

/**
 * Filters user message to only text content parts.
 */
function sanitizeUserMessage(message: UserModelMessage): UserModelMessage | null {
  if (typeof message.content === "string") {
    return message;
  }

  const content = message.content.filter((part) => part.type === "text");
  return content.length > 0 ? { ...message, content } : null;
}

/**
 * Filters assistant message to only persisted content parts.
 */
function sanitizeAssistantMessage(message: AssistantModelMessage): AssistantModelMessage | null {
  if (typeof message.content === "string") {
    return message;
  }

  const content = message.content.filter(isPersistedAssistantContentPart);

  return content.length > 0 ? { ...message, content } : null;
}

/**
 * Filters tool message to only persisted content parts.
 */
function sanitizeToolMessage(message: ToolModelMessage): ToolModelMessage | null {
  const content = message.content.filter(isPersistedToolContentPart);

  return content.length > 0 ? { ...message, content } : null;
}

/**
 * Checks if assistant content part should be persisted.
 */
function isPersistedAssistantContentPart(
  part: Exclude<AssistantModelMessage["content"], string>[number],
): boolean {
  return part.type === "text" ||
    part.type === "tool-call" ||
    part.type === "tool-approval-request" ||
    part.type === "tool-result";
}

/**
 * Checks if tool content part should be persisted.
 */
function isPersistedToolContentPart(
  part: ToolModelMessage["content"][number],
): boolean {
  return part.type === "tool-approval-response" || part.type === "tool-result";
}

function isToolApprovalResponseMessage(message: ModelMessage | undefined): message is ToolModelMessage {
  return message?.role === "tool" &&
    message.content.length > 0 &&
    message.content.every((part) => part.type === "tool-approval-response");
}

function loadEnvironmentContextPrompt(): string {
  return `Current time: ${new Date().toISOString()}.\n\nCurrent timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
}
