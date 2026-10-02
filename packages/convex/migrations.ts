/**
 * One-off data migrations. Run each on every deployment (dev + production),
 * e.g. `bunx convex run migrations:stripSessionNodes`. Each is idempotent
 * and safe to re-run; completed migrations are deleted once every deployment
 * has run them.
 */

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import {
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
  type EncryptedAgentConfig,
} from "./model/agentConfigCodec";
import { isPlainObject } from "./model/objects";
import { v } from "convex/values";

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
 * Move every stored agent config off the removed `session.compaction` (#901).
 * Walks `agents` (resolved and source blobs, re-encrypted) and then the
 * `agentConfigs` mirror. An explicit `enabled: false` becomes
 * `autoCompaction: { enabled: false }`; anything else takes the new default.
 * Run once on each deployment after the deploy that ships #901:
 * `bunx convex run migrations:renameSessionCompaction '{"table":"agents"}'`.
 * @returns rows patched in this batch and whether this table's walk finished
 */
export const renameSessionCompaction = internalMutation({
  args: {
    table: v.union(v.literal("agents"), v.literal("agentConfigs")),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({ patched: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args): Promise<{ patched: number; isDone: boolean }> => {
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    if (!secret) throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET is not set");
    const paginate = { numItems: 100, cursor: args.cursor ?? null };
    let patched = 0;
    let page: { isDone: boolean; continueCursor: string };

    if (args.table === "agents") {
      const agents = await ctx.db.query("agents").paginate(paginate);
      page = agents;
      for (const agent of agents.page) {
        const resolved = await renameInBlob(
          agent.encryptedConfig,
          agent.encryptionIv,
          agent.encryptionTag,
          secret,
        );
        const source = await renameInBlob(
          agent.encryptedSourceConfig,
          agent.sourceEncryptionIv,
          agent.sourceEncryptionTag,
          secret,
        );
        if (!resolved && !source) continue;
        await ctx.db.patch(agent._id, {
          ...(resolved && {
            encryptedConfig: resolved.ciphertext,
            encryptionIv: resolved.iv,
            encryptionTag: resolved.tag,
          }),
          ...(source && {
            encryptedSourceConfig: source.ciphertext,
            sourceEncryptionIv: source.iv,
            sourceEncryptionTag: source.tag,
          }),
        });
        patched += 1;
      }
    } else {
      const rows = await ctx.db.query("agentConfigs").paginate(paginate);
      page = rows;
      for (const row of rows.page) {
        const extraConfig: unknown = row.extraConfig;
        if (!isPlainObject(extraConfig)) continue;
        const session = renamedSession(extraConfig.session);
        if (!session) continue;
        await ctx.db.patch(row._id, {
          extraConfig: { ...extraConfig, session: session },
        });
        patched += 1;
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.renameSessionCompaction,
        { table: args.table, cursor: page.continueCursor },
      );
    } else if (args.table === "agents") {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.renameSessionCompaction,
        { table: "agentConfigs", cursor: null },
      );
    }

    return { patched: patched, isDone: page.isDone };
  },
});

// The re-encrypted blob, or null when it is absent or has no legacy key.
async function renameInBlob(
  ciphertext: string | undefined,
  iv: string | undefined,
  tag: string | undefined,
  secret: string,
): Promise<EncryptedAgentConfig | null> {
  if (!ciphertext || !iv || !tag) return null;
  const config = await decryptAgentConfigBlob(
    { ciphertext: ciphertext, iv: iv, tag: tag },
    secret,
  );
  const session = renamedSession(config?.session);
  if (!config || !session) return null;

  return await encryptAgentConfigBlob({ ...config, session: session }, secret);
}

// The session without `compaction`, or null when it never had one.
function renamedSession(session: unknown): Record<string, unknown> | null {
  if (!isPlainObject(session) || session.compaction === undefined) return null;
  const { compaction, ...rest } = session;
  const off = isPlainObject(compaction) && compaction.enabled === false;

  return off && rest.autoCompaction === undefined
    ? { ...rest, autoCompaction: { enabled: false } }
    : rest;
}
