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
import type { AccountRecord } from "../_shared/accounts.ts";
import { listAgents, type AgentRecord } from "../_shared/agents.ts";
import { deleteS3Prefix as deleteBunS3Prefix } from "../_shared/s3.ts";
import { dynamo } from "../_shared/dynamo.ts";
import { optionalEnv } from "../_shared/env.ts";
import {
  accountScopedPrefix,
  normalizeFilesystemNamespace,
} from "../_shared/runtime-keys.ts";

const DYNAMO_BATCH_WRITE_LIMIT = 25;

export interface AccountCleanupSummary {
  conversationsDeleted: number;
  processedEventsDeleted: number;
  asyncAgentResultDeleted: number;
  asyncToolResultDeleted: number;
  filesystemObjectsDeleted: number;
}

interface ConversationReference {
  conversationKey: string;
}

export async function deleteAccountRuntimeData(account: AccountRecord): Promise<AccountCleanupSummary> {
  const accountPrefix = accountScopedPrefix(account.accountId);
  const [conversations, agents] = await Promise.all([
    scanConversationReferences(accountPrefix),
    listAgents(account.accountId).catch(() => []),
  ]);
  const filesystemNamespaces = resolveFilesystemNamespaces(account, agents, conversations);

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

  return {
    conversationsDeleted,
    processedEventsDeleted,
    asyncAgentResultDeleted,
    asyncToolResultDeleted,
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

function resolveFilesystemNamespaces(
  account: AccountRecord,
  agents: AgentRecord[],
  conversations: ConversationReference[],
): string[] {
  const logicalNamespaces = new Set<string>();
  const accountPrefix = accountScopedPrefix(account.accountId);

  if (account.config.workspace?.memory?.namespace) {
    logicalNamespaces.add(account.config.workspace.memory.namespace);
  }

  for (const agent of agents) {
    if (agent.config.workspace?.memory?.namespace) {
      logicalNamespaces.add(`${agent.agentId}:${agent.config.workspace.memory.namespace}`);
    }
  }

  for (const { conversationKey } of conversations) {
    if (!conversationKey.startsWith(accountPrefix)) {
      continue;
    }

    const agentMatch = conversationKey.match(/^acct:[^:]+:agent:([^:]+):/);
    logicalNamespaces.add(agentMatch?.[1] ? `${agentMatch[1]}:${conversationKey}` : conversationKey);
  }

  return [...logicalNamespaces].map((logicalNamespace) => {
    const [maybeAgentId, ...rest] = logicalNamespace.split(":");
    return maybeAgentId?.startsWith("agent_") && rest.length > 0
      ? normalizeFilesystemNamespace(`${account.accountId}:${maybeAgentId}:${rest.join(":")}`)
      : normalizeFilesystemNamespace(`${account.accountId}:${logicalNamespace}`);
  });
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
  return deleteBunS3Prefix(bucketName, prefix);
}

function conversationsTableName(): string | undefined {
  return optionalEnv("CONVERSATIONS_TABLE_NAME");
}
