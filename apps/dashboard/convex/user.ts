/**
 * User management queries and mutations.
 */
import { withSystemFields } from "convex-helpers/validators";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { deleteAgentConfigRelated, deleteSessionCascade } from "./model/cleanup";
import { userFields } from "./schema";

/** Validator for user records with system fields. */
const userValidator = v.object(withSystemFields("users", userFields));
const accountHandleValidator = v.optional(v.string());
const ACCOUNT_DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Normalize and validate an optional account handle. */
function normalizeHandle(input: string | undefined): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0) {
    return undefined;
  }

  if (!/^[a-z0-9_-]{3,32}$/.test(normalized)) {
    throw new Error(
      "Account handle must be 3-32 characters and use only lowercase letters, numbers, '_' or '-'.",
    );
  }

  return normalized;
}

/**
 * Get the current authenticated user record.
 * @returns User document or null if not authenticated or not found
 */
export const getCurrent = query({
  args: {},
  returns: v.union(userValidator, v.null()),
  handler: async (ctx) => {
    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      return null;
    }

    const userRecord = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", user.subject))
      .unique();

    return userRecord;
  },
});

/**
 * Ensure a user record exists for the authenticated user, creating one if needed.
 * @param name Display name from identity provider
 * @param email Email from identity provider
 * @param avatarUrl Optional avatar URL from identity provider
 * @returns The user document ID
 * @throws Error if user is not authenticated
 */
export const ensureUser = mutation({
  args: {
    name: userFields.name,
    email: userFields.email,
    accountHandle: accountHandleValidator,
    avatarUrl: userFields.avatarUrl,
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    const { name, email, avatarUrl } = args;
    const accountHandle = normalizeHandle(args.accountHandle);

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const existing = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", user.subject))
      .unique();

    if (existing) {
      // Only write if fields actually changed to avoid unnecessary reactive updates
      if (
        existing.name !== name ||
        existing.email !== email ||
        existing.accountHandle !== accountHandle ||
        existing.avatarUrl !== avatarUrl
      ) {
        await ctx.db.patch(existing._id, {
          name: name,
          email: email,
          accountHandle: accountHandle,
          avatarUrl: avatarUrl,
          updatedAt: Date.now(),
        });
      }

      return existing._id;
    }

    // Create new user record
    const userId = await ctx.db.insert("users", {
      authId: user.subject,
      email: email,
      name: name,
      accountHandle: accountHandle,
      avatarUrl: avatarUrl,
      plan: "hobby",
      isFirstTime: true,
      updatedAt: Date.now(),
    });

    return userId;
  },
});

/**
 * Update profile attributes shown in account settings.
 * Creates a user record if one does not exist yet.
 */
export const updateProfile = mutation({
  args: {
    name: userFields.name,
    accountHandle: accountHandleValidator,
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const accountHandle = normalizeHandle(args.accountHandle);
    const identity = user as Record<string, unknown>;
    const identityEmail =
      typeof identity.email === "string" ? identity.email : "";
    const identityAvatar =
      typeof identity.picture === "string" ? identity.picture : undefined;

    const existing = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", user.subject))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name.trim(),
        accountHandle: accountHandle,
        updatedAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("users", {
      authId: user.subject,
      email: identityEmail,
      name: args.name.trim(),
      accountHandle: accountHandle,
      avatarUrl: identityAvatar,
      plan: "hobby",
      isFirstTime: false,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Schedule account deletion with a 7-day grace period.
 * The account and related data are removed asynchronously after the delay.
 */
export const requestAccountDeletion = mutation({
  args: {},
  returns: v.object({
    scheduledFor: v.number(),
  }),
  handler: async (ctx) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const now = Date.now();
    const scheduledFor = now + ACCOUNT_DELETION_GRACE_MS;
    const identity = user as Record<string, unknown>;

    const existing = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", user.subject))
      .unique();

    if (
      existing?.deletionScheduledFor !== undefined &&
      existing.deletionScheduledFor > now
    ) {
      return { scheduledFor: existing.deletionScheduledFor };
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        deletionRequestedAt: now,
        deletionScheduledFor: scheduledFor,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("users", {
        authId: user.subject,
        email: typeof identity.email === "string" ? identity.email : "",
        name:
          typeof identity.name === "string" && identity.name.trim().length > 0
            ? identity.name
            : "User",
        accountHandle: undefined,
        avatarUrl:
          typeof identity.picture === "string" ? identity.picture : undefined,
        plan: "hobby",
        deletionRequestedAt: now,
        deletionScheduledFor: scheduledFor,
        isFirstTime: false,
        updatedAt: now,
      });
    }

    await ctx.scheduler.runAfter(
      ACCOUNT_DELETION_GRACE_MS,
      internal.user.deleteAccountAfterGrace,
      {
        authId: user.subject,
        scheduledFor: scheduledFor,
      },
    );

    return { scheduledFor };
  },
});

/**
 * Internal cleanup that runs after the deletion grace period.
 */
export const deleteAccountAfterGrace = internalMutation({
  args: {
    authId: v.string(),
    scheduledFor: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { authId, scheduledFor } = args;

    const userRecord = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", authId))
      .unique();

    // Deletion was canceled or rescheduled.
    if (userRecord && userRecord.deletionScheduledFor !== scheduledFor) {
      return null;
    }

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_authId", (q) => q.eq("authId", authId))
      .collect();
    for (const session of sessions) {
      await deleteSessionCascade(ctx, session._id);
    }

    const configs = await ctx.db
      .query("agentConfigs")
      .withIndex("by_authId", (q) => q.eq("authId", authId))
      .collect();
    for (const config of configs) {
      await deleteAgentConfigRelated(ctx, config._id);
      await ctx.db.delete(config._id);
    }

    const toolServices = await ctx.db
      .query("toolServices")
      .withIndex("by_authId", (q) => q.eq("authId", authId))
      .collect();
    for (const toolService of toolServices) {
      await ctx.db.delete(toolService._id);
    }

    const projects = await ctx.db
      .query("projects")
      .withIndex("by_authId", (q) => q.eq("authId", authId))
      .collect();
    for (const project of projects) {
      const layouts = await ctx.db
        .query("canvasLayouts")
        .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
        .collect();
      for (const layout of layouts) {
        await ctx.db.delete(layout._id);
      }

      const environments = await ctx.db
        .query("environments")
        .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
        .collect();
      for (const environment of environments) {
        await ctx.db.delete(environment._id);
      }

      await ctx.db.delete(project._id);
    }

    // Best-effort cleanup for orphaned records.
    const orphanedEnvironments = await ctx.db
      .query("environments")
      .withIndex("by_authId", (q) => q.eq("authId", authId))
      .collect();
    for (const environment of orphanedEnvironments) {
      await ctx.db.delete(environment._id);
    }

    const orphanedDeployments = await ctx.db
      .query("agentDeployments")
      .withIndex("by_authId", (q) => q.eq("authId", authId))
      .collect();
    for (const deployment of orphanedDeployments) {
      await ctx.db.delete(deployment._id);
    }

    if (userRecord) {
      await ctx.db.delete(userRecord._id);
    }

    return null;
  },
});
