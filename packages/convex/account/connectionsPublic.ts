import { v } from "convex/values";
import { internal } from "../_generated/api";
import { mutation, query } from "../_generated/server";
import { authKit } from "../auth";
import { requireActiveAccount } from "../model/activeAccount";
import { getActiveAccountForUser } from "../org/orgs";
import { connectionsFields } from "../schema";
import { statusValidator, type ConnectionStatus } from "./connections";

// A connection lets every agent of the org act as the signed-in account.
const CONNECTION_ADMIN_REQUIRED =
  "Connections can only be disconnected by an org admin.";

export const list = query({
  args: {},
  returns: v.array(statusValidator),
  handler: async (ctx): Promise<ConnectionStatus[]> => {
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

export const disconnect = mutation({
  args: { type: connectionsFields.type },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }
    const account = await getActiveAccountForUser(ctx, "admin");
    if (!account) throw new Error(CONNECTION_ADMIN_REQUIRED);
    await requireActiveAccount(ctx, account._id);

    return await ctx.runMutation(internal.account.connections.disconnect, {
      accountId: account._id,
      type: args.type,
    });
  },
});
