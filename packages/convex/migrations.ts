/**
 * One-off data migrations. Run each on every deployment (dev + production),
 * e.g. `bunx convex run migrations:stripSessionNodes`. Each is idempotent
 * and safe to re-run; completed migrations are deleted once every deployment
 * has run them.
 */

import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { decryptApiKey, runtimeKeyFields } from "./agent/deployments";
import { reencryptBatch, reencryptWalkArgs } from "./model/accountKeys";
import { randomToken, RUNTIME_KEY_PREFIX } from "./model/accountSecrets";
import { ROLE_ID_PREFIX } from "./model/roleRules";

const OLD_ROLE_ID_PREFIX = "fp_role_";

// `pruneStaleRows` walks these in order, one table after the other.
const PRUNE_TABLES = [
  "runtimeConversationCoordinators",
  "agentRuntimeSecrets",
  "cliAuthCodes",
  "canvasLayouts",
] as const;

/** What one batch of a prefix migration did, and whether its walk finished. */
const prefixBatchValidator = v.object({
  migrated: v.number(),
  skipped: v.number(),
  isDone: v.boolean(),
});

type PrefixBatch = { migrated: number; skipped: number; isDone: boolean };

type PruneTable = (typeof PRUNE_TABLES)[number];

type PruneBatchPage = { isDone: boolean; continueCursor: string };

type PruneTotals = {
  cleared: number;
  deleted: number;
  patched: number;
  isDone: boolean;
};

/**
 * Move every legacy blob (AES-GCM under the global secret, no `v2:` prefix)
 * under its account's data encryption key, minting the key where the account
 * has none. Walks every encrypted table in `ENVELOPE_TABLES` order with a
 * self-reschedule; call it with no arguments. Idempotent: a blob already under
 * the current key is skipped. Once dev and production have run it, the legacy
 * decrypt branch in `model/envelope.ts` can go.
 * @returns rows rewritten in this batch, rows skipped so far because their project has no account yet (they stay legacy), and whether the whole walk finished
 */
