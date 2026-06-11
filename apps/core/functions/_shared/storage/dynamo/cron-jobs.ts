/**
 * DDB-backed cron-job CRUD. Normalization helpers live in
 * `../cron-jobs.ts` and are called at the create/update entry points so
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
import { requireEnv } from "../../env.ts";
import {
  normalizeCreateCronJobInput,
  normalizeSchedulerGroupName,
  normalizeUpdateCronJobInput,
  type CronJobLastStatus,
} from "../cron-jobs.ts";
import type {
  CreateCronJobInput,
  CronJobRecord,
  CronJobStatus,
  CronJobStore,
  UpdateCronJobInput,
} from "../types.ts";

const CRON_JOB_ID_PREFIX = "cron_";
const SCHEDULE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function cronJobsTableName(): string {
  return requireEnv("CRON_JOBS_TABLE_NAME");
}

function createCronJobId(): string {
  return `${CRON_JOB_ID_PREFIX}${randomBytes(10).toString("hex")}`;
}

function createCronScheduleName(accountId: string, cronJobId: string): string {
  const name = `${accountId}-${cronJobId}`;
  if (!SCHEDULE_NAME_PATTERN.test(name)) {
    throw new Error("Generated cron schedule name is invalid");
  }
  return name;
}

function cronJobToItem(record: CronJobRecord): Record<string, AttributeValue> {
  return {
    accountId: { S: record.accountId },
    cronJobId: { S: record.cronJobId },
    name: { S: record.name },
    ...(record.description ? { description: { S: record.description } } : {}),
    agentId: { S: record.agentId },
    prompt: { S: record.prompt },
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

function isCronJobStatus(value: string | undefined): value is CronJobStatus {
  return value === "active" || value === "paused";
}

function isCronJobLastStatus(value: string | undefined): value is CronJobLastStatus {
  return value === "started" || value === "completed" || value === "failed";
}

function optionalString(value: AttributeValue | undefined): string | undefined {
  return value?.S;
}

function optionalLastStatus(value: AttributeValue | undefined): CronJobLastStatus | undefined {
  return isCronJobLastStatus(value?.S) ? (value!.S as CronJobLastStatus) : undefined;
}

function itemToCronJob(item: Record<string, AttributeValue>): CronJobRecord | null {
  const accountId = item.accountId?.S;
  const cronJobId = item.cronJobId?.S;
  const name = item.name?.S;
  const agentId = item.agentId?.S;
  const prompt = item.prompt?.S;
  const scheduleExpression = item.scheduleExpression?.S;
  const status = item.status?.S;
  const schedulerName = item.schedulerName?.S;
  const schedulerGroupName = item.schedulerGroupName?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;
  if (
    !accountId || !cronJobId || !name || !agentId || !prompt || !scheduleExpression ||
    !isCronJobStatus(status) || !schedulerName || !schedulerGroupName || !createdAt || !updatedAt
  ) {
    return null;
  }
  return {
    accountId,
    cronJobId,
    name,
    description: optionalString(item.description),
    agentId,
    prompt,
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

async function markRun(
  accountId: string,
  cronJobId: string,
  values: { lastStatus: CronJobLastStatus; lastError: string | null },
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
      TableName: cronJobsTableName(),
      Key: { accountId: { S: accountId }, cronJobId: { S: cronJobId } },
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

export const dynamoCronJobStore: CronJobStore = {
  async getById(accountId, cronJobId) {
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: cronJobsTableName(),
        Key: { accountId: { S: accountId }, cronJobId: { S: cronJobId } },
        ConsistentRead: true,
      }),
    );
    return result.Item ? itemToCronJob(result.Item) : null;
  },

  async list(accountId) {
    const records: CronJobRecord[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const result = await dynamo.send(
        new QueryCommand({
          TableName: cronJobsTableName(),
          KeyConditionExpression: "accountId = :accountId",
          ExpressionAttributeValues: { ":accountId": { S: accountId } },
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      records.push(
        ...(result.Items ?? [])
          .map(itemToCronJob)
          .filter((r): r is CronJobRecord => r !== null),
      );
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return records;
  },

  async create(accountId, input: CreateCronJobInput, options) {
    const normalized = normalizeCreateCronJobInput(input);
    const schedulerGroupName = normalizeSchedulerGroupName(options.schedulerGroupName);
    const cronJobId = createCronJobId();
    const now = new Date().toISOString();
    const record: CronJobRecord = {
      accountId,
      cronJobId,
      name: normalized.name,
      ...(normalized.description ? { description: normalized.description } : {}),
      agentId: normalized.agentId,
      prompt: normalized.prompt,
      ...(normalized.conversationKey ? { conversationKey: normalized.conversationKey } : {}),
      scheduleExpression: normalized.scheduleExpression,
      ...(normalized.timezone ? { timezone: normalized.timezone } : {}),
      status: normalized.status ?? "active",
      schedulerName: createCronScheduleName(accountId, cronJobId),
      schedulerGroupName,
      createdAt: now,
      updatedAt: now,
    };
    await dynamo.send(
      new PutItemCommand({
        TableName: cronJobsTableName(),
        Item: cronJobToItem(record),
        ConditionExpression: "attribute_not_exists(accountId) AND attribute_not_exists(cronJobId)",
      }),
    );
    return record;
  },

  async update(accountId, cronJobId, rawPatch: UpdateCronJobInput) {
    const patch = normalizeUpdateCronJobInput(rawPatch);
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
    if (patch.prompt !== undefined) {
      setExpressions.push("prompt = :prompt");
      values[":prompt"] = { S: patch.prompt };
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
          TableName: cronJobsTableName(),
          Key: { accountId: { S: accountId }, cronJobId: { S: cronJobId } },
          UpdateExpression: [
            `SET ${setExpressions.join(", ")}`,
            ...(removeExpressions.length > 0 ? [`REMOVE ${removeExpressions.join(", ")}`] : []),
          ].join(" "),
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(cronJobId)",
          ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      )
      .catch((err) => {
        if (isConditionalCheckFailed(err)) return null;
        throw err;
      });
    return result?.Attributes ? itemToCronJob(result.Attributes) : null;
  },

  async remove(accountId, cronJobId) {
    const result = await dynamo
      .send(
        new DeleteItemCommand({
          TableName: cronJobsTableName(),
          Key: { accountId: { S: accountId }, cronJobId: { S: cronJobId } },
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(cronJobId)",
        }),
      )
      .catch((err) => {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      });
    return result !== false;
  },

  async markStarted(accountId, cronJobId) {
    await markRun(accountId, cronJobId, { lastStatus: "started", lastError: null });
  },
  async markCompleted(accountId, cronJobId) {
    await markRun(accountId, cronJobId, { lastStatus: "completed", lastError: null });
  },
  async markFailed(accountId, cronJobId, error) {
    await markRun(accountId, cronJobId, { lastStatus: "failed", lastError: error });
  },
};

export { createCronScheduleName };
