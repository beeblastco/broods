/**
 * Model-facing scheduled-task creation, bound to the calling conversation.
 * Cron row and EventBridge lifecycle stay in the config plane (awsCrons).
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import { getStorage } from "../../shared/storage.ts";
import { toolError, toolText } from "./utils.ts";

// Recurring schedules only. A one-time at(...) schedule outlives its single run
// on the AWS side, and nothing here reclaims it.
const RECURRING_SCHEDULE_PATTERN = /^(cron|rate)\(.+\)$/;

export interface ScheduleTaskContext {
  accountId: string;
  agentId: string;
  // Public conversation key of the session that owns the task. A channel
  // conversation makes the scheduled run reply in that channel.
  conversationKey: string;
}

interface ScheduleTaskInput {
  name: string;
  instructions: string;
  schedule: string;
  timezone?: string;
}

export default function scheduleTaskTool(
  context: ScheduleTaskContext,
): ToolSet {
  return {
    schedule_task: tool({
      description:
        "Schedules a recurring task for yourself. Each time it fires you start a fresh run in this same conversation with the stored instructions, and the answer is delivered back here. Use it for standing work the user asks for on a schedule, never for a single reminder. Removing or pausing a task is not possible from here — the owner does that from the dashboard or the account API.",
      inputSchema: jsonSchema<ScheduleTaskInput>({
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
            description:
              "EventBridge Scheduler expression. cron(...) takes six fields — minute hour day-of-month month day-of-week year — with ? for whichever day field is unused: cron(0 9 * * ? *) is every day at 09:00, cron(30 8 ? * MON *) is Mondays at 08:30. rate(...) takes a value and unit: rate(2 hours). One-time at(...) schedules are refused.",
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
        if (!RECURRING_SCHEDULE_PATTERN.test(schedule)) {
          return toolError(
            `schedule must be a recurring cron(...) or rate(...) expression, got '${schedule}'`,
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
