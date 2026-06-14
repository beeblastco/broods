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
            if (record.publicAccessEnabled === undefined && record.webSocketEnabled === undefined) continue;
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
