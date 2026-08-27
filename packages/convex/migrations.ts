/**
 * One-off data migrations. Run each on every deployment (dev + production),
 * e.g. `bunx convex run migrations:clearDeprecatedAgentConfigToggles` — the
 * runtime-key rework ones BEFORE deploying the narrowed schema that drops
 * the corresponding fields/indexes. Each is idempotent and safe to re-run.
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

/**
 * Strip the deprecated per-agent `publicAccessEnabled` / `webSocketEnabled`
 * fields. Public access is now a stage-wide runtime key, so these are
 * unused; clearing them lets the schema drop the fields.
 * @returns count of agent configs patched
 */
export const clearDeprecatedAgentConfigToggles = internalMutation({
  args: {},
  returns: v.object({ patched: v.number() }),
  handler: async (ctx) => {
    const configs = await ctx.db.query("agentConfigs").collect();
    let patched = 0;
    for (const config of configs) {
      const record = config as Record<string, unknown>;
      if (
        record.publicAccessEnabled === undefined &&
        record.webSocketEnabled === undefined
      )
        continue;
      // Cast: these fields were dropped from the schema, so the typed patch
      // signature no longer accepts them; setting undefined unsets them.
      await ctx.db.patch(config._id, {
        publicAccessEnabled: undefined,
        webSocketEnabled: undefined,
      } as never);
      patched += 1;
    }

    return { patched: patched };
  },
});

/**
 * Delete legacy per-agent `agentDeployments` rows (those keyed by `agentConfigId`
 * instead of project/stage). They predate the stage-scoped key model and are
 * never resolved by `getByApiKeyHash` (it requires `accountId`); removing them
 * lets the schema drop the `agentConfigId` field and `by_agentConfigId` index.
 * @returns count of legacy rows deleted
 */
export const deleteLegacyAgentDeployments = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("agentDeployments").collect();
    let deleted = 0;
    for (const row of rows) {
      const record = row as Record<string, unknown>;
      // Stage-scoped rows set projectId; legacy rows only have agentConfigId.
      if (record.projectId !== undefined) continue;
      await ctx.db.delete(row._id);
      deleted += 1;
    }

    return { deleted: deleted };
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
