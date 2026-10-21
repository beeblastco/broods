/**
 * Public user queries, mutations and the signup sync action for authentication-gated user management.
 */

import { createFunctionHandle } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { components, internal } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { hexFromBytes } from "./model/accountSecrets";
import { SELF_HOST_ADMIN, SELF_HOST_ISSUER } from "./model/selfHostAuth";
import { ticketKey } from "./model/stageSessionTicket";
import { usersFields } from "./schema";

// Keeps the user id key apart from the session ids core tags with the same secret.
const ANALYTICS_ID_KEY_CONTEXT = "broods-analytics-user:";
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
 * Idempotent: the component dedups the synthetic event id across concurrent
 * calls, and skips `user.created` for an id it already has, so a later real
 * webhook delivery is a no-op.
 */
export const ensureSynced = action({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    // Check authenticated user
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("User not found or not authenticated");
    }
    // The webhook already landed.
    if (await authKit.getAuthUser(ctx)) {
      return null;
    }

    const workosUser =
      identity.issuer === SELF_HOST_ISSUER
        ? selfHostAdminUser()
        : await authKit.workos.userManagement.getUser(identity.subject);
    await ctx.runMutation(components.workOSAuthKit.lib.onWebhookEvent, {
      // The component only reads the key for non-create events; the
      // validator still wants a string.
      apiKey: process.env.WORKOS_API_KEY ?? "",
      event: {
        id: `sync:${workosUser.id}`,
        createdAt: new Date().toISOString(),
        event: "user.created",
        data: workosUser,
      },
      onEventHandle: await createFunctionHandle(internal.auth.authKitEvent),
    });

    return null;
  },
});

/**
 * The caller's PostHog id: an HMAC of their auth id under ANALYTICS_ID_SECRET,
 * the same on every device yet unreadable without the secret, so analytics
 * counts one person once and never learns who they are. Null when signed out
 * or the secret is unset; the dashboard then stays anonymous per browser.
 */
export const analyticsId = query({
  args: {},
  returns: v.union(v.null(), v.string()),
  handler: async (ctx): Promise<string | null> => {
    const user = await authKit.getAuthUser(ctx);
    const secret = process.env.ANALYTICS_ID_SECRET;
    if (!user || !secret) return null;
    const mac = await crypto.subtle.sign(
      "HMAC",
      await ticketKey(ANALYTICS_ID_KEY_CONTEXT, secret),
      new TextEncoder().encode(user.id),
    );

    return hexFromBytes(new Uint8Array(mac));
  },
});

export const getCurrent = query({
  args: {},
  returns: v.union(v.null(), userDoc),
  handler: async (ctx): Promise<Doc<"users"> | null> => {
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
  handler: async (ctx, args): Promise<Id<"users">> => {
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

    const accountHandle = args.accountHandle?.trim().toLowerCase() || undefined;
    if (accountHandle) {
      const existingHandle = await ctx.db
        .query("users")
        .withIndex("by_accountHandle", (q) =>
          q.eq("accountHandle", accountHandle),
        )
        .first();

      if (existingHandle && existingHandle._id !== user._id) {
        throw new Error("Account handle is already taken.");
      }
    }

    await ctx.db.patch(user._id, {
      name: args.name,
      nameEdited: user.nameEdited || args.name !== user.name,
      accountHandle: accountHandle,
    });

    return user._id;
  },
});

/**
 * Refreshes the caller's avatarUrl from the WorkOS client session, for webhook
 * payloads that lacked the picture. Names come only from the WorkOS webhooks.
 */
export const syncProfile = mutation({
  args: {
    avatarUrl: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    // Check authenticated user
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) {
      return null;
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
      .first();
    if (user && args.avatarUrl !== user.avatarUrl) {
      await ctx.db.patch(user._id, { avatarUrl: args.avatarUrl });
    }

    return null;
  },
});

export const requestAccountDeletion = mutation({
  args: {},
  returns: v.object({ scheduledFor: v.number() }),
  handler: async (ctx): Promise<{ scheduledFor: number }> => {
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

// The self-hosted admin, shaped like the WorkOS user `user.created` carries.
function selfHostAdminUser(): Awaited<
  ReturnType<typeof authKit.workos.userManagement.getUser>
> {
  const now = new Date().toISOString();

  return {
    object: "user",
    id: SELF_HOST_ADMIN.subject,
    email: SELF_HOST_ADMIN.email,
    emailVerified: true,
    profilePictureUrl: null,
    name: SELF_HOST_ADMIN.firstName,
    firstName: SELF_HOST_ADMIN.firstName,
    lastName: null,
    lastSignInAt: null,
    locale: null,
    createdAt: now,
    updatedAt: now,
    externalId: null,
    metadata: {},
  };
}
