/**
 * Maps a workspace namespace to the reserved provider sandbox id so a later
 * request reconnects instead of creating a new one. Only daytona/e2b need it
 * (kubernetes derives its Sandbox name from the namespace). DynamoDB-backed with
 * a TTL, refreshed on each reconnect.
 */

import { DeleteItemCommand, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { dynamo, isConditionalCheckFailed } from "../../_shared/storage/dynamo/client.ts";
import { requireEnv } from "../../_shared/env.ts";
import type { SandboxProvider } from "./types.ts";

const TTL_SECONDS = 30 * 24 * 60 * 60;

const instanceKey = (provider: SandboxProvider, namespace: string) => `${provider}:${namespace}`;
const tableName = () => requireEnv("PERSISTENT_SANDBOX_INSTANCE_TABLE_NAME");

function instanceItem(provider: SandboxProvider, namespace: string, externalId: string) {
  return {
    instanceKey: { S: instanceKey(provider, namespace) },
    externalId: { S: externalId },
    expiresAt: { N: String(Math.floor(Date.now() / 1000) + TTL_SECONDS) },
  };
}

export async function getSandboxExternalId(provider: SandboxProvider, namespace: string): Promise<string | null> {
  const result = await dynamo.send(new GetItemCommand({
    TableName: tableName(),
    Key: { instanceKey: { S: instanceKey(provider, namespace) } },
    ConsistentRead: true,
  }));
  return result.Item?.externalId?.S ?? null;
}

/**
 * Record a freshly created sandbox, but only if no instance is mapped yet.
 * Returns false when another concurrent call already claimed this namespace, so
 * the loser can discard its duplicate sandbox and reconnect to the winner.
 */
export async function claimSandboxInstance(provider: SandboxProvider, namespace: string, externalId: string): Promise<boolean> {
  try {
    await dynamo.send(new PutItemCommand({
      TableName: tableName(),
      Item: instanceItem(provider, namespace, externalId),
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
export async function saveSandboxInstance(provider: SandboxProvider, namespace: string, externalId: string): Promise<void> {
  await dynamo.send(new PutItemCommand({
    TableName: tableName(),
    Item: instanceItem(provider, namespace, externalId),
  }));
}

export async function deleteSandboxInstance(provider: SandboxProvider, namespace: string): Promise<void> {
  await dynamo.send(new DeleteItemCommand({
    TableName: tableName(),
    Key: { instanceKey: { S: instanceKey(provider, namespace) } },
  }));
}
