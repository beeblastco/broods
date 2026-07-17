/**
 * Cron-job input normalization and public response mapping for the Convex
 * config plane (epic #85 phase 9, stage 3). Ports core's former
 * src/shared/domain/cron.ts normalizer so the public /v1/crons contract is
 * unchanged. Pure module — safe for the default Convex runtime; EventBridge
 * Scheduler calls live in awsCrons.ts.
 */

import type { Doc } from "../_generated/dataModel";
import { isPlainObject } from "./objects";

const SCHEDULE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const TIMEZONE_PATTERN = /^[A-Za-z0-9_./+-]{1,64}$/;

export type CronStatus = "active" | "paused";

/** Normalized create payload: `input`/`events` collapsed to a stored events list. */
export interface NormalizedCronCreate {
  name: string;
  description?: string;
  agentId: string;
  events: unknown[];
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
  events?: unknown[];
  conversationKey?: string | null;
  scheduleExpression?: string;
  timezone?: string | null;
  status?: CronStatus;
}

/**
 * Validate and normalize a create-cron request body.
 * @param input the raw request body
 * @returns the normalized create payload
 * @throws when a field is missing, malformed, or out of bounds
 */
export function normalizeCreateCronInput(input: unknown): NormalizedCronCreate {
  if (!isPlainObject(input)) throw new Error("Request body must be an object");

  return {
    name: requireString(input.name, "name", 120),
    agentId: requireString(input.agentId, "agentId", 120),
    events: runPayloadToEvents(input),
    scheduleExpression: normalizeScheduleExpression(input.scheduleExpression),
    ...(input.description !== undefined
      ? {
          description:
            optionalString(input.description, "description", 500) ?? "",
        }
      : {}),
    ...(input.conversationKey !== undefined
      ? {
          conversationKey:
            optionalString(input.conversationKey, "conversationKey", 256) ?? "",
        }
      : {}),
    ...(input.timezone !== undefined
      ? { timezone: normalizeTimezone(input.timezone) }
      : {}),
    ...(input.status !== undefined
      ? { status: normalizeCronStatus(input.status) }
      : {}),
  };
}

/**
 * Validate and normalize an update-cron request body.
 * @param input the raw request body
 * @returns the normalized patch, with null marking fields to clear
 * @throws when the patch is empty or a field is malformed
 */
export function normalizeUpdateCronInput(input: unknown): NormalizedCronUpdate {
  if (!isPlainObject(input)) throw new Error("Request body must be an object");
  const events = optionalRunPayloadToEvents(input);
  const normalized: NormalizedCronUpdate = {
    ...(input.name !== undefined
      ? { name: requireString(input.name, "name", 120) }
      : {}),
    ...(input.description !== undefined
      ? {
          description:
            input.description === null
              ? null
              : optionalString(input.description, "description", 500),
        }
      : {}),
    ...(input.agentId !== undefined
      ? { agentId: requireString(input.agentId, "agentId", 120) }
      : {}),
    ...(events !== undefined ? { events: events } : {}),
    ...(input.conversationKey !== undefined
      ? {
          conversationKey:
            input.conversationKey === null
              ? null
              : optionalString(input.conversationKey, "conversationKey", 256),
        }
      : {}),
    ...(input.scheduleExpression !== undefined
      ? {
          scheduleExpression: normalizeScheduleExpression(
            input.scheduleExpression,
          ),
        }
      : {}),
    ...(input.timezone !== undefined
      ? {
          timezone:
            input.timezone === null ? null : normalizeTimezone(input.timezone),
        }
      : {}),
    ...(input.status !== undefined
      ? { status: normalizeCronStatus(input.status) }
      : {}),
  };
  if (Object.keys(normalized).length === 0) {
    throw new Error("Request body must include at least one cron job field");
  }

  return normalized;
}

/**
 * Validate an EventBridge Scheduler group name.
 * @param value the candidate group name
 * @returns the validated group name
 * @throws when the name is missing or contains unsupported characters
 */
