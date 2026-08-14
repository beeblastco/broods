/**
 * One-off data migrations for the runtime-key rework. Run each on every
 * deployment (dev + production) BEFORE deploying the narrowed schema that drops
 * the corresponding fields/indexes, e.g. `bunx convex run migrations:clearDeprecatedAgentConfigToggles`.
 * Each is idempotent and safe to re-run.
 */

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

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

// Drop cron run rows whose cron job is gone. Deleting a job used to leave its
// history behind, and nothing can reach those rows: run listings resolve the
// job first. Paginated — pass the returned cursor back until isDone.
export const deleteOrphanedCronRuns = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    scanned: v.number(),
    orphaned: v.number(),
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("cronRuns").paginate({
      numItems: args.numItems ?? 200,
      cursor: args.cursor ?? null,
    });
    let orphaned = 0;
    for (const run of page.page) {
      if (await ctx.db.get(run.cronId)) continue;
      orphaned += 1;
      if (args.dryRun !== true) await ctx.db.delete(run._id);
    }

    return {
      scanned: page.page.length,
      orphaned: orphaned,
      cursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  },
});
