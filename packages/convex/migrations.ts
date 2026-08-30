/**
 * One-off data migrations. Run each on every deployment (dev + production),
 * e.g. `bunx convex run migrations:backfillUsageRollupGrains`. Each is idempotent
 * and safe to re-run; completed migrations are deleted once every deployment
 * has run them.
 */

import { Crons } from "@convex-dev/crons";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { translateScheduleExpression } from "./model/cronRules";
import { USAGE_GRAIN_MS, foldRollupBucket } from "./usage";

const cronSchedules = new Crons(components.crons);

/**
 * Stamp pre-grain `usageRollups` rows with `grain: "5m"` (their implicit
 * grain) and fold each one's counters into the matching hour and day buckets
 * so history stays visible at coarse grains. Walks the table in batches of
 * 100 via a pagination cursor and reschedules itself until done; rows that
 * already carry a grain are skipped, so re-running never double-counts.
 * Never deletes rows. Kick off with no args.
 * @returns rows patched in this batch and whether the walk finished
 */
export const backfillUsageRollupGrains = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ patched: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("usageRollups")
      .paginate({ numItems: 100, cursor: args.cursor ?? null });

    let patched = 0;
    for (const row of page.page) {
      if (row.grain !== undefined) continue;
      await ctx.db.patch(row._id, { grain: "5m" });
      for (const grain of ["hour", "day"] as const) {
        const grainMs = USAGE_GRAIN_MS[grain];
        await foldRollupBucket(ctx, {
          accountId: row.accountId,
          endpointId: row.endpointId,
          grain: grain,
          bucketStart: Math.floor(row.bucketStart / grainMs) * grainMs,
          modelProvider: row.modelProvider,
          modelId: row.modelId,
          counters: {
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            reasoningTokens: row.reasoningTokens,
            cachedInputTokens: row.cachedInputTokens,
            cacheWriteTokens: row.cacheWriteTokens,
            totalTokens: row.totalTokens,
            runtimeWallMs: row.runtimeWallMs,
            agentSandboxCpuUsec: row.agentSandboxCpuUsec,
            toolSandboxCpuUsec: row.toolSandboxCpuUsec,
            invocations: row.invocations,
            modelCalls: row.modelCalls,
          },
        });
      }
      patched += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.backfillUsageRollupGrains,
        { cursor: page.continueCursor },
      );
    }

    return { patched: patched, isDone: page.isDone };
  },
});

/**
 * Cut per-account cron scheduling over from EventBridge Scheduler to the
 * Convex crons component: register every live cron row through the component
 * (one-time at(...) jobs go to the Convex scheduler) and unset the dead
 * EventBridge identifiers. Idempotent — rows already registered are skipped —
 * and paginated with a self-reschedule, like the other backfills. The
 * EventBridge schedules themselves die with the schedule group when the
 * updated sst.config.ts deploys; run this right after the Convex deploy so
 * no schedule window is missed.
 * @returns rows registered and skipped in this batch, and whether the walk finished
 */
export const migrateCronsToConvexScheduler = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({
    registered: v.number(),
    skipped: v.number(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crons")
      .paginate({ numItems: 50, cursor: args.cursor ?? null });

    let registered = 0;
    let skipped = 0;
    for (const cron of page.page) {
      if (cron.schedulerName !== undefined) {
        await ctx.db.patch(cron._id, {
          schedulerName: undefined,
          schedulerGroupName: undefined,
        });
      }
      const alreadyRegistered =
        cron.scheduledRunId !== undefined ||
        (await cronSchedules.get(ctx, { name: cron._id })) !== null;
      if (cron.status !== "active" || alreadyRegistered) {
        skipped += 1;
        continue;
      }
      const schedule = translateScheduleExpression(
        cron.scheduleExpression,
        cron.timezone,
      );
      if (schedule.kind === "at") {
        // A one-time job whose instant already passed fired (or was missed)
        // under EventBridge; re-registering it would fire it again now.
        if (schedule.timestamp <= Date.now()) {
          skipped += 1;
          continue;
        }
        const scheduledRunId = await ctx.scheduler.runAt(
          schedule.timestamp,
          internal.agent.crons.dispatch,
          { accountId: cron.accountId, cronId: cron._id },
        );
        await ctx.db.patch(cron._id, { scheduledRunId: scheduledRunId });
      } else {
        await cronSchedules.register(
          ctx,
          schedule,
          internal.agent.crons.dispatch,
          { accountId: cron.accountId, cronId: cron._id },
          cron._id,
        );
      }
      registered += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.migrateCronsToConvexScheduler,
        { cursor: page.continueCursor },
      );
    }

    return { registered: registered, skipped: skipped, isDone: page.isDone };
  },
});
