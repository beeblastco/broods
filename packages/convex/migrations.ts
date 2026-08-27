/**
 * One-off data migrations. Run each on every deployment (dev + production),
 * e.g. `bunx convex run migrations:deleteOrphanedTools`. Each is idempotent
 * and safe to re-run; completed migrations are deleted once every deployment
 * has run them.
 */

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
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

// Drop custom tools no stage owns: unscoped rows from the old
// account-scoped path, tombstones, and rows whose stage is gone.
export const deleteOrphanedTools = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    unscoped: v.number(),
    softDeleted: v.number(),
    danglingStage: v.number(),
    kept: v.number(),
  }),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("accountTools").collect();
    let unscoped = 0;
    let softDeleted = 0;
    let danglingStage = 0;
    let kept = 0;

    for (const row of rows) {
      let reason: "unscoped" | "softDeleted" | "danglingStage" | null = null;
      if (row.status === "deleted") reason = "softDeleted";
      else if (!row.stageId || !row.projectId) reason = "unscoped";
      else {
        // `create` rejects a pair whose stage sits under another project;
        // a row that holds one anyway is scope corruption, not a live tool.
        const stage = await ctx.db.get(row.stageId);
        if (!stage || stage.projectId !== row.projectId)
          reason = "danglingStage";
      }

      if (!reason) {
        kept += 1;
        continue;
      }
      if (reason === "unscoped") unscoped += 1;
      if (reason === "softDeleted") softDeleted += 1;
      if (reason === "danglingStage") danglingStage += 1;
      if (args.dryRun !== true) await ctx.db.delete(row._id);
    }

    return {
      unscoped: unscoped,
      softDeleted: softDeleted,
      danglingStage: danglingStage,
      kept: kept,
    };
  },
});
