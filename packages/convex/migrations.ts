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

/**
 * Drop the tombstones every remove path leaves behind. `accountTools`,
 * `accountHooks`, `agentPolicies` and `channelRecords` are the four soft-delete
 * tables: the dashboard, the internal mutations and `broods deploy --prune` all
 * patch `status: "deleted"` rather than dropping the row, so tombstones survive
 * until the owning stage or account is torn down. Run with `dryRun` first.
 * @returns count of tombstones dropped per table
 */
export const purgeSoftDeletedRows = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    accountHooks: v.number(),
    accountTools: v.number(),
    agentPolicies: v.number(),
    channelRecords: v.number(),
  }),
  handler: async (ctx, args) => {
    const purged = {
      accountHooks: 0,
      accountTools: 0,
      agentPolicies: 0,
      channelRecords: 0,
    };
    // No `by_status` index on these tables, so scan and filter, the same way
    // `deleteOrphanedTools` above walks `accountTools`.
    const tables = [
      "accountHooks",
      "accountTools",
      "agentPolicies",
      "channelRecords",
    ] as const;

    for (const table of tables) {
      const rows = await ctx.db.query(table).collect();
      for (const row of rows) {
        if (row.status !== "deleted") continue;
        if (args.dryRun !== true) await ctx.db.delete(row._id);
        purged[table] += 1;
      }
    }

    return purged;
  },
});
