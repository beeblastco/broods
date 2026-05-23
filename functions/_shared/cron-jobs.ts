/**
 * Shared cron job persistence.
 * Keep schedule records here; AWS Scheduler mutations belong to account-manage.
 */

import { randomBytes } from "node:crypto";
import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  dynamo,
  isConditionalCheckFailed,
} from "./dynamo.ts";
import { optionalEnv, requireEnv } from "./env.ts";

const CRON_JOB_ID_PREFIX = "cron_";
const SCHEDULE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const TIMEZONE_PATTERN = /^[A-Za-z0-9_./+-]{1,64}$/;

export type CronJobStatus = "active" | "paused";
export type CronJobLastStatus = "started" | "completed" | "failed";

export interface CronJobRecord {
  accountId: string;
  cronJobId: string;
  name: string;
  description?: string;
  agentId: string;
  prompt: string;
  conversationKey?: string;
  scheduleExpression: string;
  timezone?: string;
  status: CronJobStatus;
  schedulerName: string;
  schedulerGroupName: string;
  createdAt: string;
  updatedAt: string;
  lastInvokedAt?: string;
  lastStatus?: CronJobLastStatus;
  lastError?: string;
}

export interface CreateCronJobInput {
  name: string;
  description?: string;
  agentId: string;
  prompt: string;
  conversationKey?: string;
  scheduleExpression: string;
  timezone?: string;
  status?: CronJobStatus;
}

export interface UpdateCronJobInput {
  name?: string;
  description?: string | null;
  agentId?: string;
  prompt?: string;
  conversationKey?: string | null;
  scheduleExpression?: string;
  timezone?: string | null;
  status?: CronJobStatus;
}

export function createCronJobId(): string {
  return `${CRON_JOB_ID_PREFIX}${randomBytes(10).toString("hex")}`;
}

export function createCronScheduleName(accountId: string, cronJobId: string): string {
  const name = `${accountId}-${cronJobId}`;
  if (!SCHEDULE_NAME_PATTERN.test(name)) {
    throw new Error("Generated cron schedule name is invalid");
  }
  return name;
}

export async function createCronJob(
  accountId: string,
  input: CreateCronJobInput,
  options: { schedulerGroupName: string },
): Promise<CronJobRecord> {
  const normalized = normalizeCreateCronJobInput(input);
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
    schedulerGroupName: normalizeSchedulerGroupName(options.schedulerGroupName),
    createdAt: now,
    updatedAt: now,
  };

  await dynamo.send(new PutItemCommand({
    TableName: cronJobsTableName(),
    Item: cronJobToItem(record),
    ConditionExpression: "attribute_not_exists(accountId) AND attribute_not_exists(cronJobId)",
  }));

  return record;
}

export async function getCronJob(accountId: string, cronJobId: string): Promise<CronJobRecord | null> {
  const result = await dynamo.send(new GetItemCommand({
    TableName: cronJobsTableName(),
    Key: {
      accountId: { S: accountId },
      cronJobId: { S: cronJobId },
    },
    ConsistentRead: true,
  }));

  return result.Item ? itemToCronJob(result.Item) : null;
}

