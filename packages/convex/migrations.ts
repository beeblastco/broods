/**
 * One-off data migrations. Run each on every deployment (dev + production),
 * e.g. `bunx convex run migrations:stripSessionNodes`. Each is idempotent
 * and safe to re-run; completed migrations are deleted once every deployment
 * has run them.
 */

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { decryptApiKey, runtimeKeyFields } from "./agent/deployments";
import { RUNTIME_KEY_PREFIX } from "./model/accountSecrets";
import { ROLE_ID_PREFIX } from "./model/roleRules";

const OLD_ROLE_ID_PREFIX = "fp_role_";
const OLD_RUNTIME_KEY_PREFIXES = ["sk_", "fp_agent_"];

/** What one batch of a prefix migration did, and whether its walk finished. */
const prefixBatchValidator = v.object({
  migrated: v.number(),
  skipped: v.number(),
  isDone: v.boolean(),
});

type PrefixBatch = { migrated: number; skipped: number; isDone: boolean };

/**
 * Rewrite every stored runtime key under the `bsk_` prefix, keeping its
 * random body: decrypt, swap the `sk_`/`fp_agent_` prefix, then store the new
 * hash, hint and at-rest blob. Callers then use the same key with `bsk_` in
 * front; `broods dev` and `broods stage use` write it to `.env.local`.
 * Idempotent: a row already on `bsk_` is skipped. Paginated with a
 * self-reschedule, like the other backfills.
 * @returns rows migrated and skipped in this batch and whether the walk finished
 */
export const runtimeKeyPrefix = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: prefixBatchValidator,
  handler: async (ctx, args): Promise<PrefixBatch> => {
    const page = await ctx.db
      .query("agentDeployments")
      .paginate({ numItems: 100, cursor: args.cursor ?? null });

    let migrated = 0;
    let skipped = 0;
    for (const deployment of page.page) {
      const rawApiKey = await decryptApiKey(deployment);
      const oldPrefix = OLD_RUNTIME_KEY_PREFIXES.find((prefix) =>
        rawApiKey.startsWith(prefix),
      );
      if (!oldPrefix) {
        skipped += 1;
        continue;
      }

      const rebranded = `${RUNTIME_KEY_PREFIX}${rawApiKey.slice(oldPrefix.length)}`;
      await ctx.db.patch(deployment._id, {
        ...(await runtimeKeyFields(rebranded)),
        updatedAt: Date.now(),
      });
      migrated += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.runtimeKeyPrefix, {
        cursor: page.continueCursor,
      });
    }

    return { migrated: migrated, skipped: skipped, isDone: page.isDone };
  },
});

/**
 * Rewrite `fp_role_` role ids to `brole_` in `accountRoles`, then in
 * `roleSessions`, keeping the random body so a role keeps its identity. Code
 * that pins a role id must switch to the new one. Idempotent: a row already
 * on `brole_` is skipped. Paginated with a self-reschedule, one table after
 * the other.
 * @returns rows migrated and skipped in this batch and whether the walk finished
 */
export const roleIdPrefix = internalMutation({
  args: {
    table: v.optional(
      v.union(v.literal("accountRoles"), v.literal("roleSessions")),
    ),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: prefixBatchValidator,
  handler: async (ctx, args): Promise<PrefixBatch> => {
    const table = args.table ?? "accountRoles";
    const page = await ctx.db
      .query(table)
      .paginate({ numItems: 100, cursor: args.cursor ?? null });

    let migrated = 0;
    let skipped = 0;
    for (const row of page.page) {
      if (!row.roleId.startsWith(OLD_ROLE_ID_PREFIX)) {
        skipped += 1;
        continue;
      }

      await ctx.db.patch(row._id, {
        roleId: `${ROLE_ID_PREFIX}${row.roleId.slice(OLD_ROLE_ID_PREFIX.length)}`,
      });
      migrated += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.roleIdPrefix, {
        table: table,
        cursor: page.continueCursor,
      });
    } else if (table === "accountRoles") {
      await ctx.scheduler.runAfter(0, internal.migrations.roleIdPrefix, {
        table: "roleSessions",
        cursor: null,
      });
    }

    return {
      migrated: migrated,
      skipped: skipped,
      isDone: page.isDone && table === "roleSessions",
    };
  },
});

/**
 * Drop the retired Session (`database`) canvas nodes and the edges touching
 * them from every stored layout. `canvas:getByProject` rejects a layout that
 * still holds one, so run this right after the deploy that removes the type.
 * Agent configs are untouched: `session` settings always lived there.
 * Idempotent and paginated with a self-reschedule, like the other backfills.
 * @returns layouts patched in this batch and whether the walk finished
 */
export const stripSessionNodes = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ patched: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args): Promise<{ patched: number; isDone: boolean }> => {
    const page = await ctx.db
      .query("canvasLayouts")
      .paginate({ numItems: 100, cursor: args.cursor ?? null });

    let patched = 0;
    for (const layout of page.page) {
      const nodes: Array<{ id: string; type: string }> = layout.nodes;
      const edges: Array<{ source: string; target: string }> = layout.edges;
      const removed = new Set(
        nodes.filter((node) => node.type === "database").map((node) => node.id),
      );
      if (removed.size === 0) continue;

      await ctx.db.patch(layout._id, {
        nodes: nodes.filter((node) => !removed.has(node.id)),
        edges: edges.filter(
          (edge) => !removed.has(edge.source) && !removed.has(edge.target),
        ),
      });
      patched += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.stripSessionNodes, {
        cursor: page.continueCursor,
      });
    }

    return { patched: patched, isDone: page.isDone };
  },
});
