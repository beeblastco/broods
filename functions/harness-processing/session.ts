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
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
import type { AccountConfig } from "../_shared/accounts.ts";
import {
  dynamo,
  fromAttributeValue,
  isConditionalCheckFailed,
  toAttributeValue,
} from "../_shared/dynamo.ts";
import { requireEnv } from "../_shared/env.ts";
import {
  conversationLeaseKey,
  normalizeFilesystemNamespace,
} from "../_shared/filesystem-namespace.ts";
import { logError, logInfo } from "../_shared/log.ts";
import { compactSessionContext, isCompactionSummaryMessage } from "./compaction.ts";
import { pruneSessionMessages } from "./pruning.ts";

const CONVERSATIONS_TABLE_NAME = requireEnv("CONVERSATIONS_TABLE_NAME");
const PROCESSED_EVENTS_TABLE_NAME = requireEnv("PROCESSED_EVENTS_TABLE_NAME");
const FILESYSTEM_BUCKET_NAME = requireEnv("FILESYSTEM_BUCKET_NAME");

// Default conversation lease TTL of 15 minutes.
const CONVERSATION_LEASE_TTL_SECONDS = 15 * 60;

const s3 = new S3Client({ region: process.env.AWS_REGION });

export type ConversationIngressEvent =
  | UserModelMessage
  | AssistantModelMessage
  | ToolModelMessage
  | (SystemModelMessage & { persist?: boolean });

export interface TurnContextSnapshot {
  messages: ModelMessage[];
  system: SystemModelMessage[];
  ephemeralSystem: SystemModelMessage[];
  hasPendingUserMessage: boolean;
  // Cursor-backed prompt state that prepareStep can refresh incrementally mid-run.
  promptContext: PromptContextSnapshot;
}

export interface PromptContextSnapshot {
  // Highest conversation row already folded into the dynamic system-context view.
  cursor: string | null;
  // Persisted system-role events accumulated up to cursor.
  messages: SystemModelMessage[];
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

export class Session {
  private messageSequence = 0;
  private hasLoggedMissingMemoryFile = false;

