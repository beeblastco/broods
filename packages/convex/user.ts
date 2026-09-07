/**
 * Public user queries, mutations and the signup sync action for authentication-gated user management.
 */

import { createFunctionHandle } from "convex/server";
import { v } from "convex/values";
import { api, components, internal } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { usersFields } from "./schema";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const userDoc = v.object({
  ...usersFields,
  _id: v.id("users"),
  _creationTime: v.number(),
});

/**
 * Creates the caller's user rows when a valid session has none. Signup relies
 * on the WorkOS `user.created` webhook to populate both the AuthKit component's
 * `users` table and ours; while that delivery is late or misrouted, a freshly
 * signed-up user holds a valid JWT but every dashboard read returns null.
 * Fetches the user from WorkOS server-side and replays it through the same
 * `user.created` path the webhook uses, so both rows land in one transaction.
 * Idempotent: the component dedups the synthetic event id, so concurrent calls
 * and a later real webhook delivery are no-ops.
 */
export const ensureSynced = action({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }
    const existing = await ctx.runQuery(api.user.getCurrent, {});
    if (existing) {
      return null;
    }
    const apiKey = process.env.WORKOS_API_KEY;
    if (!apiKey) {
      throw new Error("WORKOS_API_KEY is not set");
    }

    const workosUser = await authKit.workos.userManagement.getUser(
      identity.subject,
    );
    await ctx.runMutation(components.workOSAuthKit.lib.onWebhookEvent, {
      apiKey: apiKey,
      event: {
        id: `sync:${workosUser.id}`,
        createdAt: new Date().toISOString(),
        event: "user.created",
        data: { ...workosUser },
      },
      onEventHandle: await createFunctionHandle(internal.auth.authKitEvent),
    });

    return null;
  },
});

export const getCurrent = query({
  args: {},
  returns: v.union(v.null(), userDoc),
  handler: async (ctx) => {
    const user = await authKit.getAuthUser(ctx);
    if (!user) return null;

    return await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", user.id))
      .first();
  },
});

export const updateProfile = mutation({
  args: {
    name: v.string(),
    accountHandle: v.optional(v.string()),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
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

    if (args.accountHandle) {
      const normalizedHandle = args.accountHandle.trim().toLowerCase();
      const existingHandle = await ctx.db
        .query("users")
        .withIndex("by_accountHandle", (q) =>
          q.eq("accountHandle", normalizedHandle),
        )
        .first();

      if (existingHandle && existingHandle._id !== user._id) {
        throw new Error("Account handle is already taken.");
      }

      await ctx.db.patch(user._id, {
        name: args.name,
        accountHandle: normalizedHandle,
      });
    } else {
      await ctx.db.patch(user._id, {
        name: args.name,
        accountHandle: undefined,
      });
    }

    return user._id;
  },
});

/**
 * Backfills the caller's name and avatarUrl from values supplied by the
 * WorkOS client session when the Convex doc is missing them. Used to recover
 * from cases where the webhook payload did not include the profile picture.
 */
export const syncProfile = mutation({
  args: {
    name: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { name, avatarUrl } = args;

    // Check authenticated user
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) {
      return null;
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
      .first();
    if (!user) {
      return null;
    }

    const patch: { name?: string; avatarUrl?: string } = {};
    if (avatarUrl && avatarUrl !== user.avatarUrl) {
      patch.avatarUrl = avatarUrl;
    }
    if (name && name.trim() && name.trim() !== user.name) {
      patch.name = name.trim();
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(user._id, patch);
    }

    return null;
  },
});

export const requestAccountDeletion = mutation({
  args: {},
  returns: v.object({ scheduledFor: v.number() }),
  handler: async (ctx) => {
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

    const scheduledFor = Date.now() + SEVEN_DAYS_MS;
    await ctx.db.patch(user._id, { deletionScheduledFor: scheduledFor });

    return { scheduledFor: scheduledFor };
  },
});
