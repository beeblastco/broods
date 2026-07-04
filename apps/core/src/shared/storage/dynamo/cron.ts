/**
 * DDB-backed cron CRUD. Normalization helpers live in
 * `../cron.ts` and are called at the create/update entry points so
 * both DynamoDB and Convex stores enforce the same input contract.
 */

import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { randomBytes } from "node:crypto";
import { dynamo, isConditionalCheckFailed } from "./client.ts";
import type { ModelMessage } from "ai";
import { requireEnv } from "../../env.ts";
import {
  normalizeCreateCronInput,
  normalizeSchedulerGroupName,
  normalizeUpdateCronInput,
  type CronLastStatus,
} from "../cron.ts";
import type {
  CreateCronInput,
  CronRecord,
  CronRunRecord,
  CronStatus,
  CronStore,
  UpdateCronInput,
} from "../types.ts";

const CRON_ID_PREFIX = "cron_";
const CRON_RUN_ID_PREFIX = "run_";
const CRON_RUN_SORT_PREFIX = "run#";
const SCHEDULE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function cronsTableName(): string {
  return requireEnv("CRONS_TABLE_NAME");
}

function createCronId(): string {
  return `${CRON_ID_PREFIX}${randomBytes(10).toString("hex")}`;
}

function createCronRunId(startedAt: string): string {
  return `${startedAt}#${CRON_RUN_ID_PREFIX}${randomBytes(10).toString("hex")}`;
}

function cronRunSortKey(cronId: string, startedAt: string, runId: string): string {
  return `${CRON_RUN_SORT_PREFIX}${cronId}#${startedAt}#${runId}`;
}

function cronRunSortPrefix(cronId: string): string {
  return `${CRON_RUN_SORT_PREFIX}${cronId}#`;
}

function createCronScheduleName(accountId: string, cronId: string): string {
  const name = `${accountId}-${cronId}`;
  if (!SCHEDULE_NAME_PATTERN.test(name)) {
    throw new Error("Generated cron schedule name is invalid");
  }
  return name;
}

function cronToItem(record: CronRecord): Record<string, AttributeValue> {
  return {
    accountId: { S: record.accountId },
    cronId: { S: record.cronId },
    name: { S: record.name },
    ...(record.description ? { description: { S: record.description } } : {}),
    agentId: { S: record.agentId },
    events: { S: JSON.stringify(record.events) },
    ...(record.conversationKey ? { conversationKey: { S: record.conversationKey } } : {}),
    scheduleExpression: { S: record.scheduleExpression },
    ...(record.timezone ? { timezone: { S: record.timezone } } : {}),
    status: { S: record.status },
    schedulerName: { S: record.schedulerName },
    schedulerGroupName: { S: record.schedulerGroupName },
    createdAt: { S: record.createdAt },
    updatedAt: { S: record.updatedAt },
    ...(record.lastInvokedAt ? { lastInvokedAt: { S: record.lastInvokedAt } } : {}),
    ...(record.lastStatus ? { lastStatus: { S: record.lastStatus } } : {}),
    ...(record.lastError ? { lastError: { S: record.lastError } } : {}),
  };
}

function cronRunToItem(record: CronRunRecord): Record<string, AttributeValue> {
  return {
    accountId: { S: record.accountId },
    cronId: { S: cronRunSortKey(record.cronId, record.startedAt, record.runId) },
    itemType: { S: "cronRun" },
    parentCronId: { S: record.cronId },
    runId: { S: record.runId },
    eventId: { S: record.eventId },
    conversationKey: { S: record.conversationKey },
    status: { S: record.status },
    ...(record.result !== undefined ? { result: { S: JSON.stringify(record.result) } } : {}),
    ...(record.error ? { error: { S: record.error } } : {}),
    startedAt: { S: record.startedAt },
    ...(record.completedAt ? { completedAt: { S: record.completedAt } } : {}),
  };
}

function parseEvents(value: string | undefined): ModelMessage[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value);

    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as ModelMessage[]) : undefined;
  } catch {
    return undefined;
  }
}

function isCronStatus(value: string | undefined): value is CronStatus {
  return value === "active" || value === "paused";
}

function isCronLastStatus(value: string | undefined): value is CronLastStatus {
  return value === "started" || value === "completed" || value === "failed";
}

function optionalString(value: AttributeValue | undefined): string | undefined {
  return value?.S;
}

function optionalLastStatus(value: AttributeValue | undefined): CronLastStatus | undefined {
  return isCronLastStatus(value?.S) ? (value!.S as CronLastStatus) : undefined;
}

