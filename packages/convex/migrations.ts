/**
 * One-off data migrations. Run each on every deployment (dev + production),
 * e.g. `bunx convex run migrations:backfillUsageRollupGrains`. Each is idempotent
 * and safe to re-run; completed migrations are deleted once every deployment
 * has run them.
 */

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { cronSchedules, registerSchedule } from "./model/cronSchedules";
import { stageKindForName } from "./stage";
import { USAGE_GRAIN_MS, foldRollupBucket } from "./usage";

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
      const unsetEventBridge =
        cron.schedulerName !== undefined
          ? { schedulerName: undefined, schedulerGroupName: undefined }
          : null;
      // Short-circuit keeps the component lookup off non-active rows.
      if (
        cron.status !== "active" ||
        cron.scheduledRunId !== undefined ||
        (await cronSchedules.get(ctx, { name: cron._id })) !== null
      ) {
        if (unsetEventBridge) await ctx.db.patch(cron._id, unsetEventBridge);
        skipped += 1;
        continue;
      }
      // "skip" a one-time job whose instant already passed: it fired (or was
      // missed) under EventBridge, and re-registering would fire it again.
      const schedule = await registerSchedule(ctx, cron, { onPastAt: "skip" });
      await ctx.db.patch(cron._id, {
        ...unsetEventBridge,
        ...(schedule.scheduledRunId !== undefined
          ? { scheduledRunId: schedule.scheduledRunId }
          : {}),
      });
      if (schedule.registered) registered += 1;
      else skipped += 1;
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

/**
 * Give every pre-org project its owner's org so `projects.orgId` can become
 * required. The org is the creator's active org when they are still a member
 * of it, else the org they own, else their longest-standing membership. A
 * project whose creator has no org at all is counted in `unresolved`, named
 * in the deployment log and left alone: the schema cannot tighten until that
 * count is zero everywhere.
 * Idempotent, paginated, self-rescheduling. Kick off with no args.
 * @returns rows patched and left unresolved in this batch, and whether the walk finished
 */
export const backfillProjectOrgIds = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({
    patched: v.number(),
    unresolved: v.number(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("projects")
      .paginate({ numItems: 100, cursor: args.cursor ?? null });

    let patched = 0;
    let unresolved = 0;
    for (const project of page.page) {
      if (project.orgId !== undefined) continue;
      const orgId = await orgForAuthId(ctx, project.authId);
      if (orgId === null) {
        console.warn(
          `backfillProjectOrgIds: project ${project._id} (${project.slug}) has no org for creator ${project.authId}`,
        );
        unresolved += 1;
        continue;
      }
      await ctx.db.patch(project._id, { orgId: orgId });
      patched += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.backfillProjectOrgIds,
        {
          cursor: page.continueCursor,
        },
      );
    }

    return { patched: patched, unresolved: unresolved, isDone: page.isDone };
  },
});

/**
 * Stamp every stage that predates `kind` with the role its name implied, the
 * same rule `stageKindForName` has applied on read, so `stages.kind` can
 * become required. A project whose only stage is a kind-less "Production"
 * gets what `stage.ensureDefault` would have given it on the next admin load:
 * that row was the dev workspace, so it becomes Development and the default,
 * instead of a fresh empty Development demoting it. Idempotent, paginated,
 * self-rescheduling. Kick off with no args.
 * @returns rows patched in this batch and whether the walk finished
 */
export const backfillStageKinds = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ patched: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("stages")
      .paginate({ numItems: 100, cursor: args.cursor ?? null });

    let patched = 0;
    for (const stage of page.page) {
      if (stage.kind !== undefined) continue;
      const siblings = await ctx.db
        .query("stages")
        .withIndex("by_projectId", (q) => q.eq("projectId", stage.projectId))
        .collect();
      const lonePromotedProduction =
        siblings.length === 1 && stageKindForName(stage) === "production";
      if (lonePromotedProduction) {
        const now = Date.now();
        await ctx.db.patch(stage._id, {
          name: "Development",
          kind: "development",
          deploymentRegion: undefined,
          isDefault: true,
          updatedAt: now,
        });
        await ctx.db.patch(stage.projectId, { updatedAt: now });
      } else {
        await ctx.db.patch(stage._id, { kind: stageKindForName(stage) });
      }
      patched += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillStageKinds, {
        cursor: page.continueCursor,
      });
    }

    return { patched: patched, isDone: page.isDone };
  },
});

async function orgForAuthId(
  ctx: MutationCtx,
  authId: string,
): Promise<Id<"orgs"> | null> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_authId", (q) => q.eq("authId", authId))
    .unique();
  const memberships = user
    ? await ctx.db
        .query("orgMembers")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .collect()
    : [];
  if (
    user?.activeOrgId &&
    memberships.some((membership) => membership.orgId === user.activeOrgId)
  ) {
    return user.activeOrgId;
  }
  const owned = await ctx.db
    .query("orgs")
    .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", authId))
    .first();
  if (owned) return owned._id;
  const earliest = memberships.sort(
    (left, right) => left.createdAt - right.createdAt,
  )[0];

  return earliest?.orgId ?? null;
}