export async function listCronJobs(accountId: string): Promise<CronJobRecord[]> {
  const records: CronJobRecord[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(new QueryCommand({
      TableName: cronJobsTableName(),
      KeyConditionExpression: "accountId = :accountId",
      ExpressionAttributeValues: {
        ":accountId": { S: accountId },
      },
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }));

    records.push(
      ...(result.Items ?? [])
        .map(itemToCronJob)
        .filter((record): record is CronJobRecord => record !== null),
    );
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return records;
}

export async function updateCronJob(
  accountId: string,
  cronJobId: string,
  input: UpdateCronJobInput,
): Promise<CronJobRecord | null> {
  const normalized = normalizeUpdateCronJobInput(input);
  const setExpressions = [
    "updatedAt = :updatedAt",
    ...(normalized.name !== undefined ? ["#name = :name"] : []),
    ...(normalized.description !== undefined && normalized.description !== null ? ["description = :description"] : []),
    ...(normalized.agentId !== undefined ? ["agentId = :agentId"] : []),
    ...(normalized.prompt !== undefined ? ["prompt = :prompt"] : []),
    ...(normalized.conversationKey !== undefined && normalized.conversationKey !== null ? ["conversationKey = :conversationKey"] : []),
    ...(normalized.scheduleExpression !== undefined ? ["scheduleExpression = :scheduleExpression"] : []),
    ...(normalized.timezone !== undefined && normalized.timezone !== null ? ["timezone = :timezone"] : []),
    ...(normalized.status !== undefined ? ["#status = :status"] : []),
  ];
  const removeExpressions = [
    ...(normalized.description === null ? ["description"] : []),
    ...(normalized.conversationKey === null ? ["conversationKey"] : []),
    ...(normalized.timezone === null ? ["timezone"] : []),
  ];

  const expressionAttributeNames = {
    ...(normalized.name !== undefined ? { "#name": "name" } : {}),
    ...(normalized.status !== undefined ? { "#status": "status" } : {}),
  };

  const result = await dynamo.send(new UpdateItemCommand({
    TableName: cronJobsTableName(),
    Key: {
      accountId: { S: accountId },
      cronJobId: { S: cronJobId },
    },
    UpdateExpression: [
      `SET ${setExpressions.join(", ")}`,
      ...(removeExpressions.length > 0 ? [`REMOVE ${removeExpressions.join(", ")}`] : []),
    ].join(" "),
    ConditionExpression: "attribute_exists(accountId) AND attribute_exists(cronJobId)",
    ...(Object.keys(expressionAttributeNames).length > 0 ? { ExpressionAttributeNames: expressionAttributeNames } : {}),
    ExpressionAttributeValues: {
      ":updatedAt": { S: new Date().toISOString() },
      ...(normalized.name !== undefined ? { ":name": { S: normalized.name } } : {}),
      ...(normalized.description !== undefined && normalized.description !== null
        ? { ":description": { S: normalized.description } }
        : {}),
      ...(normalized.agentId !== undefined ? { ":agentId": { S: normalized.agentId } } : {}),
      ...(normalized.prompt !== undefined ? { ":prompt": { S: normalized.prompt } } : {}),
      ...(normalized.conversationKey !== undefined && normalized.conversationKey !== null
        ? { ":conversationKey": { S: normalized.conversationKey } }
        : {}),
      ...(normalized.scheduleExpression !== undefined
        ? { ":scheduleExpression": { S: normalized.scheduleExpression } }
        : {}),
      ...(normalized.timezone !== undefined && normalized.timezone !== null
        ? { ":timezone": { S: normalized.timezone } }
        : {}),
      ...(normalized.status !== undefined ? { ":status": { S: normalized.status } } : {}),
    },
    ReturnValues: "ALL_NEW",
  })).catch((err) => {
    if (isConditionalCheckFailed(err)) {
      return null;
    }
    throw err;
  });

  return result?.Attributes ? itemToCronJob(result.Attributes) : null;
}

export function applyCronJobPatch(record: CronJobRecord, input: UpdateCronJobInput): CronJobRecord {
  const normalized = normalizeUpdateCronJobInput(input);

  return {
    ...record,
    ...(normalized.name !== undefined ? { name: normalized.name } : {}),
    ...(normalized.description === null ? { description: undefined } : {}),
    ...(normalized.description !== undefined && normalized.description !== null
      ? { description: normalized.description }
      : {}),
    ...(normalized.agentId !== undefined ? { agentId: normalized.agentId } : {}),
    ...(normalized.prompt !== undefined ? { prompt: normalized.prompt } : {}),
    ...(normalized.conversationKey === null ? { conversationKey: undefined } : {}),
    ...(normalized.conversationKey !== undefined && normalized.conversationKey !== null
      ? { conversationKey: normalized.conversationKey }
      : {}),
    ...(normalized.scheduleExpression !== undefined ? { scheduleExpression: normalized.scheduleExpression } : {}),
    ...(normalized.timezone === null ? { timezone: undefined } : {}),
    ...(normalized.timezone !== undefined && normalized.timezone !== null ? { timezone: normalized.timezone } : {}),
    ...(normalized.status !== undefined ? { status: normalized.status } : {}),
  };
}

export async function deleteCronJob(accountId: string, cronJobId: string): Promise<boolean> {
  const result = await dynamo.send(new DeleteItemCommand({
    TableName: cronJobsTableName(),
    Key: {
      accountId: { S: accountId },
      cronJobId: { S: cronJobId },
    },
    ConditionExpression: "attribute_exists(accountId) AND attribute_exists(cronJobId)",
  })).catch((err) => {
    if (isConditionalCheckFailed(err)) {
      return false;
    }
    throw err;
  });

  return result !== false;
}

export async function markCronJobStarted(accountId: string, cronJobId: string): Promise<void> {
  await markCronJobRun(accountId, cronJobId, {
    lastStatus: "started",
    lastError: null,
  });
}

export async function markCronJobCompleted(accountId: string, cronJobId: string): Promise<void> {
  await markCronJobRun(accountId, cronJobId, {
    lastStatus: "completed",
    lastError: null,
  });
}

export async function markCronJobFailed(accountId: string, cronJobId: string, error: string): Promise<void> {
  await markCronJobRun(accountId, cronJobId, {
    lastStatus: "failed",
    lastError: error,
  });
}

export function isCronJobsConfigured(): boolean {
  return optionalEnv("CRON_JOBS_TABLE_NAME") !== undefined;
}

function cronJobsTableName(): string {
  return requireEnv("CRON_JOBS_TABLE_NAME");
}

function normalizeCreateCronJobInput(input: CreateCronJobInput): Required<Pick<CreateCronJobInput, "name" | "agentId" | "prompt" | "scheduleExpression">> & {
  description?: string;
  conversationKey?: string;
  timezone?: string;
  status?: CronJobStatus;
} {
  if (!isPlainObject(input)) {
    throw new Error("Request body must be an object");
  }

  return {
    name: normalizeRequiredString(input.name, "name", 120),
    agentId: normalizeRequiredString(input.agentId, "agentId", 120),
    prompt: normalizeRequiredString(input.prompt, "prompt", 20_000),
    ...(input.conversationKey !== undefined
      ? { conversationKey: normalizeOptionalString(input.conversationKey, "conversationKey", 256) ?? "" }
      : {}),
    scheduleExpression: normalizeScheduleExpression(input.scheduleExpression),
    ...(input.description !== undefined
      ? { description: normalizeOptionalString(input.description, "description", 500) ?? "" }
      : {}),
    ...(input.timezone !== undefined ? { timezone: normalizeTimezone(input.timezone) } : {}),
    ...(input.status !== undefined ? { status: normalizeCronJobStatus(input.status) } : {}),
  };
}

function normalizeUpdateCronJobInput(input: UpdateCronJobInput): UpdateCronJobInput {
  if (!isPlainObject(input)) {
    throw new Error("Request body must be an object");
  }

  const normalized: UpdateCronJobInput = {
    ...(input.name !== undefined ? { name: normalizeRequiredString(input.name, "name", 120) } : {}),
    ...(input.description !== undefined
      ? { description: input.description === null ? null : normalizeOptionalString(input.description, "description", 500) }
      : {}),
    ...(input.agentId !== undefined ? { agentId: normalizeRequiredString(input.agentId, "agentId", 120) } : {}),
    ...(input.prompt !== undefined ? { prompt: normalizeRequiredString(input.prompt, "prompt", 20_000) } : {}),
    ...(input.conversationKey !== undefined
      ? { conversationKey: input.conversationKey === null ? null : normalizeOptionalString(input.conversationKey, "conversationKey", 256) }
      : {}),
    ...(input.scheduleExpression !== undefined
      ? { scheduleExpression: normalizeScheduleExpression(input.scheduleExpression) }
      : {}),
    ...(input.timezone !== undefined
      ? { timezone: input.timezone === null ? null : normalizeTimezone(input.timezone) }
      : {}),
    ...(input.status !== undefined ? { status: normalizeCronJobStatus(input.status) } : {}),
  };

  if (Object.keys(normalized).length === 0) {
    throw new Error("Request body must include at least one cron job field");
  }

  return normalized;
}

function normalizeScheduleExpression(value: unknown): string {
  const expression = normalizeRequiredString(value, "scheduleExpression", 256);
  if (!/^(cron|rate|at)\(.+\)$/.test(expression)) {
    throw new Error("scheduleExpression must use cron(...), rate(...), or at(...)");
  }
  return expression;
}

function normalizeTimezone(value: unknown): string {
  const timezone = normalizeRequiredString(value, "timezone", 64);
  if (!TIMEZONE_PATTERN.test(timezone)) {
    throw new Error("timezone contains unsupported characters");
  }
  return timezone;
}

function normalizeSchedulerGroupName(value: unknown): string {
  const groupName = normalizeRequiredString(value, "schedulerGroupName", 64);
  if (!SCHEDULE_NAME_PATTERN.test(groupName)) {
    throw new Error("schedulerGroupName contains unsupported characters");
  }
  return groupName;
}

function normalizeCronJobStatus(value: unknown): CronJobStatus {
  if (value === "active" || value === "paused") {
    return value;
  }
  throw new Error("status must be active or paused");
}

function normalizeRequiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${name} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizeOptionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${name} must be at most ${maxLength} characters`);
  }
  return normalized.length > 0 ? normalized : undefined;
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
    !accountId ||
    !cronJobId ||
    !name ||
    !agentId ||
    !prompt ||
    !scheduleExpression ||
    !isCronJobStatus(status) ||
    !schedulerName ||
    !schedulerGroupName ||
    !createdAt ||
    !updatedAt
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

async function markCronJobRun(
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

  await dynamo.send(new UpdateItemCommand({
    TableName: cronJobsTableName(),
    Key: {
      accountId: { S: accountId },
      cronJobId: { S: cronJobId },
    },
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
  }));
}

function optionalString(value: AttributeValue | undefined): string | undefined {
  return value?.S;
}

function optionalLastStatus(value: AttributeValue | undefined): CronJobLastStatus | undefined {
  return isCronJobLastStatus(value?.S) ? value.S : undefined;
}

function isCronJobStatus(value: string | undefined): value is CronJobStatus {
  return value === "active" || value === "paused";
}

function isCronJobLastStatus(value: string | undefined): value is CronJobLastStatus {
  return value === "started" || value === "completed" || value === "failed";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
