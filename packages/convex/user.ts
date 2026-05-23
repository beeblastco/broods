/**
 * Public user queries and mutations for authentication-gated user management.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { usersFields } from "./schema";

const userDoc = v.object({
    ...usersFields,
    _id: v.id("users"),
    _creationTime: v.number(),
});

/**
 * Returns the current user document, or null if not authenticated.
 * @returns The user document for the authenticated caller, or null
 */
export const getCurrent = query({
    args: {},
    returns: v.union(v.null(), userDoc),
    handler: async (ctx) => {
        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            return null;
        }

        const existing = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", user.id))
            .first();

        return existing;
    },
});

/**
 * Updates the authenticated user's profile attributes.
 * @param name The display name for the user
 * @param accountHandle Optional public identifier for the user
 * @returns The updated user document ID
 * @throws Error if not authenticated or user record not found
 */
export const updateProfile = mutation({
    args: {
        name: v.string(),
        accountHandle: v.optional(v.string()),
    },
    returns: v.id("users"),
    handler: async (ctx, args) => {
        const { name, accountHandle } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
            .first();

        if (!user) {
            throw new Error("User record not found. Please sign in again.");
        }

        if (accountHandle) {
            const normalizedHandle = accountHandle.trim().toLowerCase();
            const existingHandle = await ctx.db
                .query("users")
                .withIndex("by_accountHandle", (q) => q.eq("accountHandle", normalizedHandle))
                .first();

            if (existingHandle && existingHandle._id !== user._id) {
                throw new Error("Account handle is already taken.");
            }

            await ctx.db.patch(user._id, {
                name: name,
                accountHandle: normalizedHandle,
            });
        } else {
            await ctx.db.patch(user._id, {
                name: name,
                accountHandle: undefined,
            });
        }

        return user._id;
    },
});

/**
 * Schedules account deletion for the authenticated user after a 7-day recovery window.
 * @returns Object containing the scheduled deletion timestamp
 * @throws Error if not authenticated or user record not found
 */
export const requestAccountDeletion = mutation({
    args: {},
    returns: v.object({ scheduledFor: v.number() }),
    handler: async (ctx) => {
        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
            .first();

        if (!user) {
            throw new Error("User record not found. Please sign in again.");
        }

        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        const scheduledFor = Date.now() + sevenDaysMs;

        await ctx.db.patch(user._id, {
            deletionScheduledFor: scheduledFor,
        });

        return { scheduledFor: scheduledFor };
    },
});