function itemToCron(item: Record<string, AttributeValue>): CronRecord | null {
  const accountId = item.accountId?.S;
  const cronId = item.cronId?.S;
  const name = item.name?.S;
  const agentId = item.agentId?.S;
  const events = parseEvents(item.events?.S);
  const scheduleExpression = item.scheduleExpression?.S;
  const status = item.status?.S;
  const schedulerName = item.schedulerName?.S;
  const schedulerGroupName = item.schedulerGroupName?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;
  if (
    !accountId || !cronId || !name || !agentId || !events || !scheduleExpression ||
    !isCronStatus(status) || !schedulerName || !schedulerGroupName || !createdAt || !updatedAt
  ) {
    return null;
  }
  return {
    accountId,
    cronId,
    name,
    description: optionalString(item.description),
    agentId,
    events,
    conversationKey: optionalString(item.conversationKey),
    scheduleExpression,
    timezone: optionalString(item.timezone),
    status,
    schedulerName,
    schedulerGroupName,
    createdAt,
    updatedAt,
    lastInvokedAt: optionalString(item.lastInvokedAt),
    lastStatus: optionalLastStatus(item.lastStatus),
    lastError: optionalString(item.lastError),
  };
}

function itemToCronRun(item: Record<string, AttributeValue>): CronRunRecord | null {
  const accountId = item.accountId?.S;
  const cronId = item.parentCronId?.S;
  const runId = item.runId?.S;
  const eventId = item.eventId?.S;
  const conversationKey = item.conversationKey?.S;
  const status = item.status?.S;
  const startedAt = item.startedAt?.S;
  if (!accountId || !cronId || !runId || !eventId || !conversationKey || !isCronLastStatus(status) || !startedAt) {
    return null;
  }

  return {
    accountId,
    cronId,
    runId,
    eventId,
    conversationKey,
    status,
    ...(item.result?.S !== undefined ? { result: parseJsonValue(item.result.S) } : {}),
    error: optionalString(item.error),
    startedAt,
    completedAt: optionalString(item.completedAt),
  };
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function markRun(
  accountId: string,
  cronId: string,
  values: { lastStatus: CronLastStatus; lastError: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  const setExpressions = [
    "lastInvokedAt = :lastInvokedAt",
    "lastStatus = :lastStatus",
    "updatedAt = :updatedAt",
    ...(values.lastError === null ? [] : ["lastError = :lastError"]),
  ];
  await dynamo.send(
    new UpdateItemCommand({
      TableName: cronsTableName(),
      Key: { accountId: { S: accountId }, cronId: { S: cronId } },
      UpdateExpression: [
        `SET ${setExpressions.join(", ")}`,
        ...(values.lastError === null ? ["REMOVE lastError"] : []),
      ].join(" "),
      ExpressionAttributeValues: {
        ":lastInvokedAt": { S: now },
        ":lastStatus": { S: values.lastStatus },
        ":updatedAt": { S: now },
        ...(values.lastError === null ? {} : { ":lastError": { S: values.lastError } }),
      },
    }),
  );
}

export const dynamoCronStore: CronStore = {
  async getById(accountId, cronId) {
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: cronsTableName(),
        Key: { accountId: { S: accountId }, cronId: { S: cronId } },
        ConsistentRead: true,
      }),
    );
    return result.Item ? itemToCron(result.Item) : null;
  },

  async list(accountId) {
    const records: CronRecord[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const result = await dynamo.send(
        new QueryCommand({
          TableName: cronsTableName(),
          KeyConditionExpression: "accountId = :accountId",
          ExpressionAttributeValues: { ":accountId": { S: accountId } },
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      records.push(
        ...(result.Items ?? [])
          .map(itemToCron)
          .filter((r): r is CronRecord => r !== null),
      );
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return records;
  },

  async create(accountId, input: CreateCronInput, options) {
    const normalized = normalizeCreateCronInput(input);
    const schedulerGroupName = normalizeSchedulerGroupName(options.schedulerGroupName);
    const cronId = createCronId();
    const now = new Date().toISOString();
    const record: CronRecord = {
      accountId,
      cronId,
      name: normalized.name,
      ...(normalized.description ? { description: normalized.description } : {}),
      agentId: normalized.agentId,
      events: normalized.events,
      ...(normalized.conversationKey ? { conversationKey: normalized.conversationKey } : {}),
      scheduleExpression: normalized.scheduleExpression,
      ...(normalized.timezone ? { timezone: normalized.timezone } : {}),
      status: normalized.status ?? "active",
      schedulerName: createCronScheduleName(accountId, cronId),
      schedulerGroupName,
      createdAt: now,
      updatedAt: now,
    };
    await dynamo.send(
      new PutItemCommand({
        TableName: cronsTableName(),
        Item: cronToItem(record),
        ConditionExpression: "attribute_not_exists(accountId) AND attribute_not_exists(cronId)",
      }),
    );
    return record;
  },

  async update(accountId, cronId, rawPatch: UpdateCronInput) {
    const patch = normalizeUpdateCronInput(rawPatch);
    const setExpressions: string[] = ["updatedAt = :updatedAt"];
    const removeExpressions: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, AttributeValue> = {
      ":updatedAt": { S: new Date().toISOString() },
    };
    if (patch.name !== undefined) {
      setExpressions.push("#name = :name");
      names["#name"] = "name";
      values[":name"] = { S: patch.name };
    }
    if (patch.description !== undefined) {
      if (patch.description === null) removeExpressions.push("description");
      else {
        setExpressions.push("description = :description");
        values[":description"] = { S: patch.description };
      }
    }
    if (patch.agentId !== undefined) {
      setExpressions.push("agentId = :agentId");
      values[":agentId"] = { S: patch.agentId };
    }
    if (patch.events !== undefined) {
      setExpressions.push("#events = :events");
      names["#events"] = "events";
      values[":events"] = { S: JSON.stringify(patch.events) };
    }
    if (patch.conversationKey !== undefined) {
      if (patch.conversationKey === null) removeExpressions.push("conversationKey");
      else {
        setExpressions.push("conversationKey = :conversationKey");
        values[":conversationKey"] = { S: patch.conversationKey };
      }
    }
    if (patch.scheduleExpression !== undefined) {
      setExpressions.push("scheduleExpression = :scheduleExpression");
      values[":scheduleExpression"] = { S: patch.scheduleExpression };
    }
    if (patch.timezone !== undefined) {
      if (patch.timezone === null) removeExpressions.push("timezone");
      else {
        setExpressions.push("timezone = :timezone");
        values[":timezone"] = { S: patch.timezone };
      }
    }
    if (patch.status !== undefined) {
      setExpressions.push("#status = :status");
      names["#status"] = "status";
      values[":status"] = { S: patch.status };
    }

    const result = await dynamo
      .send(
        new UpdateItemCommand({
          TableName: cronsTableName(),
          Key: { accountId: { S: accountId }, cronId: { S: cronId } },
          UpdateExpression: [
            `SET ${setExpressions.join(", ")}`,
            ...(removeExpressions.length > 0 ? [`REMOVE ${removeExpressions.join(", ")}`] : []),
          ].join(" "),
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(cronId)",
          ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      )
      .catch((err) => {
        if (isConditionalCheckFailed(err)) return null;
        throw err;
      });
    return result?.Attributes ? itemToCron(result.Attributes) : null;
  },

  async remove(accountId, cronId) {
    const result = await dynamo
      .send(
        new DeleteItemCommand({
          TableName: cronsTableName(),
          Key: { accountId: { S: accountId }, cronId: { S: cronId } },
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(cronId)",
        }),
      )
      .catch((err) => {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      });
    return result !== false;
  },

  async markStarted(accountId, cronId) {
    await markRun(accountId, cronId, { lastStatus: "started", lastError: null });
  },
  async markCompleted(accountId, cronId) {
    await markRun(accountId, cronId, { lastStatus: "completed", lastError: null });
  },
  async markFailed(accountId, cronId, error) {
    await markRun(accountId, cronId, { lastStatus: "failed", lastError: error });
  },
  async createRun(input) {
    const now = new Date().toISOString();
    const record: CronRunRecord = {
      ...input,
      runId: createCronRunId(now),
      status: "started",
      startedAt: now,
    };
    await dynamo.send(new PutItemCommand({
      TableName: cronsTableName(),
      Item: cronRunToItem(record),
      ConditionExpression: "attribute_not_exists(accountId) AND attribute_not_exists(cronId)",
    }));
    return record;
  },
  async completeRun(accountId, cronId, runId, result) {
    const now = new Date().toISOString();
    await dynamo.send(new UpdateItemCommand({
      TableName: cronsTableName(),
      Key: { accountId: { S: accountId }, cronId: { S: cronRunSortKey(cronId, runIdStartedAt(runId), runId) } },
      UpdateExpression: "SET #status = :status, #result = :result, completedAt = :completedAt",
      ExpressionAttributeNames: { "#status": "status", "#result": "result" },
      ExpressionAttributeValues: {
        ":status": { S: "completed" },
        ":result": { S: JSON.stringify(result) },
        ":completedAt": { S: now },
      },
    }));
  },
  async failRun(accountId, cronId, runId, error) {
    const now = new Date().toISOString();
    await dynamo.send(new UpdateItemCommand({
      TableName: cronsTableName(),
      Key: { accountId: { S: accountId }, cronId: { S: cronRunSortKey(cronId, runIdStartedAt(runId), runId) } },
      UpdateExpression: "SET #status = :status, #error = :error, completedAt = :completedAt",
      ExpressionAttributeNames: { "#status": "status", "#error": "error" },
      ExpressionAttributeValues: {
        ":status": { S: "failed" },
        ":error": { S: error },
        ":completedAt": { S: now },
      },
    }));
  },
  async listRuns(accountId, cronId, limit = 20) {
    const result = await dynamo.send(new QueryCommand({
      TableName: cronsTableName(),
      KeyConditionExpression: "accountId = :accountId AND begins_with(cronId, :prefix)",
      ExpressionAttributeValues: {
        ":accountId": { S: accountId },
        ":prefix": { S: cronRunSortPrefix(cronId) },
      },
      ScanIndexForward: false,
      Limit: limit,
      ConsistentRead: true,
    }));
    return (result.Items ?? [])
      .map(itemToCronRun)
      .filter((run): run is CronRunRecord => run !== null);
  },
};

function runIdStartedAt(runId: string): string {
  const startedAt = runId.split("#", 2)[0];
  if (!startedAt) throw new Error("Cron run id is missing startedAt prefix");
  return startedAt;
}

export { createCronScheduleName };
