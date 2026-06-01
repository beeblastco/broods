/**
 * Account deletion cleanup across runtime stores.
 * Keep destructive teardown next to account-management routes.
 */

import {
  BatchWriteItemCommand,
  ScanCommand,
  type AttributeValue,
  type WriteRequest,
} from "@aws-sdk/client-dynamodb";
import type { AccountRecord } from "../_shared/storage/index.ts";
import { getStorage } from "../_shared/storage/index.ts";
import { deleteS3Prefix as deleteBunS3Prefix } from "../_shared/s3.ts";
import { workspaceNamespacePrefix } from "../_shared/sandbox.ts";
import { dynamo } from "../_shared/storage/dynamo/client.ts";
import { optionalEnv } from "../_shared/env.ts";
import { accountScopedPrefix } from "../_shared/runtime-keys.ts";
import { workspaceNamespace } from "../_shared/workspaces.ts";

const DYNAMO_BATCH_WRITE_LIMIT = 25;

export interface AccountCleanupSummary {
  conversationsDeleted: number;
  processedEventsDeleted: number;
  asyncAgentResultDeleted: number;
  asyncToolResultDeleted: number;
  filesystemObjectsDeleted: number;
}

export async function deleteAccountRuntimeData(account: AccountRecord): Promise<AccountCleanupSummary> {
  const accountPrefix = accountScopedPrefix(account.accountId);
  // Workspaces are now standalone, account-scoped records. Their filesystem
  // namespace is derived from accountId:workspaceId (shared across agents).
  const workspaceConfigs = await getStorage().workspaceConfigs.list(account.accountId).catch(() => []);
  const filesystemNamespaces = workspaceConfigs.map((workspace) =>
    workspaceNamespace(account.accountId, workspace.workspaceId));

  const [
    conversationsDeleted,
    processedEventsDeleted,
    asyncAgentResultDeleted,
    asyncToolResultDeleted,
    filesystemObjectsDeleted,
  ] = await Promise.all([
    deleteConversations(accountPrefix),
    deleteProcessedEvents(accountPrefix),
    deleteAsyncAgentResult(accountPrefix),
    deleteAsyncToolResult(accountPrefix),
    deleteFilesystemNamespaces(filesystemNamespaces),
  ]);

  // Remove the account's sandbox + workspace config records.
  await Promise.all([
    getStorage().sandboxConfigs.removeAllForAccount(account.accountId).catch(() => 0),
    getStorage().workspaceConfigs.removeAllForAccount(account.accountId).catch(() => 0),
  ]);

  return {
    conversationsDeleted,
    processedEventsDeleted,
    asyncAgentResultDeleted,
    asyncToolResultDeleted,
    filesystemObjectsDeleted,
  };
}

async function deleteConversations(accountPrefix: string): Promise<number> {
  const tableName = conversationsTableName();
  if (!tableName) {
    return 0;
  }

  return scanAndBatchDelete({
    tableName,
    keyAttributes: ["conversationKey", "createdAt"],
    filterExpression: "begins_with(conversationKey, :accountPrefix)",
    expressionAttributeValues: {
      ":accountPrefix": { S: accountPrefix },
    },
  });
}

async function deleteProcessedEvents(accountPrefix: string): Promise<number> {
  const tableName = optionalEnv("PROCESSED_EVENTS_TABLE_NAME");
  if (!tableName) {
    return 0;
  }

  return scanAndBatchDelete({
    tableName,
    keyAttributes: ["eventId"],
    filterExpression: "begins_with(eventId, :accountPrefix) OR begins_with(conversationKey, :accountPrefix)",
    expressionAttributeValues: {
      ":accountPrefix": { S: accountPrefix },
    },
  });
}

async function deleteAsyncAgentResult(accountPrefix: string): Promise<number> {
  const tableName = optionalEnv("ASYNC_AGENT_RESULT_TABLE_NAME");
  if (!tableName) {
    return 0;
  }

  return scanAndBatchDelete({
    tableName,
    keyAttributes: ["eventId"],
    filterExpression: "begins_with(eventId, :accountPrefix) OR begins_with(conversationKey, :accountPrefix)",
    expressionAttributeValues: {
      ":accountPrefix": { S: accountPrefix },
    },
  });
}

async function deleteAsyncToolResult(accountPrefix: string): Promise<number> {
  const tableName = optionalEnv("ASYNC_TOOL_RESULT_TABLE_NAME");
  if (!tableName) {
    return 0;
  }

  return scanAndBatchDelete({
    tableName,
    keyAttributes: ["resultId"],
    filterExpression: "begins_with(parentEventId, :accountPrefix) OR begins_with(conversationKey, :accountPrefix)",
    expressionAttributeValues: {
      ":accountPrefix": { S: accountPrefix },
    },
  });
}

async function scanAndBatchDelete(options: {
  tableName: string;
  keyAttributes: string[];
  filterExpression: string;
  expressionAttributeValues: Record<string, AttributeValue>;
}): Promise<number> {
  let deleted = 0;
  let pending: WriteRequest[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(new ScanCommand({
      TableName: options.tableName,
      ProjectionExpression: options.keyAttributes.join(", "),
      FilterExpression: options.filterExpression,
      ExpressionAttributeValues: options.expressionAttributeValues,
      ExclusiveStartKey: exclusiveStartKey,
    }));

    for (const item of result.Items ?? []) {
      const key = projectKey(item, options.keyAttributes);
      if (!key) {
        continue;
      }

      pending.push({
        DeleteRequest: {
          Key: key,
        },
      });

      if (pending.length === DYNAMO_BATCH_WRITE_LIMIT) {
        deleted += await flushBatchDeletes(options.tableName, pending);
        pending = [];
      }
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  if (pending.length > 0) {
    deleted += await flushBatchDeletes(options.tableName, pending);
  }

  return deleted;
}

async function flushBatchDeletes(tableName: string, requests: WriteRequest[]): Promise<number> {
  let pending = requests;
  let deleted = 0;

  while (pending.length > 0) {
    const result = await dynamo.send(new BatchWriteItemCommand({
      RequestItems: {
        [tableName]: pending,
      },
    }));

    deleted += pending.length - (result.UnprocessedItems?.[tableName]?.length ?? 0);
    pending = result.UnprocessedItems?.[tableName] ?? [];
  }

  return deleted;
}

function projectKey(
  item: Record<string, AttributeValue>,
  keyAttributes: string[],
): Record<string, AttributeValue> | null {
  const key: Record<string, AttributeValue> = {};
  for (const attribute of keyAttributes) {
    const value = item[attribute];
    if (!value) {
      return null;
    }
    key[attribute] = value;
  }

  return key;
}

async function deleteFilesystemNamespaces(namespaces: string[]): Promise<number> {
  const bucketName = optionalEnv("FILESYSTEM_BUCKET_NAME");
  if (!bucketName) {
    return 0;
  }

  let deleted = 0;
  for (const namespace of namespaces) {
    deleted += await deleteS3Prefix(bucketName, `${workspaceNamespacePrefix(namespace)}/`);
  }

  return deleted;
}

async function deleteS3Prefix(bucketName: string, prefix: string): Promise<number> {
  return deleteBunS3Prefix(bucketName, prefix);
}

function conversationsTableName(): string | undefined {
  return optionalEnv("CONVERSATIONS_TABLE_NAME");
}