export function normalizeSchedulerGroupName(value: unknown): string {
  const groupName = requireString(value, "schedulerGroupName", 64);
  if (!SCHEDULE_NAME_PATTERN.test(groupName)) {
    throw new Error("schedulerGroupName contains unsupported characters");
  }

  return groupName;
}

/**
 * Parse the ?limit= query value for run listings.
 * @param value the raw query value
 * @returns the parsed limit, or undefined when absent
 * @throws when the value is not an integer between 1 and 100
 */
export function parseCronRunsLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }

  return parsed;
}

/**
 * Map a crons document to the public cron shape core used to return
 * (cronId = _id, ISO timestamps, scheduler fields omitted).
 * @param doc the crons document
 * @returns the public cron record
 */
export function toCronResponse(doc: Doc<"crons">): Record<string, unknown> {
  return {
    accountId: doc.accountId,
    cronId: doc._id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    agentId: doc.agentId,
    events: doc.events,
    ...(doc.conversationKey ? { conversationKey: doc.conversationKey } : {}),
    scheduleExpression: doc.scheduleExpression,
    ...(doc.timezone ? { timezone: doc.timezone } : {}),
    status: doc.status,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
    ...(doc.lastInvokedAt
      ? { lastInvokedAt: new Date(doc.lastInvokedAt).toISOString() }
      : {}),
    ...(doc.lastStatus ? { lastStatus: doc.lastStatus } : {}),
    ...(doc.lastError ? { lastError: doc.lastError } : {}),
  };
}

/**
 * Map a cronRuns document to the public run shape core used to return
 * (runId = _id, ISO timestamps).
 * @param doc the cronRuns document
 * @returns the public run record
 */
export function toCronRunResponse(
  doc: Doc<"cronRuns">,
): Record<string, unknown> {
  return {
    accountId: doc.accountId,
    cronId: doc.cronId,
    runId: doc._id,
    eventId: doc.eventId,
    conversationKey: doc.conversationKey,
    status: doc.status,
    ...(doc.result !== undefined ? { result: doc.result } : {}),
    ...(doc.error ? { error: doc.error } : {}),
    startedAt: new Date(doc.startedAt).toISOString(),
    ...(doc.completedAt
      ? { completedAt: new Date(doc.completedAt).toISOString() }
      : {}),
  };
}

/** Collapses a one-of `input`/`events` payload into the stored events list. */
function runPayloadToEvents(payload: {
  input?: unknown;
  events?: unknown;
}): unknown[] {
  const hasInput = payload.input !== undefined;
  const hasEvents = payload.events !== undefined;
  if (hasInput === hasEvents) {
    throw new Error("Provide exactly one of input or events");
  }
  if (hasInput) {
    return [
      {
        role: "user",
        content: [{ type: "text", text: String(payload.input) }],
      },
    ];
  }

  return normalizeEvents(payload.events);
}

/** Like runPayloadToEvents, but returns undefined when neither field is supplied (updates). */
function optionalRunPayloadToEvents(payload: {
  input?: unknown;
  events?: unknown;
}): unknown[] | undefined {
  if (payload.input === undefined && payload.events === undefined)
    return undefined;

  return runPayloadToEvents(payload);
}

function normalizeEvents(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("events must be a non-empty array of model messages");
  }

  return value;
}

function normalizeScheduleExpression(value: unknown): string {
  const expression = requireString(value, "scheduleExpression", 256);
  if (!/^(cron|rate|at)\(.+\)$/.test(expression)) {
    throw new Error(
      "scheduleExpression must use cron(...), rate(...), or at(...)",
    );
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

function requireString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0)
    throw new Error(`${name} must be a non-empty string`);
  if (trimmed.length > maxLength)
    throw new Error(`${name} must be at most ${maxLength} characters`);

  return trimmed;
}

function optionalString(
  value: unknown,
  name: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength)
    throw new Error(`${name} must be at most ${maxLength} characters`);

  return trimmed.length > 0 ? trimmed : undefined;
}
