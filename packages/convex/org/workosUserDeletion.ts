import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { purgeUser } from "../model/cascade";

export const listSoleOwnedAccounts = internalQuery({
  args: { authId: v.string() },
  returns: v.array(v.id("accounts")),
  handler: async (ctx, args): Promise<Id<"accounts">[]> => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", args.authId))
      .first();
    if (!user) return [];

    const orgs = await ctx.db
      .query("orgs")
      .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", args.authId))
      .collect();
    const accountIds: Id<"accounts">[] = [];
    for (const org of orgs) {
      const members = await ctx.db
        .query("orgMembers")
        .withIndex("by_orgId_and_userId", (q) => q.eq("orgId", org._id))
        .collect();
      if (members.some((member) => member.userId !== user._id)) continue;

      const account = await ctx.db
        .query("accounts")
        .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
        .unique();
      if (account) accountIds.push(account._id);
    }

    return accountIds;
  },
});

export const finalize = internalMutation({
  args: { authId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", args.authId))
      .first();
    if (!user) return null;

    await purgeUser(ctx, user);

    return null;
  },
});

export const scheduleRetry = internalMutation({
  args: { authId: v.string() },
  returns: v.union(v.null(), v.number()),
  handler: async (ctx, args): Promise<number | null> => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", args.authId))
      .first();
    if (!user) return null;

    const attempts = (user.workosDeletionAttempts ?? 0) + 1;
    await ctx.db.patch(user._id, { workosDeletionAttempts: attempts });

    return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** (attempts - 1));
  },
});