  constructor(
    public readonly eventId: string,
    public readonly conversationKey: string,
    public readonly accountId: string | undefined,
    private readonly accountConfig: AccountConfig = {},
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
    const promptContext = createPromptContextSnapshot(entries);
    let messages = projectEntriesToMessages(activeEntries);
    const system = await this.buildSystemPromptParts(promptContext.messages, ephemeralSystem);

    const compactionSummary = await compactSessionContext({
      conversationKey: this.conversationKey,
      system,
      messages,
      accountConfig: this.accountConfig,
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
      const compactedPromptContext = {
        cursor: summaryCursor ?? promptContext.cursor,
        messages: [compactionSummary],
      };
      messages = messages.at(-1)?.role === "user" ? [messages.at(-1)!] : [];

      return {
        messages: pruneSessionMessages(messages, this.accountConfig),
        system: await this.buildSystemPromptParts(compactedPromptContext.messages, ephemeralSystem),
        ephemeralSystem,
        hasPendingUserMessage: messages.at(-1)?.role === "user",
        promptContext: compactedPromptContext,
      };
    }

    messages = pruneSessionMessages(messages, this.accountConfig);

    return {
      messages,
      system,
      ephemeralSystem,
      hasPendingUserMessage: messages.at(-1)?.role === "user",
      promptContext,
    };
  }

  async loadRefreshedSystemPromptParts(options: {
    promptContext: PromptContextSnapshot;
    ephemeralSystem?: SystemModelMessage[];
  }): Promise<{ promptContext: PromptContextSnapshot; system: SystemModelMessage[] }> {
    const promptContext = await this.refreshPromptContextSnapshot(options.promptContext);

    return {
      promptContext,
      system: await this.buildSystemPromptParts(promptContext.messages, options.ephemeralSystem ?? []),
    };
  }

  private async buildSystemPromptParts(
    promptMessages: SystemModelMessage[],
    ephemeralSystem: SystemModelMessage[] = [],
  ): Promise<SystemModelMessage[]> {
    const memoryContent = await this.loadMemoryFile();
    const memorySystem: SystemModelMessage[] = this.isWorkspaceEnabled()
      ? [{
        role: "system",
        content: formatMemorySystemPrompt(memoryContent),
      }]
      : [];

    return [
      {
        role: "system",
        content: loadEnvironmentContextPrompt(),
      },
      {
        role: "system",
        content: this.accountConfig.agent?.system ?? DEFAULT_SYSTEM_PROMPT,
      },
      ...memorySystem,
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

  private async refreshPromptContextSnapshot(
    snapshot: PromptContextSnapshot,
  ): Promise<PromptContextSnapshot> {
    const entries = await this.loadConversationEntries({
      afterCreatedAt: snapshot.cursor,
    });

    if (entries.length === 0) {
      return snapshot;
    }

    return {
      cursor: entries.at(-1)?.createdAt ?? snapshot.cursor,
      messages: [...snapshot.messages, ...projectPromptContextMessages(entries)],
    };
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

    const key = `${this.filesystemNamespace()}/MEMORY.md`;

    try {
      const response = await s3.send(new GetObjectCommand({
        Bucket: FILESYSTEM_BUCKET_NAME,
        Key: key,
      }));

      return await response.Body?.transformToString() ?? "";
    } catch (error) {
      if (!isMissingS3Object(error)) {
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
    const logicalNamespace = this.accountConfig.workspace?.memory?.namespace ?? this.conversationKey;
    const scopedNamespace = this.accountId
      ? `${this.accountId}:${logicalNamespace}`
      : logicalNamespace;

    return normalizeFilesystemNamespace(scopedNamespace);
  }

  private isWorkspaceEnabled(): boolean {
    return this.accountConfig.workspace?.enabled === true;
  }
}

export function createSession(
  eventId: string,
  conversationKey: string,
  accountId?: string,
  accountConfig: AccountConfig = {},
): Session {
  return new Session(eventId, conversationKey, accountId, accountConfig);
}

function formatMemorySystemPrompt(memoryContent: string | null): string {
  if (memoryContent == null) {
    return "Current MEMORY.md content for this conversation:\n\n(no MEMORY.md file exists yet)";
  }

  const normalizedContent = memoryContent.trimEnd();
  return normalizedContent.length > 0
    ? `Current MEMORY.md content for this conversation:\n\n${normalizedContent}`
    : "Current MEMORY.md content for this conversation:\n\n(MEMORY.md exists but is empty)";
}

/**
 * Normalizes system message to schema-compliant format.
 */
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

  const event = itemToStoredConversationEvent(item);
  return event ? { createdAt, event } : null;
}

function itemToStoredConversationEvent(item: Record<string, AttributeValue>): StoredConversationEvent | null {
  if (item.event) {
    return normalizeStoredConversationEvent(fromAttributeValue(item.event));
  }

  return null;
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

/**
 * Converts a model message to a stored conversation event. Since some model does not recieved the thinking message. For the next turn.
 * We need to omit that. For some model like Anthropic, this is not the case, we will need pass all the message to the next turn.
 */
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

/**
 * Wraps a message in a stored event structure.
 */
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

function projectPromptContextMessages(entries: StoredConversationEntry[]): SystemModelMessage[] {
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

function createPromptContextSnapshot(entries: StoredConversationEntry[]): PromptContextSnapshot {
  const promptEntries = latestCompactionAwareEntries(entries);

  return {
    cursor: promptEntries.at(-1)?.createdAt ?? entries.at(-1)?.createdAt ?? null,
    messages: projectPromptContextMessages(promptEntries),
  };
}

function projectActiveConversationEntries(entries: StoredConversationEntry[]): StoredConversationEntry[] {
  const latestCompactionIndex = findLatestCompactionSummaryIndex(entries);
  return latestCompactionIndex === -1 ? entries : entries.slice(latestCompactionIndex + 1);
}

function latestCompactionAwareEntries(entries: StoredConversationEntry[]): StoredConversationEntry[] {
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

function isMissingS3Object(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };

  return candidate.name === "NoSuchKey" ||
    candidate.Code === "NoSuchKey" ||
    candidate.name === "NotFound" ||
    candidate.$metadata?.httpStatusCode === 404;
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

function loadEnvironmentContextPrompt(): string {
  return `Knowledge cutoff: January 2025.\n\nCurrent time: ${new Date().toISOString()}.\n\nCurrent timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
}
