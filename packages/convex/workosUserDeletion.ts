/**
 * Convex-side queries and mutations for a WorkOS-triggered user teardown.
 * The Node action performs runtime cleanup before calling `finalize` here.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { purgeUser } from "./model/cascade";

/** Returns accounts belonging to orgs the user solely owns and can safely purge. */
export const listSoleOwnedAccounts = internalQuery({
    args: { authId: v.string() },
    returns: v.array(v.id("accounts")),
    handler: async (ctx, args) => {
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
                .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
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

/** Completes the database portion of a WorkOS deletion; missing users are a no-op. */
export const finalize = internalMutation({
    args: { authId: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
        const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", args.authId))
            .first();
        if (!user) return null;

        await purgeUser(ctx, user);

        return null;
    },
});

/** Increments the cleanup retry count and returns a capped exponential delay. */
export const scheduleRetry = internalMutation({
    args: { authId: v.string() },
    returns: v.union(v.null(), v.number()),
    handler: async (ctx, args) => {
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
