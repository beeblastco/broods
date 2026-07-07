/**
 * Maps a sandbox reservation key to the reserved provider sandbox id so a later
 * request reconnects instead of creating a new one. Used by daytona/e2b/vercel
 * (workdir derives its sandbox name directly from the key). DynamoDB-backed
 * with a TTL, refreshed on each reconnect.
 */

import { DeleteItemCommand, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { dynamo, isConditionalCheckFailed } from "../../shared/storage/dynamo/client.ts";
import { requireEnv } from "../../shared/env.ts";
import type { SandboxProvider } from "./types.ts";

const TTL_SECONDS = 30 * 24 * 60 * 60;

const instanceKey = (provider: SandboxProvider, reservationKey: string) => `${provider}:${reservationKey}`;
const tableName = () => requireEnv("PERSISTENT_SANDBOX_INSTANCE_TABLE_NAME");

function instanceItem(provider: SandboxProvider, reservationKey: string, externalId: string) {
  return {
    instanceKey: { S: instanceKey(provider, reservationKey) },
    externalId: { S: externalId },
    expiresAt: { N: String(Math.floor(Date.now() / 1000) + TTL_SECONDS) },
  };
}

export async function getSandboxExternalId(provider: SandboxProvider, reservationKey: string): Promise<string | null> {
  const result = await dynamo.send(new GetItemCommand({
    TableName: tableName(),
    Key: { instanceKey: { S: instanceKey(provider, reservationKey) } },
    ConsistentRead: true,
  }));
  return result.Item?.externalId?.S ?? null;
}

/**
 * Record a freshly created sandbox, but only if no instance is mapped yet.
 * Returns false when another concurrent call already claimed this reservation, so
 * the loser can discard its duplicate sandbox and reconnect to the winner.
 */
export async function claimSandboxInstance(provider: SandboxProvider, reservationKey: string, externalId: string): Promise<boolean> {
  try {
    await dynamo.send(new PutItemCommand({
      TableName: tableName(),
      Item: instanceItem(provider, reservationKey, externalId),
      ConditionExpression: "attribute_not_exists(instanceKey)",
    }));
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return false;
    }
    throw err;
  }
}

// Refresh the mapping + TTL for an existing instance (reconnect path).
export async function saveSandboxInstance(provider: SandboxProvider, reservationKey: string, externalId: string): Promise<void> {
  await dynamo.send(new PutItemCommand({
    TableName: tableName(),
    Item: instanceItem(provider, reservationKey, externalId),
  }));
}

/**
 * Drop a reservation mapping. When `expectedExternalId` is given the delete is
 * conditional on the row still pointing at that sandbox, so a concurrent call
 * that already re-claimed the reservation with a fresh sandbox keeps its row
 * (deleting it would orphan the new sandbox at the provider).
 */
export async function deleteSandboxInstance(provider: SandboxProvider, reservationKey: string, expectedExternalId?: string): Promise<void> {
  try {
    await dynamo.send(new DeleteItemCommand({
      TableName: tableName(),
      Key: { instanceKey: { S: instanceKey(provider, reservationKey) } },
      ...(expectedExternalId
        ? {
          ConditionExpression: "externalId = :expected",
          ExpressionAttributeValues: { ":expected": { S: expectedExternalId } },
        }
        : {}),
    }));
  } catch (err) {
    if (expectedExternalId && isConditionalCheckFailed(err)) {
      return;
    }
    throw err;
  }
}
