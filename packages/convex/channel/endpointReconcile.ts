// Apart from connections.ts, whose types the forwarders import, so their typecheck never
// pulls in the generated API.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { refreshAccountChannelEndpoints } from "../model/channelEndpoints";

const RECONCILE_PAGE_SIZE = 256;

// Hourly repair for any write seam that forgets the projection. One mutation per account, so no
// transaction holds the deployment table or every account's decrypts; repeats write nothing.
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

export const reconcileAccount = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await refreshAccountChannelEndpoints(ctx, args.accountId);

    return null;
  },
});
