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
 * fields. Public access is now an environment-wide runtime key, so these are
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
 * instead of project/environment). They predate the env-scoped key model and are
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
      // Env-scoped rows set projectId; legacy rows only have agentConfigId.
      if (record.projectId !== undefined) continue;
      await ctx.db.delete(row._id);
      deleted += 1;
    }

    return { deleted: deleted };
  },
});

/**
 * Drop custom tools that no environment owns. Tools became environment-scoped
 * resources, so a row with no `environmentId` (written by the old account-scoped
 * REST API or CLI sync) is unreachable — nothing lists it and nothing can clone
 * or delete it. Soft-deleted rows go too, along with rows whose environment has
 * since been deleted. Bundles in S3 are content-addressed and swept separately.
 * Run with `dryRun: true` first to see the counts.
 * @returns counts of rows deleted, by reason
 */
export const deleteOrphanedTools = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    unscoped: v.number(),
    softDeleted: v.number(),
    danglingEnvironment: v.number(),
    kept: v.number(),
  }),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("accountTools").collect();
    let unscoped = 0;
    let softDeleted = 0;
    let danglingEnvironment = 0;
    let kept = 0;

    for (const row of rows) {
      let reason: "unscoped" | "softDeleted" | "danglingEnvironment" | null =
        null;
      if (row.status === "deleted") reason = "softDeleted";
      else if (!row.environmentId || !row.projectId) reason = "unscoped";
      else if (!(await ctx.db.get(row.environmentId)))
        reason = "danglingEnvironment";

      if (!reason) {
        kept += 1;
        continue;
      }
      if (reason === "unscoped") unscoped += 1;
      if (reason === "softDeleted") softDeleted += 1;
      if (reason === "danglingEnvironment") danglingEnvironment += 1;
      if (args.dryRun !== true) await ctx.db.delete(row._id);
    }

    return {
      unscoped: unscoped,
      softDeleted: softDeleted,
      danglingEnvironment: danglingEnvironment,
      kept: kept,
    };
  },
});
