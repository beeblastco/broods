/**
 * Account-scoped data cleanup across runtime stores.
 * Keep destructive account teardown logic here so account APIs stay small.
 */

import {
  BatchWriteItemCommand,
  ScanCommand,
  type AttributeValue,
  type WriteRequest,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type ObjectIdentifier,
} from "@aws-sdk/client-s3";
import type { AccountRecord } from "./accounts.ts";
import { dynamo } from "./dynamo.ts";
import { optionalEnv } from "./env.ts";
import { normalizeFilesystemNamespace } from "./filesystem-namespace.ts";

const ACCOUNT_NAMESPACE_PREFIX = "acct:";
const DYNAMO_BATCH_WRITE_LIMIT = 25;
const S3_DELETE_OBJECT_LIMIT = 1000;

const s3 = new S3Client({ region: process.env.AWS_REGION });

export interface AccountCleanupSummary {
  conversationsDeleted: number;
  processedEventsDeleted: number;
  asyncResultsDeleted: number;
  filesystemObjectsDeleted: number;
}

interface ConversationReference {
  conversationKey: string;
}

export async function deleteAccountRuntimeData(account: AccountRecord): Promise<AccountCleanupSummary> {
  const accountPrefix = accountScopedPrefix(account.accountId);
  const conversations = await scanConversationReferences(accountPrefix);
  const filesystemNamespaces = resolveFilesystemNamespaces(account, conversations);

  const [
    conversationsDeleted,
    processedEventsDeleted,
    asyncResultsDeleted,
    filesystemObjectsDeleted,
  ] = await Promise.all([
    deleteConversations(accountPrefix),
    deleteProcessedEvents(accountPrefix),
    deleteAsyncResults(accountPrefix),
    deleteFilesystemNamespaces(filesystemNamespaces),
  ]);

  return {
    conversationsDeleted,
    processedEventsDeleted,
    asyncResultsDeleted,
    filesystemObjectsDeleted,
  };
}

async function scanConversationReferences(accountPrefix: string): Promise<ConversationReference[]> {
  const tableName = conversationsTableName();
  if (!tableName) {
    return [];
  }

  const references: ConversationReference[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(new ScanCommand({
      TableName: tableName,
      ProjectionExpression: "conversationKey",
      FilterExpression: "begins_with(conversationKey, :accountPrefix)",
      ExpressionAttributeValues: {
        ":accountPrefix": { S: accountPrefix },
      },
      ExclusiveStartKey: exclusiveStartKey,
    }));

    for (const item of result.Items ?? []) {
      const conversationKey = item.conversationKey?.S;
      if (conversationKey) {
        references.push({ conversationKey });
      }
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return references;
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

async function deleteAsyncResults(accountPrefix: string): Promise<number> {
  const tableName = optionalEnv("ASYNC_RESULTS_TABLE_NAME");
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

function resolveFilesystemNamespaces(
  account: AccountRecord,
  conversations: ConversationReference[],
): string[] {
  const logicalNamespaces = new Set<string>();
  const accountPrefix = accountScopedPrefix(account.accountId);

  if (account.config.workspace?.memory?.namespace) {
    logicalNamespaces.add(account.config.workspace.memory.namespace);
  }

  for (const { conversationKey } of conversations) {
    if (!conversationKey.startsWith(accountPrefix)) {
      continue;
    }

    logicalNamespaces.add(conversationKey);
  }

  return [...logicalNamespaces].map((logicalNamespace) =>
    normalizeFilesystemNamespace(`${account.accountId}:${logicalNamespace}`)
  );
}

async function deleteFilesystemNamespaces(namespaces: string[]): Promise<number> {
  const bucketName = optionalEnv("FILESYSTEM_BUCKET_NAME");
  if (!bucketName) {
    return 0;
  }

  let deleted = 0;
  for (const namespace of namespaces) {
    deleted += await deleteS3Prefix(bucketName, `${namespace}/`);
  }

  return deleted;
}

async function deleteS3Prefix(bucketName: string, prefix: string): Promise<number> {
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

    const objects = (listed.Contents ?? [])
      .map((item): ObjectIdentifier | null => item.Key ? { Key: item.Key } : null)
      .filter((item): item is ObjectIdentifier => item !== null);

    for (let index = 0; index < objects.length; index += S3_DELETE_OBJECT_LIMIT) {
      const chunk = objects.slice(index, index + S3_DELETE_OBJECT_LIMIT);
      if (chunk.length === 0) {
        continue;
      }

      await s3.send(new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: {
          Objects: chunk,
          Quiet: true,
        },
      }));
      deleted += chunk.length;
    }

    continuationToken = listed.NextContinuationToken;
  } while (continuationToken);

  return deleted;
}

function accountScopedPrefix(accountId: string): string {
  return `${ACCOUNT_NAMESPACE_PREFIX}${accountId}:`;
}

function conversationsTableName(): string | undefined {
  return optionalEnv("CONVERSATIONS_TABLE_NAME");
}
