"use node";

/**
 * Node-runtime internal actions for account cron jobs (epic #85 phase 9,
 * stage 3): Convex owns the crons table writes and the matching EventBridge
 * Scheduler schedules directly, replacing core's former /v1/crons plane.
 * Schedules publish the {kind: "cron", accountId, cronId} payload onto the
 * cron-runs event bus (CRON_SCHEDULER_TARGET_ARN); the bus rule provisioned in
 * apps/core/sst.config.ts forwards it to the API destination that POSTs the
 * gateway /v1/cron-runs.
 */

import { randomBytes } from "node:crypto";
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ListSchedulesCommand,
  ResourceNotFoundException,
  UpdateScheduleCommand,
  type ListSchedulesCommandOutput,
} from "@aws-sdk/client-scheduler";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { schedulerClient } from "./model/aws";
import {
  isOneTimeSchedule,
  normalizeCreateCronInput,
  normalizeSchedulerGroupName,
  normalizeUpdateCronInput,
  toCronResponse,
} from "./model/cronRules";

// Run rows are deleted with their cron in batches: a long-lived job can hold
// more history than one Convex transaction may touch.
const CRON_RUN_DELETE_BATCH_SIZE = 100;
// How many cron rows one maintenance sweep reads.
const CRON_SWEEP_SCAN_LIMIT = 1000;

/**
 * Resolved EventBridge Scheduler target configuration from the deployment
 * environment: the cron-runs event bus ARN, the role schedules assume, and
 * the group name.
 */
interface SchedulerTarget {
  targetArn: string;
  roleArn: string;
  groupName: string;
}

function schedulerTargetEnv(): SchedulerTarget {
  const targetArn = process.env.CRON_SCHEDULER_TARGET_ARN;
  const roleArn = process.env.CRON_SCHEDULER_ROLE_ARN;
  const groupName = process.env.CRON_SCHEDULER_GROUP_NAME;
  if (!targetArn || !roleArn || !groupName) {
    throw new Error(
      "Cron schedules require CRON_SCHEDULER_TARGET_ARN, CRON_SCHEDULER_ROLE_ARN, and CRON_SCHEDULER_GROUP_NAME",
    );
  }

  return {
    targetArn: targetArn,
    roleArn: roleArn,
    groupName: normalizeSchedulerGroupName(groupName),
  };
}

/**
 * Create a cron job: validate the input, insert the crons row, then create the
 * EventBridge schedule. The row is rolled back when the schedule create fails.
 * @param accountId account id owning the cron job
 * @param input the create-cron request body
 * @returns the public cron record
 */
export const create = internalAction({
  args: { accountId: v.id("accounts"), input: v.any() },
  returns: v.any(),
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const target = schedulerTargetEnv();
    const normalized = normalizeCreateCronInput(args.input);
    const agentId = await requireAccountAgent(
      ctx,
      args.accountId,
      normalized.agentId,
    );
    const schedulerName = `${args.accountId}-${randomBytes(12).toString("hex")}`;

    const cronId: Id<"crons"> = await ctx.runMutation(internal.cron.create, {
      accountId: args.accountId,
      name: normalized.name,
      ...(normalized.description !== undefined
        ? { description: normalized.description }
        : {}),
      agentId: agentId,
      events: normalized.events,
      ...(normalized.conversationKey !== undefined
        ? { conversationKey: normalized.conversationKey }
        : {}),
      scheduleExpression: normalized.scheduleExpression,
      ...(normalized.timezone !== undefined
        ? { timezone: normalized.timezone }
        : {}),
      ...(normalized.status !== undefined ? { status: normalized.status } : {}),
      schedulerName: schedulerName,
      schedulerGroupName: target.groupName,
    });
    const created: Doc<"crons"> | null = await ctx.runQuery(
      internal.cron.getById,
      { accountId: args.accountId, cronId: cronId },
    );
    if (!created) throw new Error("Failed to fetch created cron job");

    const scheduler = await schedulerClient();
    try {
      await scheduler.send(
        new CreateScheduleCommand({
          Name: created.schedulerName,
          GroupName: created.schedulerGroupName,
          Description: scheduleDescription(created),
          ScheduleExpression: created.scheduleExpression,
          ...(created.timezone
            ? { ScheduleExpressionTimezone: created.timezone }
            : {}),
          State: created.status === "active" ? "ENABLED" : "DISABLED",
          ActionAfterCompletion: scheduleActionAfterCompletion(
            created.scheduleExpression,
          ),
          FlexibleTimeWindow: { Mode: "OFF" },
          Target: scheduleTarget(target, created),
        }),
      );
    } catch (err) {
      await ctx
        .runMutation(internal.cron.remove, {
          accountId: args.accountId,
          cronId: cronId,
        })
        .catch(() => {});
      throw err;
    }

    return toCronResponse(created);
  },
});

