/**
 * EventBridge Scheduler wiring for account cron jobs.
 * Keep AWS schedule mutations separate from DynamoDB cron job persistence.
 */

import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import type { CronJobRecord } from "../_shared/storage/index.ts";
import { optionalEnv, requireEnv } from "../_shared/env.ts";

const scheduler = new SchedulerClient({ region: process.env.AWS_REGION });

export class CronJobsUnavailableError extends Error {
  constructor() {
    super("Cron jobs are unavailable");
  }
}

export function assertCronJobsAvailable(): void {
  if (
    !optionalEnv("CRON_JOBS_TABLE_NAME") ||
    !optionalEnv("CRON_SCHEDULER_TARGET_FUNCTION_ARN") ||
    !optionalEnv("CRON_SCHEDULER_ROLE_ARN") ||
    !optionalEnv("CRON_SCHEDULER_GROUP_NAME")
  ) {
    throw new CronJobsUnavailableError();
  }
}

export async function createCronSchedule(job: CronJobRecord): Promise<void> {
  assertCronJobsAvailable();

  await scheduler.send(new CreateScheduleCommand({
    Name: job.schedulerName,
    GroupName: job.schedulerGroupName,
    Description: scheduleDescription(job),
    ScheduleExpression: job.scheduleExpression,
    ...(job.timezone ? { ScheduleExpressionTimezone: job.timezone } : {}),
    State: job.status === "active" ? "ENABLED" : "DISABLED",
    FlexibleTimeWindow: { Mode: "OFF" },
    Target: scheduleTarget(job),
  }));
}

export async function updateCronSchedule(job: CronJobRecord): Promise<void> {
  assertCronJobsAvailable();

  await scheduler.send(new UpdateScheduleCommand({
    Name: job.schedulerName,
    GroupName: job.schedulerGroupName,
    Description: scheduleDescription(job),
    ScheduleExpression: job.scheduleExpression,
    ...(job.timezone ? { ScheduleExpressionTimezone: job.timezone } : {}),
    State: job.status === "active" ? "ENABLED" : "DISABLED",
    FlexibleTimeWindow: { Mode: "OFF" },
    Target: scheduleTarget(job),
  }));
}

export async function deleteCronSchedule(job: CronJobRecord): Promise<void> {
  assertCronJobsAvailable();

  try {
    await scheduler.send(new DeleteScheduleCommand({
      Name: job.schedulerName,
      GroupName: job.schedulerGroupName,
    }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException || (err instanceof Error && err.name === "ResourceNotFoundException")) {
      return;
    }
    throw err;
  }
}

export function schedulerGroupName(): string {
  return requireEnv("CRON_SCHEDULER_GROUP_NAME");
}

function scheduleTarget(job: CronJobRecord) {
  return {
    Arn: requireEnv("CRON_SCHEDULER_TARGET_FUNCTION_ARN"),
    RoleArn: requireEnv("CRON_SCHEDULER_ROLE_ARN"),
    Input: JSON.stringify({
      kind: "cron-job",
      accountId: job.accountId,
      cronJobId: job.cronJobId,
    }),
  };
}

function scheduleDescription(job: CronJobRecord): string {
  return `Cron job ${job.cronJobId} for account ${job.accountId}`;
}
