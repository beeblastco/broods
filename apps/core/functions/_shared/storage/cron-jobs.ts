/**
 * Cron-job types, input normalization, and patch-merge helpers.
 * Provider-agnostic — both the DynamoDB and Convex stores import the
 * normalizer at their create/update entry points so behaviour is
 * symmetric across modes.
 */

import { optionalEnv } from "../env.ts";

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

export function isCronJobsConfigured(): boolean {
  return (
    optionalEnv("CRON_JOBS_TABLE_NAME") !== undefined ||
    optionalEnv("STORAGE_PROVIDER") === "convex"
  );
}

export function normalizeCreateCronJobInput(input: CreateCronJobInput): CreateCronJobInput {
  if (!isPlainObject(input)) throw new Error("Request body must be an object");
  return {
    name: requireString(input.name, "name", 120),
    agentId: requireString(input.agentId, "agentId", 120),
    prompt: requireString(input.prompt, "prompt", 20_000),
    scheduleExpression: normalizeScheduleExpression(input.scheduleExpression),
    ...(input.description !== undefined
      ? { description: optionalString(input.description, "description", 500) ?? "" }
      : {}),
    ...(input.conversationKey !== undefined
      ? { conversationKey: optionalString(input.conversationKey, "conversationKey", 256) ?? "" }
      : {}),
    ...(input.timezone !== undefined ? { timezone: normalizeTimezone(input.timezone) } : {}),
    ...(input.status !== undefined ? { status: normalizeCronJobStatus(input.status) } : {}),
  };
}

export function normalizeUpdateCronJobInput(input: UpdateCronJobInput): UpdateCronJobInput {
  if (!isPlainObject(input)) throw new Error("Request body must be an object");
  const normalized: UpdateCronJobInput = {
    ...(input.name !== undefined ? { name: requireString(input.name, "name", 120) } : {}),
    ...(input.description !== undefined
      ? {
          description:
            input.description === null ? null : optionalString(input.description, "description", 500),
        }
      : {}),
    ...(input.agentId !== undefined ? { agentId: requireString(input.agentId, "agentId", 120) } : {}),
    ...(input.prompt !== undefined ? { prompt: requireString(input.prompt, "prompt", 20_000) } : {}),
    ...(input.conversationKey !== undefined
      ? {
          conversationKey:
            input.conversationKey === null
              ? null
              : optionalString(input.conversationKey, "conversationKey", 256),
        }
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

export function normalizeSchedulerGroupName(value: unknown): string {
  const groupName = requireString(value, "schedulerGroupName", 64);
  if (!SCHEDULE_NAME_PATTERN.test(groupName)) {
    throw new Error("schedulerGroupName contains unsupported characters");
  }
  return groupName;
}

export function applyCronJobPatch(record: CronJobRecord, input: UpdateCronJobInput): CronJobRecord {
  const patch = normalizeUpdateCronJobInput(input);
  return {
    ...record,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description === null
      ? { description: undefined }
      : patch.description !== undefined
        ? { description: patch.description }
        : {}),
    ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
    ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
    ...(patch.conversationKey === null
      ? { conversationKey: undefined }
      : patch.conversationKey !== undefined
        ? { conversationKey: patch.conversationKey }
        : {}),
    ...(patch.scheduleExpression !== undefined ? { scheduleExpression: patch.scheduleExpression } : {}),
    ...(patch.timezone === null
      ? { timezone: undefined }
      : patch.timezone !== undefined
        ? { timezone: patch.timezone }
        : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
  };
}

function normalizeScheduleExpression(value: unknown): string {
  const expression = requireString(value, "scheduleExpression", 256);
  if (!/^(cron|rate|at)\(.+\)$/.test(expression)) {
    throw new Error("scheduleExpression must use cron(...), rate(...), or at(...)");
  }
  return expression;
}

function normalizeTimezone(value: unknown): string {
  const timezone = requireString(value, "timezone", 64);
  if (!TIMEZONE_PATTERN.test(timezone)) {
    throw new Error("timezone contains unsupported characters");
  }
  return timezone;
}

function normalizeCronJobStatus(value: unknown): CronJobStatus {
  if (value === "active" || value === "paused") return value;
  throw new Error("status must be active or paused");
}

function requireString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${name} must be a non-empty string`);
  if (trimmed.length > maxLength) throw new Error(`${name} must be at most ${maxLength} characters`);
  return trimmed;
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${name} must be at most ${maxLength} characters`);
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
