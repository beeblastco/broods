/**
 * Session lifecycle for harness-processing.
 * Keep dedupe, history reads, prompt memory loading, and conversation persistence here.
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
  UserContent,
  UserModelMessage,
} from "ai";
import {
  dynamo,
  fromAttributeValue,
  isConditionalCheckFailed,
  toAttributeValue,
} from "../_shared/dynamo.ts";
import { requireEnv } from "../_shared/env.ts";
import { logError, logInfo } from "../_shared/log.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../_shared/.generated/system-prompt.ts";
import { normalizeFilesystemNamespace } from "./utils.ts";

const CONVERSATIONS_TABLE_NAME = requireEnv("CONVERSATIONS_TABLE_NAME");
const PROCESSED_EVENTS_TABLE_NAME = requireEnv("PROCESSED_EVENTS_TABLE_NAME");
const FILESYSTEM_BUCKET_NAME = requireEnv("FILESYSTEM_BUCKET_NAME");

const s3 = new S3Client({ region: process.env.AWS_REGION });

export class Session {
  private messageSequence = 0;
  private hasLoggedMissingMemoryFile = false;

  constructor(
    public readonly eventId: string,
    public readonly conversationKey: string,
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

  async loadHistory(): Promise<ModelMessage[]> {
    const result = await dynamo.send(new QueryCommand({
      TableName: CONVERSATIONS_TABLE_NAME,
      KeyConditionExpression: "conversationKey = :conversationKey",
      ExpressionAttributeValues: {
        ":conversationKey": { S: this.conversationKey },
      },
      ConsistentRead: true,
      ScanIndexForward: true,
    }));

    return (result.Items ?? [])
      .map((item) => item.message)
      .filter((message): message is AttributeValue => message != null)
      .map((message) => fromAttributeValue(message) as ModelMessage)
      .map(sanitizeMessageForHistory)
      .filter((message): message is ModelMessage => message != null);
  }

  async persistUserMessage(content: UserContent): Promise<void> {
    await this.persistMessages([{
      role: "user",
      content,
    }]);
  }

  async persistModelMessages(messages: ModelMessage[]): Promise<void> {
    await this.persistMessages(messages);
  }

  async loadSystemPromptParts(): Promise<SystemModelMessage[]> {
    const memoryContent = await this.loadMemoryFile();

    return [
      {
        role: "system",
        content: DEFAULT_SYSTEM_PROMPT,
      },
      {
        role: "system",
        content: formatMemorySystemPrompt(memoryContent),
      },
    ];
  }

  private async persistMessages(messages: ModelMessage[]): Promise<void> {
    for (const message of messages) {
      const sanitizedMessage = sanitizeMessageForHistory(message);
      if (!sanitizedMessage) {
        continue;
      }

      await dynamo.send(new PutItemCommand({
        TableName: CONVERSATIONS_TABLE_NAME,
        Item: {
          conversationKey: { S: this.conversationKey },
          createdAt: { S: this.nextCreatedAt() },
          message: toAttributeValue(sanitizedMessage),
        },
      }));
    }
  }

  private nextCreatedAt(): string {
    const sequence = String(this.messageSequence).padStart(4, "0");
    this.messageSequence += 1;
    return `${new Date().toISOString()}#${this.eventId}#${sequence}`;
  }

  private async loadMemoryFile(): Promise<string | null> {
    const key = `${this.filesystemNamespace()}/MEMORY.md`;

    try {
      const response = await s3.send(new GetObjectCommand({
        Bucket: FILESYSTEM_BUCKET_NAME,
        Key: key,
      }));

      return await response.Body?.transformToString() ?? "";
    } catch (error) {
      if (isMissingS3Object(error)) {
        if (!this.hasLoggedMissingMemoryFile) {
          logInfo("No MEMORY.md found for session prompt", {
            conversationKey: this.conversationKey,
            key,
          });
          this.hasLoggedMissingMemoryFile = true;
        }
        return null;
      }

      logError("Failed to load MEMORY.md for session prompt", {
        conversationKey: this.conversationKey,
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private filesystemNamespace(): string {
    return normalizeFilesystemNamespace(this.conversationKey);
  }
}

export function createSession(eventId: string, conversationKey: string): Session {
  return new Session(eventId, conversationKey);
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

function sanitizeMessageForHistory(message: ModelMessage): ModelMessage | null {
  switch (message.role) {
    case "assistant":
      return sanitizeAssistantMessage(message);
    case "tool":
      return sanitizeToolMessage(message);
    case "user":
      return sanitizeUserMessage(message);
    default:
      return message;
  }
}

function sanitizeUserMessage(message: UserModelMessage): UserModelMessage | null {
  if (typeof message.content === "string") {
    return message;
  }

  const content = message.content.filter((part) => part.type === "text");
  return content.length > 0 ? { ...message, content } : null;
}

function sanitizeAssistantMessage(message: AssistantModelMessage): AssistantModelMessage | null {
  if (typeof message.content === "string") {
    return message;
  }

  const content: Exclude<AssistantModelMessage["content"], string> = [];

  for (const part of message.content) {
    if (part.type === "text" || part.type === "tool-call" || part.type === "tool-approval-request") {
      content.push(part);
      continue;
    }

    if (part.type === "tool-result") {
      content.push(part);
    }
  }

  return content.length > 0 ? { ...message, content } : null;
}

function sanitizeToolMessage(message: ToolModelMessage): ToolModelMessage | null {
  const content: ToolModelMessage["content"] = [];

  for (const part of message.content) {
    if (part.type === "tool-approval-response") {
      content.push(part);
      continue;
    }

    if (part.type === "tool-result") {
      content.push(part);
    }
  }

  return content.length > 0 ? { ...message, content } : null;
}
