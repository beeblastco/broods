/**
 * One-off data migrations. Run each on every deployment (dev + production),
 * e.g. `bunx convex run migrations:stripSessionNodes`. Each is idempotent
 * and safe to re-run; completed migrations are deleted once every deployment
 * has run them.
 */

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
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
