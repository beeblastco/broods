/**
 * User management queries and mutations.
 */
import { withSystemFields } from "convex-helpers/validators";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { userFields } from "./schema";

/** Validator for user records with system fields. */
const userValidator = v.object(withSystemFields("users", userFields));

/**
 * Get the current authenticated user record.
 * @returns User document or null if not authenticated or not found
 */
export const getCurrentUser = query({
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
    avatarUrl: userFields.avatarUrl,
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    const { name, email, avatarUrl } = args;

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
      // Update name/email/avatar if changed
      await ctx.db.patch(existing._id, {
        name: name,
        email: email,
        avatarUrl: avatarUrl,
        updatedAt: Date.now(),
      });

      return existing._id;
    }

    // Create new user record
    const userId = await ctx.db.insert("users", {
      authId: user.subject,
      email: email,
      name: name,
      avatarUrl: avatarUrl,
      isFirstTime: true,
      updatedAt: Date.now(),
    });

    return userId;
  },
});
