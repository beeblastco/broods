import {
  isOneTimeSchedule,
  normalizeUpdateCronInput as normalizeUpdateCronInputRule,
} from "@broods/convex/model/cronRules";
import type { JSONValue, ModelMessage } from "ai";

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

// The rule only checks events is a non-empty array; the cast re-types it to core's ModelMessage[].
export function normalizeUpdateCronInput(
  input: UpdateCronInput,
): NormalizedCronUpdate {
  return normalizeUpdateCronInputRule(input) as NormalizedCronUpdate;
}

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
