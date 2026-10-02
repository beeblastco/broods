/**
 * Dashboard wrappers for connections: the active org's account lists them and
 * an admin disconnects one. Signing in runs in `broods connect`, since the
 * providers only redirect to the machine with the browser.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { mutation, query } from "../_generated/server";
import { getActiveAccountForUser } from "../org/orgs";
import type { ConnectionStatus } from "./connections";

// A connection lets every agent of the org act as the signed-in account.
const CONNECTION_ADMIN_REQUIRED =
  "Connections can only be disconnected by an org admin.";

export const list = query({
  args: {},
  handler: async (ctx): Promise<ConnectionStatus[]> => {
    const account = await getActiveAccountForUser(ctx);
    if (!account) return [];

    return await ctx.runQuery(internal.account.connections.list, {
      accountId: account._id,
    });
  },
});

export const disconnect = mutation({
  args: { name: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const account = await getActiveAccountForUser(ctx, "admin");
    if (!account) throw new Error(CONNECTION_ADMIN_REQUIRED);

    return await ctx.runMutation(internal.account.connections.disconnect, {
      accountId: account._id,
      name: args.name,
    });
  },
});
