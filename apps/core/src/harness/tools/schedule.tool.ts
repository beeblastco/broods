/**
 * Model-facing schedules: create, list, update, cancel. Every schedule belongs
 * to the calling agent and the conversation it was created from.
 * Cron rows and EventBridge lifecycle stay in the config plane (awsCrons).
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type {
  CronRecord,
  CronStatus,
  UpdateCronInput,
} from "../../shared/domain/cron.ts";
import { getStorage } from "../../shared/storage.ts";
import { toolError, toolText } from "./utils.ts";

const SCHEDULE_EXPRESSION_DESCRIPTION =
  "EventBridge Scheduler expression. cron(...) takes six fields — minute hour day-of-month month day-of-week year — with ? for whichever day field is unused: cron(0 9 * * ? *) is every day at 09:00, cron(30 8 ? * MON *) is Mondays at 08:30. rate(...) repeats on an interval: rate(2 hours). at(...) fires once at a future local time and then deletes itself: at(2027-01-01T09:00:00).";
const SCHEDULE_PATTERN = /^(cron|rate|at)\(.+\)$/;

export interface ScheduleContext {
  accountId: string;
  agentId: string;
  // Public conversation key of the session that owns the task. A channel
  // conversation makes the scheduled run reply in that channel.
  conversationKey: string;
}

interface CancelScheduleInput {
  cronId: string;
}

interface ScheduleInput {
  name: string;
  instructions: string;
  schedule: string;
  timezone?: string;
}

interface ScheduleSummary {
  cronId: string;
  name: string;
  schedule: string;
  status: string;
  timezone?: string;
  conversationKey?: string;
  lastStatus?: string;
  lastInvokedAt?: string;
}

interface UpdateScheduleInput {
  cronId: string;
  name?: string;
  instructions?: string;
  schedule?: string;
  timezone?: string;
  status?: CronStatus;
}

export function cancelScheduleTool(context: ScheduleContext): ToolSet {
  return {
    cancel_schedule: tool({
      description:
        "Cancels one of your scheduled tasks for good, by the cronId that schedule or list_schedules reported. Its run history goes with it. A task that already fired once and deleted itself is simply gone.",
      inputSchema: jsonSchema<CancelScheduleInput>({
        type: "object",
        properties: {
          cronId: {
            type: "string",
            minLength: 1,
            description: "Id of the scheduled task to cancel.",
          },
        },
        required: ["cronId"],
        additionalProperties: false,
      }),
      execute: async function (input): Promise<string> {
        const cronId = input.cronId.trim();
        // A malformed id is a rejected argument in the config plane, not a
        // miss, so treat any lookup failure as "no such task".
        const existing = await getStorage()
          .crons.getById(context.accountId, cronId)
          .catch(() => null);
        if (!existing || existing.agentId !== context.agentId) {
          return toolError(`No scheduled task ${cronId} belongs to this agent`);
        }
        await getStorage().crons.remove(context.accountId, cronId);

        return toolText(
          `Cancelled scheduled task '${existing.name}' (${cronId}).`,
        );
      },
    }),
  };
}

export function listSchedulesTool(context: ScheduleContext): ToolSet {
  return {
    list_schedules: tool({
      description:
        "Lists every scheduled task you own, including ones scheduled from other conversations and ones an account owner created for you. `conversationKey` tells you where each task answers.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async function (): Promise<{ schedules: ScheduleSummary[] }> {
        const crons = await getStorage().crons.list(
          context.accountId,
          context.agentId,
        );

        return { schedules: crons.map(toScheduleSummary) };
      },
    }),
  };
}

export function scheduleTool(context: ScheduleContext): ToolSet {
  return {
    schedule: tool({
      description:
        "Schedules a task for yourself. Each time it fires you start a fresh run in this same conversation with the stored instructions, and the answer is delivered back here. A one-time task deletes itself once it has run; a recurring one keeps firing until it is cancelled.",
      inputSchema: jsonSchema<ScheduleInput>({
        type: "object",
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: 120,
            description:
              "Short human-readable name for the task, e.g. 'daily-standup-summary'.",
          },
          instructions: {
            type: "string",
            minLength: 1,
            description:
              "What to do when the task fires, written as a self-contained instruction: the run starts from the conversation history, not from this turn's context.",
          },
          schedule: {
            type: "string",
            description: SCHEDULE_EXPRESSION_DESCRIPTION,
          },
          timezone: {
            type: "string",
            description:
              "Optional IANA timezone the schedule is read in, e.g. 'Asia/Ho_Chi_Minh'. Defaults to UTC.",
          },
        },
        required: ["name", "instructions", "schedule"],
        additionalProperties: false,
      }),
      execute: async function (input): Promise<string> {
        const schedule = input.schedule.trim();
        if (!SCHEDULE_PATTERN.test(schedule)) {
          return toolError(
            `schedule must be a cron(...), rate(...), or at(...) expression, got '${schedule}'`,
          );
        }

        const created = await getStorage().crons.create(context.accountId, {
          name: input.name,
          agentId: context.agentId,
          input: input.instructions,
          conversationKey: context.conversationKey,
          scheduleExpression: schedule,
          ...(input.timezone ? { timezone: input.timezone } : {}),
        });

        return toolText(
          `Scheduled task '${created.name}' (${created.cronId}) on ${created.scheduleExpression}${
            created.timezone ? ` in ${created.timezone}` : " in UTC"
          }. It runs in this conversation.`,
        );
      },
    }),
  };
}

export function updateScheduleTool(context: ScheduleContext): ToolSet {
  return {
    update_schedule: tool({
      description:
        "Changes one of your scheduled tasks in place, by the cronId that schedule or list_schedules reported. Only the fields you pass change; the rest stay as they are. Pause a task with status 'paused' to stop it firing while keeping it, and resume it with 'active' — cancelling instead throws the task away.",
      inputSchema: jsonSchema<UpdateScheduleInput>({
        type: "object",
        properties: {
          cronId: {
            type: "string",
            minLength: 1,
            description: "Id of the scheduled task to change.",
          },
          name: {
            type: "string",
            minLength: 1,
            maxLength: 120,
            description: "New human-readable name for the task.",
          },
          instructions: {
            type: "string",
            minLength: 1,
            description:
              "Replacement instructions to run when the task fires. Replaces the stored ones outright.",
          },
          schedule: {
            type: "string",
            description: SCHEDULE_EXPRESSION_DESCRIPTION,
          },
          timezone: {
            type: "string",
            description:
              "IANA timezone the schedule is read in, e.g. 'Asia/Ho_Chi_Minh'.",
          },
          status: {
            type: "string",
            enum: ["active", "paused"],
            description:
              "'paused' stops the task firing without deleting it; 'active' resumes it.",
          },
        },
        required: ["cronId"],
        additionalProperties: false,
      }),
      execute: async function (input): Promise<string> {
        const cronId = input.cronId.trim();
        const schedule = input.schedule?.trim();
        if (schedule !== undefined && !SCHEDULE_PATTERN.test(schedule)) {
          return toolError(
            `schedule must be a cron(...), rate(...), or at(...) expression, got '${schedule}'`,
          );
        }
        const patch: UpdateCronInput = {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.instructions !== undefined
            ? { input: input.instructions }
            : {}),
          ...(schedule !== undefined ? { scheduleExpression: schedule } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        };
        if (Object.keys(patch).length === 0) {
          return toolError(
            "Pass at least one of name, instructions, schedule, timezone or status to change",
          );
        }

        // The config plane only fences on account, so the agent fence is here:
        // read the task first and refuse one that belongs to another agent.
        const existing = await getStorage()
          .crons.getById(context.accountId, cronId)
          .catch(() => null);
        if (!existing || existing.agentId !== context.agentId) {
          return toolError(`No scheduled task ${cronId} belongs to this agent`);
        }
        const updated = await getStorage().crons.update(
          context.accountId,
          cronId,
          patch,
        );
        if (!updated) {
          return toolError(`No scheduled task ${cronId} belongs to this agent`);
        }

        return toolText(
          `Updated scheduled task '${updated.name}' (${updated.cronId}): ${updated.scheduleExpression}${
            updated.timezone ? ` in ${updated.timezone}` : " in UTC"
          }, ${updated.status}.`,
        );
      },
    }),
  };
}

function toScheduleSummary(cron: CronRecord): ScheduleSummary {
  return {
    cronId: cron.cronId,
    name: cron.name,
    schedule: cron.scheduleExpression,
    status: cron.status,
    ...(cron.timezone ? { timezone: cron.timezone } : {}),
    ...(cron.conversationKey ? { conversationKey: cron.conversationKey } : {}),
    ...(cron.lastStatus ? { lastStatus: cron.lastStatus } : {}),
    ...(cron.lastInvokedAt ? { lastInvokedAt: cron.lastInvokedAt } : {}),
  };
}