export const migrateToEnvelope = internalMutation({
  args: { ...reencryptWalkArgs, skipped: v.optional(v.number()) },
  returns: v.object({
    patched: v.number(),
    skipped: v.number(),
    isDone: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ patched: number; skipped: number; isDone: boolean }> => {
    const batch = await reencryptBatch(ctx, args);
    const skipped = (args.skipped ?? 0) + batch.skipped;
    if (batch.next) {
      await ctx.scheduler.runAfter(0, internal.migrations.migrateToEnvelope, {
        ...batch.next,
        skipped: skipped,
      });
    }

    return {
      patched: batch.patched,
      skipped: skipped,
      isDone: batch.next === null,
    };
  },
});

/**
 * Prune rows nothing can use any more, walking `PRUNE_TABLES` in order with a
 * self-reschedule; call it with no arguments. Clears a conversation target that
 * still holds a pre-#920 plaintext `agentConfig` (it already reads as no
 * session, and the next channel turn pins a fresh one), deletes runtime
 * secrets whose agent config is gone, deletes used or expired CLI login codes,
 * and strips the retired `animated` flag from stored canvas edges. Idempotent.
 * Never logs or returns a field value.
 * @returns targets cleared, rows deleted and layouts patched so far, and whether the whole walk finished
 */
export const pruneStaleRows = internalMutation({
  args: {
    table: v.optional(v.union(...PRUNE_TABLES.map((name) => v.literal(name)))),
    cursor: v.optional(v.union(v.string(), v.null())),
    cleared: v.optional(v.number()),
    deleted: v.optional(v.number()),
    patched: v.optional(v.number()),
  },
  returns: v.object({
    cleared: v.number(),
    deleted: v.number(),
    patched: v.number(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args): Promise<PruneTotals> => {
    const table: PruneTable = args.table ?? PRUNE_TABLES[0];
    const batch = await pruneBatch(ctx, table, args.cursor ?? null);
    const totals = {
      cleared: (args.cleared ?? 0) + batch.cleared,
      deleted: (args.deleted ?? 0) + batch.deleted,
      patched: (args.patched ?? 0) + batch.patched,
    };
    const nextTable: PruneTable | undefined =
      PRUNE_TABLES[PRUNE_TABLES.indexOf(table) + 1];
    const next = !batch.isDone
      ? { table: table, cursor: batch.continueCursor }
      : nextTable
        ? { table: nextTable, cursor: null }
        : null;
    if (next) {
      await ctx.scheduler.runAfter(0, internal.migrations.pruneStaleRows, {
        ...next,
        ...totals,
      });
    }

    return { ...totals, isDone: next === null };
  },
});

/**
 * Replace every `sk_`/`fp_agent_` runtime key with a fresh `bsk_` key, the
 * same way a rotation mints one. The body is new on purpose: an old key that
 * sits in a log must not rebuild the live one. Holders get the new key from
 * `broods dev`, `broods stage use` or the dashboard. Idempotent: a row already
 * on `bsk_` is skipped. Paginated with a self-reschedule, like the other
 * backfills.
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
      const rawApiKey = await decryptApiKey(ctx, deployment);
      if (rawApiKey.startsWith(RUNTIME_KEY_PREFIX)) {
        skipped += 1;
        continue;
      }

      await ctx.db.patch(deployment._id, {
        ...(await runtimeKeyFields(
          ctx,
          deployment.accountId,
          randomToken(RUNTIME_KEY_PREFIX),
        )),
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
 * Rewrite `fp_role_` role ids to `brole_`, keeping the random body so a role
 * keeps its identity. Sessions are left alone: every session from before the
 * cutover holds an `fp_sts_` token that core already refuses, and they expire
 * within 12 hours. A caller assumes the role again for a `bsts_` session.
 * Code that pins a role id must switch to the new one. Idempotent: a role
 * already on `brole_` is skipped. Paginated with a self-reschedule, like the
 * other backfills.
 * @returns roles migrated and skipped in this batch and whether the walk finished
 */
export const roleIdPrefix = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: prefixBatchValidator,
  handler: async (ctx, args): Promise<PrefixBatch> => {
    const page = await ctx.db
      .query("accountRoles")
      .paginate({ numItems: 100, cursor: args.cursor ?? null });

    let migrated = 0;
    let skipped = 0;
    for (const role of page.page) {
      if (!role.roleId.startsWith(OLD_ROLE_ID_PREFIX)) {
        skipped += 1;
        continue;
      }

      await ctx.db.patch(role._id, {
        roleId: `${ROLE_ID_PREFIX}${role.roleId.slice(OLD_ROLE_ID_PREFIX.length)}`,
      });
      migrated += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.roleIdPrefix, {
        cursor: page.continueCursor,
      });
    }

    return { migrated: migrated, skipped: skipped, isDone: page.isDone };
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

/**
 * Store workspace isolation as its level. Rows written before the levels
 * existed hold `isolation: true`, which means "conversation". Run right after
 * the deploy that adds the levels; `workspaceIsolation()` reads `true` as
 * "conversation" until then. Idempotent and paginated with a self-reschedule,
 * like the other backfills.
 * @returns rows patched in this batch and whether the walk finished
 */
export const workspaceIsolationLevels = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ patched: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args): Promise<{ patched: number; isDone: boolean }> => {
    const page = await ctx.db
      .query("workspaceConfigs")
      .paginate({ numItems: 100, cursor: args.cursor ?? null });

    let patched = 0;
    for (const row of page.page) {
      const config: { isolation?: unknown } = row.config;
      if (config.isolation !== true) continue;

      await ctx.db.patch(row._id, {
        config: { ...config, isolation: "conversation" },
      });
      patched += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.workspaceIsolationLevels,
        { cursor: page.continueCursor },
      );
    }

    return { patched: patched, isDone: page.isDone };
  },
});

/** One page of `pruneStaleRows` on one table: what it pruned, and where the table's walk stands. */
async function pruneBatch(
  ctx: MutationCtx,
  table: PruneTable,
  cursor: string | null,
): Promise<Omit<PruneTotals, "isDone"> & PruneBatchPage> {
  const page = { numItems: 100, cursor: cursor };
  const counts = { cleared: 0, deleted: 0, patched: 0 };
  let result: PruneBatchPage;
  if (table === "runtimeConversationCoordinators") {
    const rows = await ctx.db.query(table).paginate(page);
    for (const row of rows.page) {
      if (row.channelTarget?.agentConfig === undefined) continue;
      await ctx.db.patch(row._id, { channelTarget: undefined });
      counts.cleared += 1;
    }
    result = rows;
  } else if (table === "agentRuntimeSecrets") {
    const rows = await ctx.db.query(table).paginate(page);
    for (const row of rows.page) {
      if (await ctx.db.get(row.agentConfigId)) continue;
      await ctx.db.delete(row._id);
      counts.deleted += 1;
    }
    result = rows;
  } else if (table === "cliAuthCodes") {
    const now = Date.now();
    const rows = await ctx.db.query(table).paginate(page);
    for (const row of rows.page) {
      if (row.usedAt === undefined && row.expiresAt >= now) continue;
      await ctx.db.delete(row._id);
      counts.deleted += 1;
    }
    result = rows;
  } else {
    const rows = await ctx.db.query(table).paginate(page);
    for (const row of rows.page) {
      const edges: Array<{ animated?: unknown }> = row.edges;
      if (!edges.some((edge) => "animated" in edge)) continue;
      await ctx.db.patch(row._id, {
        edges: edges.map(({ animated: _animated, ...edge }) => edge),
      });
      counts.patched += 1;
    }
    result = rows;
  }

  return {
    ...counts,
    isDone: result.isDone,
    continueCursor: result.continueCursor,
  };
}
