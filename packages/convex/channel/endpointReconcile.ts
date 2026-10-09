/**
 * The hourly self-healing pass over the `channelEndpoints` projection that
 * `listConnections` reads. Kept apart from `connections.ts`, whose types the
 * forwarders import, so their typecheck never pulls in the generated API.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { refreshAccountChannelEndpoints } from "../model/channelEndpoints";

/** Rows a reconcile page reads before handing the rest to its next run. */
const RECONCILE_PAGE_SIZE = 256;

/**
 * Rebuilds the projection for every account that has an active deployment or a
 * stored row. The write seams keep the projection live; this hourly sweep is
 * the self-healing pass that repairs any seam a future writer forgets, so a
 * missed seam costs an hour of staleness, not a silent drift forever.
 *
 * One page of active deployments, then of stored rows, per run: each account
 * found is rebuilt in its own scheduled mutation, so no single transaction
 * holds the whole deployment table or every account's decrypts. An account
 * seen on two pages is rebuilt twice, which writes nothing the second time.
 */
export const reconcile = internalMutation({
  args: {
    source: v.optional(v.union(v.literal("deployments"), v.literal("stored"))),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const source = args.source ?? "deployments";
    const page =
      source === "deployments"
        ? await ctx.db
            .query("agentDeployments")
            .withIndex("by_status", (q) => q.eq("status", "active"))
            .paginate({
              cursor: args.cursor ?? null,
              numItems: RECONCILE_PAGE_SIZE,
            })
        : await ctx.db.query("channelEndpoints").paginate({
            cursor: args.cursor ?? null,
            numItems: RECONCILE_PAGE_SIZE,
          });
    const accountIds = new Set(page.page.map((row) => row.accountId));
    for (const accountId of accountIds) {
      await ctx.scheduler.runAfter(
        0,
        internal.channel.endpointReconcile.reconcileAccount,
        { accountId: accountId },
      );
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.channel.endpointReconcile.reconcile,
        {
          source: source,
          cursor: page.continueCursor,
        },
      );
    } else if (source === "deployments") {
      await ctx.scheduler.runAfter(
        0,
        internal.channel.endpointReconcile.reconcile,
        {
          source: "stored",
        },
      );
    }

    return accountIds.size;
  },
});

/** One account's share of the hourly reconcile. */
export const reconcileAccount = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await refreshAccountChannelEndpoints(ctx, args.accountId);

    return null;
  },
});
