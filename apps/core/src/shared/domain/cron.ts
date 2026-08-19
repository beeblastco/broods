/**
 * Cron-job records, input normalization, and patch-merge helpers.
 */

import type { JSONValue, ModelMessage } from "ai";
import { optionalEnv } from "../env.ts";
import { isPlainObject } from "../object.ts";

const SCHEDULE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const TIMEZONE_PATTERN = /^[A-Za-z0-9_./+-]{1,64}$/;

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

/**
 * Public cron shape the config plane returns from create/update. It withholds
 * the EventBridge Scheduler names a stored record carries.
 */
export type CronSummary = Omit<
  CronRecord,
  "schedulerName" | "schedulerGroupName"
>;

export interface CronRunRecord {
  accountId: string;
  cronId: string;
  runId: string;
  eventId: string;
  conversationKey: string;
  status: CronLastStatus;
  result?: JSONValue;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

/**
 * One-of run payload mirroring the agent direct API's AgentRunInput: provide a
 * single `input` string (wrapped into one user message) or a full `events` list.
 */
export type CronRunInput =
  { input: string; events?: never } | { events: ModelMessage[]; input?: never };

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
} & (
  | { input?: string; events?: never }
  | { events?: ModelMessage[]; input?: never }
);

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

/**
 * Whether a schedule fires exactly once. EventBridge deletes such a schedule
 * itself once it has run, so the stored job is dropped with it. Mirrored in
 * packages/convex/model/cronRules.ts.
 */
export function isOneTimeSchedule(expression: string): boolean {
  return expression.startsWith("at(");
}

export function isCronsConfigured(): boolean {
  return Boolean(optionalEnv("CONVEX_URL") && optionalEnv("CONVEX_DEPLOY_KEY"));
}

export function normalizeCreateCronInput(
  input: CreateCronInput,
): NormalizedCronCreate {
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

export function normalizeUpdateCronInput(
  input: UpdateCronInput,
): NormalizedCronUpdate {
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

export function normalizeSchedulerGroupName(value: unknown): string {
  const groupName = requireString(value, "schedulerGroupName", 64);
  if (!SCHEDULE_NAME_PATTERN.test(groupName)) {
    throw new Error("schedulerGroupName contains unsupported characters");
  }

  return groupName;
}

export function applyCronPatch(
  record: CronRecord,
  input: UpdateCronInput,
): CronRecord {
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
    ...(patch.scheduleExpression !== undefined
      ? { scheduleExpression: patch.scheduleExpression }
      : {}),
    ...(patch.timezone === null
      ? { timezone: undefined }
      : patch.timezone !== undefined
        ? { timezone: patch.timezone }
        : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
  };
}

/**
 * Frames a fired job's stored instructions for the model. They arrive as a user
 * turn nobody typed, so the first user message says what fired and when.
 */
export function withScheduledRunContext(
  job: CronRecord,
  firedAt: Date,
): ModelMessage[] {
  const header = scheduledRunHeader(job, firedAt);
  let framed = false;
  const events = job.events.map((event): ModelMessage => {
    if (framed || event.role !== "user") return event;
    framed = true;

    return {
      ...event,
      content:
        typeof event.content === "string"
          ? `${header}\n\n${event.content}`
          : [{ type: "text", text: header }, ...event.content],
    };
  });

  return framed ? events : [{ role: "user", content: header }, ...events];
}

/** Collapses a one-of `input`/`events` payload into the stored events list. */
function runPayloadToEvents(payload: {
  input?: unknown;
  events?: unknown;
}): ModelMessage[] {
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
}): ModelMessage[] | undefined {
  if (payload.input === undefined && payload.events === undefined)
    return undefined;

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

function scheduledRunHeader(job: CronRecord, firedAt: Date): string {
  const attributes = [
    `name="${job.name}"`,
    `schedule="${job.scheduleExpression}"`,
    ...(job.timezone ? [`timezone="${job.timezone}"`] : []),
  ].join(" ");
  const cadence = isOneTimeSchedule(job.scheduleExpression)
    ? "This was a one-time task: it is spent now and will not fire again."
    : "It keeps firing on this schedule until someone cancels it.";

  return `<scheduled-task ${attributes}>
The scheduler started this run at ${firedAt.toISOString()}. The instructions below are the ones stored when the task was set up on ${job.createdAt} — nobody typed them just now, and nobody is waiting on a prompt. Carry them out, then answer in this conversation the way you normally would.
${job.description ? `Why it exists: ${job.description}\n` : ""}${cadence}
A scheduled run has no scheduling tools at all: it cannot list, create, change, or cancel a schedule. Say what needs changing and leave it to the next person who asks.
</scheduled-task>`;
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
