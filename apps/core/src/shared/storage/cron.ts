/**
 * Cron-job types, input normalization, and patch-merge helpers.
 * Provider-agnostic — both the DynamoDB and Convex stores import the
 * normalizer at their create/update entry points so behaviour is
 * symmetric across modes.
 */

import type { ModelMessage } from "ai";
import { optionalEnv } from "../env.ts";
import { isPlainObject } from "../object.ts";

const SCHEDULE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const TIMEZONE_PATTERN = /^[A-Za-z0-9_./+-]{1,64}$/;
const MAX_INPUT_LENGTH = 20_000;

export type CronStatus = "active" | "paused";
export type CronLastStatus = "started" | "completed" | "failed";

export interface CronRecord {
  accountId: string;
  cronId: string;
  name: string;
  description?: string;
  agentId: string;
  events: ModelMessage[];
  conversationKey?: string;
  scheduleExpression: string;
  timezone?: string;
  status: CronStatus;
  schedulerName: string;
  schedulerGroupName: string;
  createdAt: string;
  updatedAt: string;
  lastInvokedAt?: string;
  lastStatus?: CronLastStatus;
  lastError?: string;
}

export interface CronRunRecord {
  accountId: string;
  cronId: string;
  runId: string;
  eventId: string;
  conversationKey: string;
  status: CronLastStatus;
  result?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

/**
 * One-of run payload mirroring the agent direct API's AgentRunInput: provide a
 * single `input` string (wrapped into one user message) or a full `events` list.
 */
export type CronRunInput =
  | { input: string; events?: never }
  | { events: ModelMessage[]; input?: never };

export type CreateCronInput = {
  name: string;
  description?: string;
  agentId: string;
  conversationKey?: string;
  scheduleExpression: string;
  timezone?: string;
  status?: CronStatus;
} & CronRunInput;

export type UpdateCronInput = {
  name?: string;
  description?: string | null;
  agentId?: string;
  conversationKey?: string | null;
  scheduleExpression?: string;
  timezone?: string | null;
  status?: CronStatus;
} & ({ input?: string; events?: never } | { events?: ModelMessage[]; input?: never });

/** Normalized create payload: `input`/`events` collapsed to a stored events list. */
export interface NormalizedCronCreate {
  name: string;
  description?: string;
  agentId: string;
  events: ModelMessage[];
  conversationKey?: string;
  scheduleExpression: string;
  timezone?: string;
  status?: CronStatus;
}

/** Normalized update patch: clearable fields use null, run payload uses events. */
export interface NormalizedCronUpdate {
  name?: string;
  description?: string | null;
  agentId?: string;
  events?: ModelMessage[];
  conversationKey?: string | null;
  scheduleExpression?: string;
  timezone?: string | null;
  status?: CronStatus;
}

export function isCronsConfigured(): boolean {
  return (
    optionalEnv("CRONS_TABLE_NAME") !== undefined ||
    optionalEnv("STORAGE_PROVIDER") === "convex"
  );
}

export function normalizeCreateCronInput(input: CreateCronInput): NormalizedCronCreate {
  if (!isPlainObject(input)) throw new Error("Request body must be an object");
  return {
    name: requireString(input.name, "name", 120),
    agentId: requireString(input.agentId, "agentId", 120),
    events: runPayloadToEvents(input),
    scheduleExpression: normalizeScheduleExpression(input.scheduleExpression),
    ...(input.description !== undefined
      ? { description: optionalString(input.description, "description", 500) ?? "" }
      : {}),
    ...(input.conversationKey !== undefined
      ? { conversationKey: optionalString(input.conversationKey, "conversationKey", 256) ?? "" }
      : {}),
    ...(input.timezone !== undefined ? { timezone: normalizeTimezone(input.timezone) } : {}),
    ...(input.status !== undefined ? { status: normalizeCronStatus(input.status) } : {}),
  };
}

export function normalizeUpdateCronInput(input: UpdateCronInput): NormalizedCronUpdate {
  if (!isPlainObject(input)) throw new Error("Request body must be an object");
  const events = optionalRunPayloadToEvents(input);
  const normalized: NormalizedCronUpdate = {
    ...(input.name !== undefined ? { name: requireString(input.name, "name", 120) } : {}),
    ...(input.description !== undefined
      ? {
          description:
            input.description === null ? null : optionalString(input.description, "description", 500),
        }
      : {}),
    ...(input.agentId !== undefined ? { agentId: requireString(input.agentId, "agentId", 120) } : {}),
    ...(events !== undefined ? { events } : {}),
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
    ...(input.status !== undefined ? { status: normalizeCronStatus(input.status) } : {}),
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

export function applyCronPatch(record: CronRecord, input: UpdateCronInput): CronRecord {
  const patch = normalizeUpdateCronInput(input);
  return {
    ...record,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description === null
      ? { description: undefined }
      : patch.description !== undefined
        ? { description: patch.description }
        : {}),
    ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
    ...(patch.events !== undefined ? { events: patch.events } : {}),
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

/** Collapses a one-of `input`/`events` payload into the stored events list. */
function runPayloadToEvents(payload: { input?: unknown; events?: unknown }): ModelMessage[] {
  const hasInput = payload.input !== undefined;
  const hasEvents = payload.events !== undefined;
  if (hasInput === hasEvents) {
    throw new Error("Provide exactly one of input or events");
  }
  if (hasInput) {
    return [{ role: "user", content: [{ type: "text", text: String(payload.input) }] }];
  }

  return normalizeEvents(payload.events);
}

/** Like runPayloadToEvents, but returns undefined when neither field is supplied (updates). */
function optionalRunPayloadToEvents(payload: { input?: unknown; events?: unknown }): ModelMessage[] | undefined {
  if (payload.input === undefined && payload.events === undefined) return undefined;

  return runPayloadToEvents(payload);
}

function normalizeEvents(value: unknown): ModelMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("events must be a non-empty array of model messages");
  }

  return value as ModelMessage[];
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

function normalizeCronStatus(value: unknown): CronStatus {
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
