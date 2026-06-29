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
import type { AccountRecord, SandboxConfig } from "../_shared/storage/index.ts";
import { getStorage } from "../_shared/storage/index.ts";
import { deleteS3Prefix as deleteBunS3Prefix } from "../_shared/s3.ts";
import { workspaceNamespacePrefix } from "../_shared/sandbox.ts";
import { dynamo } from "../_shared/storage/dynamo/client.ts";
import { optionalEnv } from "../_shared/env.ts";
import { accountScopedPrefix } from "../_shared/runtime-keys.ts";
import { workspaceNamespace } from "../_shared/workspaces.ts";
import { WorkdirSandboxExecutor } from "../harness-processing/sandbox/workdir-executor.ts";
import { MicrovmSandboxExecutor } from "../harness-processing/sandbox/microvm-executor.ts";
import { DaytonaSandboxExecutor } from "../harness-processing/sandbox/daytona-executor.ts";
import { E2BSandboxExecutor } from "../harness-processing/sandbox/e2b-executor.ts";
import { VercelSandboxExecutor } from "../harness-processing/sandbox/vercel-executor.ts";
import { deleteSandboxInstance } from "../harness-processing/sandbox/instance-store.ts";
import { removeSandboxInstance } from "../_shared/storage/convex/sandbox-instances.ts";
import { logWarn } from "../_shared/log.ts";

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
    reservedSandboxesReleased,
  };
}

/**
 * Clean delete of reserved sandboxes for the given workspace namespaces.
 * Sandbox (workdir)/Lambda MicroVM/Daytona/E2B/Vercel are torn down explicitly via credentials read
 * from the decrypted sandbox config. Idempotent: a namespace with no reserved sandbox
 * is a cheap no-op.
 *
 * An account may hold several persistent configs of the same provider (different
 * keys), and the instance record does not say which one created a sandbox, so we
 * try every same-provider config until one succeeds; release() only drops the
 * instance row when the sandbox is actually gone, so a wrong-credential attempt
 * doesn't lose the chance for the right one.
 */
export async function releaseReservedSandboxes(accountId: string, namespaces: string[]): Promise<number> {
  if (namespaces.length === 0) {
    return 0;
  }
  const configs = await getStorage().sandboxConfigs.list(accountId).catch(() => []);
  const persistent = configs.map((record) => record.config).filter((config) => config.persistent === true);
  const sandbox = persistent.filter((config) => config.provider === "sandbox");
  const lambda = persistent.filter((config) => config.provider === "lambda");
  const daytona = persistent.filter((config) => config.provider === "daytona");
  const e2b = persistent.filter((config) => config.provider === "e2b");
  const vercel = persistent.filter((config) => config.provider === "vercel");

  let released = 0;
  for (const namespace of namespaces) {
    if (await releaseFromConfigs("sandbox", sandbox, namespace)) released++;
    if (await releaseFromConfigs("lambda", lambda, namespace)) released++;
    if (await releaseFromConfigs("daytona", daytona, namespace)) released++;
    if (await releaseFromConfigs("e2b", e2b, namespace)) released++;
    if (await releaseFromConfigs("vercel", vercel, namespace)) released++;
    // Drop any orphaned instance rows (e.g. all configs deleted, or none owned it).
    await deleteSandboxInstance("sandbox", namespace).catch(() => {});
    await deleteSandboxInstance("lambda", namespace).catch(() => {});
    await deleteSandboxInstance("daytona", namespace).catch(() => {});
    await deleteSandboxInstance("e2b", namespace).catch(() => {});
    await deleteSandboxInstance("vercel", namespace).catch(() => {});
    // Mirror removal into Convex (reservationKey == namespace; provider-agnostic).
    await removeSandboxInstance(accountId, namespace);
  }
  return released;
}

/**
 * Release reserved sandbox/lambda/daytona/e2b/vercel sandboxes created from a single config,
 * across all of the account's workspace namespaces. Called when that sandbox config is
 * deleted, while its credentials are still readable.
 */
export async function releaseSandboxConfigInstances(accountId: string, config: SandboxConfig): Promise<number> {
  if (config.persistent !== true || (config.provider !== "sandbox" && config.provider !== "lambda" && config.provider !== "daytona" && config.provider !== "e2b" && config.provider !== "vercel")) {
    return 0;
  }
  const workspaceConfigs = await getStorage().workspaceConfigs.list(accountId).catch(() => []);
  let released = 0;
  for (const workspace of workspaceConfigs) {
    const namespace = workspaceNamespace(accountId, workspace.workspaceId);
    if (await releaseFromConfigs(config.provider, [config], namespace)) released++;
  }
  return released;
}

async function releaseFromConfigs(
  provider: "sandbox" | "lambda" | "daytona" | "e2b" | "vercel",
  configs: SandboxConfig[],
  namespace: string,
): Promise<boolean> {
  for (const config of configs) {
    try {
      const executor = provider === "sandbox"
        ? new WorkdirSandboxExecutor(config)
        : provider === "lambda"
        ? new MicrovmSandboxExecutor(config)
        : provider === "daytona"
        ? new DaytonaSandboxExecutor(config)
        : provider === "e2b"
        ? new E2BSandboxExecutor(config)
        : new VercelSandboxExecutor(config);
      await executor.release({ namespace });
      return true;
    } catch (error) {
      logWarn("Reserved sandbox release failed", {
        provider,
        namespace,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return false;
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
