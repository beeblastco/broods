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
import { isCronsConfigured, type CronRecord } from "../_shared/storage/index.ts";
import { optionalEnv, requireEnv } from "../_shared/env.ts";

const scheduler = new SchedulerClient({ region: process.env.AWS_REGION });

export class CronsUnavailableError extends Error {
  constructor() {
    super("Cron jobs are unavailable");
  }
}

export function assertCronsAvailable(): void {
  if (
    !isCronsConfigured() ||
    !optionalEnv("CRON_SCHEDULER_TARGET_FUNCTION_ARN") ||
    !optionalEnv("CRON_SCHEDULER_ROLE_ARN") ||
    !optionalEnv("CRON_SCHEDULER_GROUP_NAME")
  ) {
    throw new CronsUnavailableError();
  }
}

export async function createCronSchedule(job: CronRecord): Promise<void> {
  assertCronsAvailable();

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

export async function updateCronSchedule(job: CronRecord): Promise<void> {
  assertCronsAvailable();

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

export async function deleteCronSchedule(job: CronRecord): Promise<void> {
  assertCronsAvailable();

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

function scheduleTarget(job: CronRecord) {
  return {
    Arn: requireEnv("CRON_SCHEDULER_TARGET_FUNCTION_ARN"),
    RoleArn: requireEnv("CRON_SCHEDULER_ROLE_ARN"),
    Input: JSON.stringify({
      kind: "cron",
      accountId: job.accountId,
      cronId: job.cronId,
    }),
  };
}

function scheduleDescription(job: CronRecord): string {
  return `Cron job ${job.cronId} for account ${job.accountId}`;
}
