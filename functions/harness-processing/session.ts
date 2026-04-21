// Session persistence for harness-processing: event dedupe plus conversation history reads and writes.
import {
  DeleteItemCommand,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import type { ModelMessage, UserContent } from "ai";
import { requireEnv } from "../_shared/env.ts";
import {
  dynamo,
  fromAttributeValue,
  isConditionalCheckFailed,
  toAttributeValue,
} from "../_shared/dynamo.ts";

const CONVERSATIONS_TABLE_NAME = requireEnv("CONVERSATIONS_TABLE_NAME");
const PROCESSED_EVENTS_TABLE_NAME = requireEnv("PROCESSED_EVENTS_TABLE_NAME");

export class Session {
  constructor(
    public readonly eventId: string,
    public readonly conversationKey: string,
  ) {}

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
      .map((message) => fromAttributeValue(message) as ModelMessage);
  }

  async persistUserMessage(content: UserContent): Promise<void> {
    await this.persistMessage({
      role: "user",
      content,
    });
  }

  async persistAssistantMessage(content: string): Promise<void> {
    await this.persistMessage({
      role: "assistant",
      content,
    });
  }

  private async persistMessage(message: ModelMessage): Promise<void> {
    await dynamo.send(new PutItemCommand({
      TableName: CONVERSATIONS_TABLE_NAME,
      Item: {
        conversationKey: { S: this.conversationKey },
        createdAt: { S: new Date().toISOString() },
        message: toAttributeValue(message),
      },
    }));
  }
}

export function createSession(eventId: string, conversationKey: string): Session {
  return new Session(eventId, conversationKey);
}
