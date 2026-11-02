/**
 * Model-facing schedules: create, list, update, cancel. Every schedule belongs
 * to the calling agent and the conversation it was created from.
 * Cron rows and schedule lifecycle stay in the config plane (agent/crons).
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  normalizeUpdateCronInput,
  type CronRecord,
  type UpdateCronInput,
} from "../../shared/domain/cron.ts";
import { getStorage } from "../../shared/storage.ts";
import { toolError, toolText } from "./utils.ts";

const SCHEDULE_EXPRESSION_DESCRIPTION =
  "Schedule expression. cron(...) takes six fields — minute hour day-of-month month day-of-week year — with ? for whichever day field is unused: cron(0 9 * * ? *) is every day at 09:00, cron(30 8 ? * MON *) is Mondays at 08:30. rate(...) repeats on an interval: rate(2 hours). at(...) fires once at a future local time and then deletes itself: at(2027-01-01T09:00:00).";

// The SDK validates every call against these before `execute` runs and hands a
// failure back to the model to retry.
const cronIdSchema = z.string().trim().min(1);
const scheduleSchema = z
  .string()
  .trim()
  .regex(/^(cron|rate|at)\(.+\)$/, {
    message: "schedule must be a cron(...), rate(...), or at(...) expression",
  })
  .describe(SCHEDULE_EXPRESSION_DESCRIPTION);
const nameSchema = z.string().trim().min(1).max(120);
const instructionsSchema = z.string().trim().min(1);

const cancelScheduleInput = z.strictObject({
  cronId: cronIdSchema.describe("Id of the scheduled task to cancel."),
});

const scheduleInput = z.strictObject({
  name: nameSchema.describe(
    "Short human-readable name for the task, e.g. 'daily-standup-summary'.",
  ),
  instructions: instructionsSchema.describe(
    "What to do when the task fires, written as a self-contained instruction: the run starts from the conversation history, not from this turn's context.",
  ),
  schedule: scheduleSchema,
  timezone: z
    .string()
    .describe(
      "Optional IANA timezone the schedule is read in, e.g. 'Asia/Ho_Chi_Minh'. Defaults to UTC.",
    )
    .optional(),
});

const updateScheduleInput = z.strictObject({
  cronId: cronIdSchema.describe("Id of the scheduled task to change."),
  name: nameSchema.describe("New human-readable name for the task.").optional(),
  instructions: instructionsSchema
    .describe(
      "Replacement instructions to run when the task fires. Replaces the stored ones outright.",
    )
    .optional(),
  schedule: scheduleSchema.optional(),
  timezone: z
    .string()
    .describe("IANA timezone the schedule is read in, e.g. 'Asia/Ho_Chi_Minh'.")
    .optional(),
  status: z
    .enum(["active", "paused"])
    .describe(
      "'paused' stops the task firing without deleting it; 'active' resumes it.",
    )
    .optional(),
});

export interface ScheduleContext {
  accountId: string;
  agentId: string;
  // Public conversation key of the session that owns the task. A channel
  // conversation makes the scheduled run reply in that channel.
  conversationKey: string;
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

export function cancelScheduleTool(context: ScheduleContext): ToolSet {
  return {
    cancel_schedule: tool({
      description:
        "Cancels one of your scheduled tasks for good, by the cronId that schedule or list_schedules reported. Its run history goes with it. A task that already fired once and deleted itself is simply gone.",
      inputSchema: cancelScheduleInput,
      execute: async function ({ cronId }): Promise<string> {
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
      inputSchema: z.strictObject({}),
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
      inputSchema: scheduleInput,
      execute: async function (input): Promise<string> {
        const created = await getStorage().crons.create(context.accountId, {
          name: input.name,
          agentId: context.agentId,
          input: input.instructions,
          conversationKey: context.conversationKey,
          scheduleExpression: input.schedule,
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
        "Changes one of your scheduled tasks in place, by the cronId that schedule or list_schedules reported. Only the fields you pass change; the rest stay as they are. Pause a task with status 'paused' to stop it firing while keeping it, and resume it with 'active'. Cancelling instead throws the task away. Instructions can only be rewritten from the conversation the task answers in.",
      inputSchema: updateScheduleInput,
      execute: async function (input): Promise<string> {
        const { cronId } = input;
        const patch: UpdateCronInput = {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.instructions !== undefined
            ? { input: input.instructions }
            : {}),
          ...(input.schedule !== undefined
            ? { scheduleExpression: input.schedule }
            : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        };
        if (Object.keys(patch).length === 0) {
          return toolError(
            "Pass at least one of name, instructions, schedule, timezone or status to change",
          );
        }
        // Same normalizer the config plane runs, so a rejected field fails here
        // with a message the model can act on instead of a Convex error frame.
        try {
          normalizeUpdateCronInput(patch);
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
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
        // Retiming and pausing are safe from anywhere, but rewriting the
        // instructions would drop model-chosen text into a conversation this
        // turn is not in.
        if (
          input.instructions !== undefined &&
          existing.conversationKey !== context.conversationKey
        ) {
          return toolError(
            `Scheduled task ${cronId} answers in another conversation, so its instructions can only be rewritten there. Its name, schedule, timezone and status can be changed from here.`,
          );
        }
        const updated = await getStorage().crons.update(
          context.accountId,
          cronId,
          patch,
        );
        if (!updated) {
          return toolError(`Scheduled task ${cronId} no longer exists`);
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
