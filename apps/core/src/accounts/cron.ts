/**
 * EventBridge Scheduler cleanup for account deletion. Cron CRUD (and schedule
 * create/update) lives in the Convex config plane (packages/convex/awsCrons.ts);
 * core only deletes leftover schedules when an account is removed.
 */

import {
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
} from "@aws-sdk/client-scheduler";
import type { CronRecord } from "../shared/domain/cron.ts";

const scheduler = new SchedulerClient({ region: process.env.AWS_REGION });

export async function deleteCronSchedule(job: CronRecord): Promise<void> {
  try {
    await scheduler.send(
      new DeleteScheduleCommand({
        Name: job.schedulerName,
        GroupName: job.schedulerGroupName,
      }),
    );
  } catch (err) {
    if (
      err instanceof ResourceNotFoundException ||
      (err instanceof Error && err.name === "ResourceNotFoundException")
    ) {
      return;
    }
    throw err;
  }
}
