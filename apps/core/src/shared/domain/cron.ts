/**
 * Cron-job records and patch-merge helpers for the runtime. Input
 * normalization lives in the config plane (packages/convex/model/cronRules.ts,
 * the single home of those rules).
 */

import {
  isOneTimeSchedule,
  normalizeUpdateCronInput as normalizeUpdateCronInputRule,
} from "@broods/convex/model/cronRules";
import type { JSONValue, ModelMessage } from "ai";

// Whether a schedule fires exactly once (an at(...) expression). Its
// scheduled run is spent once it has fired, so the stored job is dropped when
// that run settles.
export { isOneTimeSchedule };

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
} & (
  | { input?: string; events?: never }
  | { events?: ModelMessage[]; input?: never }
);

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
 * Validates an update patch with the config plane's normalizer, then re-types
 * the events list to the ModelMessage[] core stores. The rule checks the
 * payload shape only (non-empty array), exactly as core's former copy did, so
 * the assertion adds no trust the caller did not already have.
 */
export function normalizeUpdateCronInput(
  input: UpdateCronInput,
): NormalizedCronUpdate {
  return normalizeUpdateCronInputRule(input) as NormalizedCronUpdate;
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
