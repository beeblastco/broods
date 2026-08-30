/**
 * One-off data migrations. Run each on every deployment (dev + production),
 * e.g. `bunx convex run migrations:sunsetCustomTools`. Each is idempotent
 * and safe to re-run; completed migrations are deleted once every deployment
 * has run them.
 */

import type { AnyDataModel, GenericDatabaseWriter } from "convex/server";
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

// #331 phase 3: custom tools are sunset; MCP servers replace them. Deletes
// every accountTools row (the table is out of the schema, so it is reached
// untyped), the cliExternalResources snapshots of kind "tool", and any
// canvas-layout nodes still typed "tool" (plus their edges). Run once per
// deployment after the cutover deploy; the account-tools/ S3 prefix is swept
// separately (aws s3 rm --recursive s3://<ToolBundles>/account-tools/).
export const sunsetCustomTools = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    toolRows: v.number(),
    cliSnapshots: v.number(),
    layoutsPruned: v.number(),
  }),
  handler: async (ctx, args) => {
    const db = ctx.db as unknown as GenericDatabaseWriter<AnyDataModel>;
    const toolRows = await db.query("accountTools").collect();
    for (const row of toolRows) {
      if (args.dryRun !== true) await db.delete(row._id);
    }

    const snapshots = (
      await ctx.db.query("cliExternalResources").collect()
    ).filter((row) => row.kind === "tool");
    for (const row of snapshots) {
      if (args.dryRun !== true) await ctx.db.delete(row._id);
    }

    let layoutsPruned = 0;
    const layouts = await ctx.db.query("canvasLayouts").collect();
    for (const layout of layouts) {
      const nodes = layout.nodes as Array<Record<string, unknown>>;
      const kept = nodes.filter((node) => node.type !== "tool");
      if (kept.length === nodes.length) continue;
      const keptIds = new Set(kept.map((node) => node.id));
      const edges = (layout.edges as Array<Record<string, unknown>>).filter(
        (edge) => keptIds.has(edge.source) && keptIds.has(edge.target),
      );
      layoutsPruned += 1;
      if (args.dryRun !== true) {
        await ctx.db.patch(layout._id, { nodes: kept, edges: edges });
      }
    }

    return {
      toolRows: toolRows.length,
      cliSnapshots: snapshots.length,
      layoutsPruned: layoutsPruned,
    };
  },
});
