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
import type { AccountRecord } from "../shared/storage/index.ts";
import { getStorage } from "../shared/storage/index.ts";
import { deleteS3Prefix as deleteBunS3Prefix } from "../shared/s3.ts";
import type { WorkspaceStorageConfig } from "../shared/storage/workspace-config.ts";
import { dynamo } from "../shared/storage/dynamo/client.ts";
import { optionalEnv } from "../shared/env.ts";
import { accountScopedPrefix } from "../shared/runtime-keys.ts";
import { workspaceNamespace } from "../shared/workspaces.ts";
import { releaseReservedSandboxes } from "../shared/sandbox-cleanup.ts";
import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "../harness/sandbox/s3-mount.ts";

const DYNAMO_BATCH_WRITE_LIMIT = 25;

export interface AccountCleanupSummary {
  conversationsDeleted: number;
  processedEventsDeleted: number;
  asyncAgentResultDeleted: number;
  asyncToolResultDeleted: number;
  filesystemObjectsDeleted: number;
  reservedSandboxesReleased: number;
}

export async function deleteAccountRuntimeData(account: AccountRecord): Promise<AccountCleanupSummary> {
  const accountPrefix = accountScopedPrefix(account.accountId);
  // Workspaces are now standalone, account-scoped records. Their filesystem
  // namespace is derived from accountId:workspaceId (shared across agents).
  const workspaceConfigs = await getStorage().workspaceConfigs.list(account.accountId).catch(() => []);
  const filesystemNamespaces = workspaceConfigs.map((workspace) =>
    workspaceNamespace(account.accountId, workspace.workspaceId));

  // Tear down reserved (persistent) sandboxes BEFORE removing the sandbox config
  // records — release reads the configs (for provider credentials).
  const reservedSandboxesReleased = await releaseReservedSandboxes(account.accountId, filesystemNamespaces);

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
    deleteWorkspaceFilesystems(account.accountId, workspaceConfigs),
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
    reservedSandboxesReleased,
  };
}

export async function deleteWorkspaceFilesystem(
  accountId: string,
  workspaceId: string,
  storage: WorkspaceStorageConfig | undefined,
): Promise<number> {
  if (!storage?.bucket && !optionalEnv("FILESYSTEM_BUCKET_NAME")) {
    return 0;
  }

  const namespace = workspaceNamespace(accountId, workspaceId);
  const target = await resolveS3ReadTarget(workspaceReadContext(storage, namespace));
  return deleteBunS3Prefix(target.bucket, target.prefix, target.access);
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

async function deleteWorkspaceFilesystems(
  accountId: string,
  workspaces: Array<{ workspaceId: string; config: { storage?: WorkspaceStorageConfig } }>,
): Promise<number> {
  let deleted = 0;
  for (const workspace of workspaces) {
    deleted += await deleteWorkspaceFilesystem(accountId, workspace.workspaceId, workspace.config.storage);
  }
  return deleted;
}

function conversationsTableName(): string | undefined {
  return optionalEnv("CONVERSATIONS_TABLE_NAME");
}
