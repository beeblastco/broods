/**
 * Dashboard wrappers for connections: the active org's account lists them and
 * an admin disconnects one. Signing in runs in `broods connect`, since the
 * providers only redirect to the machine with the browser.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { mutation, query } from "../_generated/server";
import { authKit } from "../auth";
import { getActiveAccountForUser } from "../org/orgs";
import { connectionsFields } from "../schema";
import { statusValidator, type ConnectionStatus } from "./connections";

// A connection lets every agent of the org act as the signed-in account.
const CONNECTION_ADMIN_REQUIRED =
  "Connections can only be disconnected by an org admin.";

/** The active org's connections, for the dashboard's Connections page. */
export const list = query({
  args: {},
  returns: v.array(statusValidator),
  handler: async (ctx): Promise<ConnectionStatus[]> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }
    const account = await getActiveAccountForUser(ctx);
    if (!account) return [];

    return await ctx.runQuery(internal.account.connections.list, {
      accountId: account._id,
    });
  },
});

/** Forget and revoke a connection; org admins only. */
export const disconnect = mutation({
  args: { type: connectionsFields.type },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }
    const account = await getActiveAccountForUser(ctx, "admin");
    if (!account) throw new Error(CONNECTION_ADMIN_REQUIRED);

    return await ctx.runMutation(internal.account.connections.disconnect, {
      accountId: account._id,
      type: args.type,
    });
  },
});
