/**
 * Webhook/event dedupe store. Always DynamoDB regardless of STORAGE_PROVIDER —
 * the TTL + conditional-write semantics don't model cleanly in Convex.
 * Keep this interface narrow and separate from StorageProvider.
 */

import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { dynamo, isConditionalCheckFailed } from "./dynamo/client.ts";
import { requireEnv } from "../env.ts";

export interface DedupeStore {
  /**
   * Atomically claim an event id. Returns true if this caller won the claim,
   * false if the id was already recorded (duplicate delivery).
   */
  claim(eventId: string, ttlSeconds?: number): Promise<boolean>;
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 24h

class DynamoDedupeStore implements DedupeStore {
  async claim(eventId: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<boolean> {
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    try {
      await dynamo.send(
        new PutItemCommand({
          TableName: requireEnv("PROCESSED_EVENTS_TABLE_NAME"),
          Item: {
            eventId: { S: eventId },
            expiresAt: { N: String(expiresAt) },
          },
          ConditionExpression: "attribute_not_exists(eventId)",
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  }
}

let cached: DedupeStore | null = null;

export function getDedupeStore(): DedupeStore {
  if (!cached) cached = new DynamoDedupeStore();
  return cached;
}