/**
 * Update a cron job: update the EventBridge schedule first, then patch the
 * crons row, mirroring core's former ordering so a schedule failure leaves the
 * stored job unchanged.
 * @param accountId account id owning the cron job
 * @param cronId the cron job id
 * @param patch the update-cron request body
 * @returns the refreshed public cron record, or null when the job is missing
 */
export const update = internalAction({
  args: { accountId: v.id("accounts"), cronId: v.string(), patch: v.any() },
  returns: v.any(),
  handler: async (ctx, args): Promise<Record<string, unknown> | null> => {
    const target = schedulerTargetEnv();
    const existing = await getOwnedCron(ctx, args.accountId, args.cronId);
    if (!existing) return null;
    const patch = normalizeUpdateCronInput(args.patch);
    if (patch.agentId !== undefined) {
      await requireAccountAgent(ctx, args.accountId, patch.agentId);
    }

    const scheduleExpression =
      patch.scheduleExpression ?? existing.scheduleExpression;
    const timezone =
      patch.timezone === null
        ? undefined
        : (patch.timezone ?? existing.timezone);
    const status = patch.status ?? existing.status;
    const scheduler = await schedulerClient();
    await scheduler.send(
      new UpdateScheduleCommand({
        Name: existing.schedulerName,
        GroupName: existing.schedulerGroupName,
        Description: scheduleDescription(existing),
        ScheduleExpression: scheduleExpression,
        ...(timezone ? { ScheduleExpressionTimezone: timezone } : {}),
        State: status === "active" ? "ENABLED" : "DISABLED",
        ActionAfterCompletion:
          scheduleActionAfterCompletion(scheduleExpression),
        FlexibleTimeWindow: { Mode: "OFF" },
        Target: scheduleTarget(target, existing),
      }),
    );

    await ctx.runMutation(internal.cron.update, {
      accountId: args.accountId,
      cronId: existing._id,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
      ...(patch.agentId !== undefined
        ? { agentId: patch.agentId as Id<"agents"> }
        : {}),
      ...(patch.events !== undefined ? { events: patch.events } : {}),
      ...(patch.conversationKey !== undefined
        ? { conversationKey: patch.conversationKey }
        : {}),
      ...(patch.scheduleExpression !== undefined
        ? { scheduleExpression: patch.scheduleExpression }
        : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    });
    const updated: Doc<"crons"> | null = await ctx.runQuery(
      internal.cron.getById,
      { accountId: args.accountId, cronId: existing._id },
    );

    return updated ? toCronResponse(updated) : null;
  },
});

/**
 * Delete a cron job and its EventBridge schedule. A schedule that is already
 * gone is not an error.
 * @param accountId account id owning the cron job
 * @param cronId the cron job id
 * @returns true when the job existed and was removed
 */
export const remove = internalAction({
  args: { accountId: v.id("accounts"), cronId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await getOwnedCron(ctx, args.accountId, args.cronId);
    if (!existing) return false;
    await deleteCronEverywhere(ctx, existing);

    return true;
  },
});

/**
 * Retire cron jobs that can never fire again, and the schedules no job owns.
 * Three kinds of litter, all from before one-time jobs cleaned up after
 * themselves: a spent `at(...)` job, a job whose agent was deleted, and an
 * EventBridge schedule whose row is gone. Defaults to a dry run — pass
 * `dryRun: false` to actually delete.
 * @param dryRun false to delete; anything else only reports
 * @param limit how many cron rows to scan
 * @returns counts per kind, and whether the scan saw every row
 */
export const sweepSpentCrons = internalAction({
  args: { dryRun: v.optional(v.boolean()), limit: v.optional(v.number()) },
  returns: v.object({
    scanned: v.number(),
    spentOneTime: v.number(),
    missingAgent: v.number(),
    orphanSchedules: v.number(),
    complete: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? CRON_SWEEP_SCAN_LIMIT;
    const crons: Doc<"crons">[] = await ctx.runQuery(internal.cron.listAll, {
      limit: limit,
    });
    const complete = crons.length < limit;
    const remaining = new Set<string>();
    let spentOneTime = 0;
    let missingAgent = 0;

    for (const cron of crons) {
      const spent =
        isOneTimeSchedule(cron.scheduleExpression) &&
        cron.lastInvokedAt !== undefined;
      // A spent job goes either way, so its agent never has to be read.
      if (!spent) {
        const agent = await ctx.runQuery(internal.agents.getById, {
          accountId: cron.accountId,
          agentId: cron.agentId,
        });
        if (agent) {
          remaining.add(cron.schedulerName);
          continue;
        }
      }
      if (spent) spentOneTime += 1;
      else missingAgent += 1;
      if (args.dryRun === false) await deleteCronEverywhere(ctx, cron);
      else remaining.add(cron.schedulerName);
    }

    return {
      scanned: crons.length,
      spentOneTime: spentOneTime,
      missingAgent: missingAgent,
      // A truncated scan cannot tell an orphan schedule from one whose row it
      // never read, and deleting on that guess would kill live jobs.
      orphanSchedules: complete
        ? await sweepOrphanSchedules(ctx, remaining, args.dryRun === false)
        : 0,
      complete: complete,
    };
  },
});

/**
 * Delete every schedule in the group that no cron row names. The caller must
 * have read every cron row first.
 * @param remaining scheduler names still owned by a cron row
 * @param apply false to only count
 * @returns how many schedules were orphaned
 */
async function sweepOrphanSchedules(
  ctx: ActionCtx,
  remaining: Set<string>,
  apply: boolean,
): Promise<number> {
  const target = schedulerTargetEnv();
  const scheduler = await schedulerClient();
  let nextToken: string | undefined = undefined;
  let orphans = 0;

  do {
    const page: ListSchedulesCommandOutput = await scheduler.send(
      new ListSchedulesCommand({
        GroupName: target.groupName,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }),
    );
    for (const schedule of page.Schedules ?? []) {
      if (!schedule.Name || remaining.has(schedule.Name)) continue;
      // A cron created after the row scan is missing from `remaining`, so read
      // the row again: without this the sweep deletes a live job's schedule.
      const owner = await ctx.runQuery(internal.cron.getBySchedulerName, {
        schedulerName: schedule.Name,
      });
      if (owner) continue;
      orphans += 1;
      if (apply) {
        await scheduler.send(
          new DeleteScheduleCommand({
            Name: schedule.Name,
            GroupName: target.groupName,
          }),
        );
      }
    }
    nextToken = page.NextToken;
  } while (nextToken);

  return orphans;
}

/**
 * Remove one cron job everywhere it exists: its EventBridge schedule, its run
 * history, then the row. A schedule that is already gone is not an error.
 */
async function deleteCronEverywhere(
  ctx: ActionCtx,
  cron: Doc<"crons">,
): Promise<void> {
  const scheduler = await schedulerClient();
  try {
    await scheduler.send(
      new DeleteScheduleCommand({
        Name: cron.schedulerName,
        GroupName: cron.schedulerGroupName,
      }),
    );
  } catch (err) {
    if (!(
      err instanceof ResourceNotFoundException ||
      (err instanceof Error && err.name === "ResourceNotFoundException")
    )) {
      throw err;
    }
  }
  // Run rows are only reachable through their cron, so they go with it.
  let deleted = 0;
  do {
    deleted = await ctx.runMutation(internal.cron.removeRuns, {
      accountId: cron.accountId,
      cronId: cron._id,
      limit: CRON_RUN_DELETE_BATCH_SIZE,
    });
  } while (deleted === CRON_RUN_DELETE_BATCH_SIZE);
  await ctx.runMutation(internal.cron.remove, {
    accountId: cron.accountId,
    cronId: cron._id,
  });
}

/**
 * Load a cron job by id scoped to the account, treating a malformed id as
 * missing rather than an argument error.
 */
async function getOwnedCron(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  cronId: string,
): Promise<Doc<"crons"> | null> {
  try {
    return await ctx.runQuery(internal.cron.getById, {
      accountId: accountId,
      cronId: cronId as Id<"crons">,
    });
  } catch {
    return null;
  }
}

/**
 * Resolve and validate that the agent exists and belongs to the account.
 * @returns the agent id typed for the crons table
 * @throws when the agent is missing or owned by another account
 */
async function requireAccountAgent(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  agentId: string,
): Promise<Id<"agents">> {
  const agent = await ctx
    .runQuery(internal.agents.getById, {
      accountId: accountId,
      agentId: agentId as Id<"agents">,
    })
    .catch(() => null);
  if (!agent) {
    throw new Error("Cron job agentId must reference an existing agent");
  }

  return agent._id;
}

function scheduleTarget(target: SchedulerTarget, job: Doc<"crons">) {
  return {
    Arn: target.targetArn,
    RoleArn: target.roleArn,
    // Templated EventBridge PutEvents target: Input becomes the event
    // detail; Source must match the cron-run bus rule in sst.config.ts.
    EventBridgeParameters: { DetailType: "cron-run", Source: "broods.crons" },
    Input: JSON.stringify({
      kind: "cron",
      accountId: job.accountId,
      cronId: job._id,
    }),
  };
}

/**
 * EventBridge reclaims a one-time schedule itself once it has fired; core then
 * drops the row when the run settles, so a fired job leaves nothing behind.
 */
function scheduleActionAfterCompletion(expression: string): "DELETE" | "NONE" {
  return isOneTimeSchedule(expression) ? "DELETE" : "NONE";
}

function scheduleDescription(job: Doc<"crons">): string {
  return `Cron job ${job._id} for account ${job.accountId}`;
}
