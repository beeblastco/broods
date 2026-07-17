/**
 * Failed-auth rate limiter state for the public config HTTP surface.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Record one failed auth attempt and report whether the key is blocked.
 * @returns blocked status and optional retry delay in milliseconds.
 */
export const recordFailure = internalMutation({
  args: {
    key: v.string(),
    now: v.number(),
    windowMs: v.number(),
    maxFailures: v.number(),
    blockMs: v.number(),
  },
  returns: v.object({
    blocked: v.boolean(),
    retryAfterMs: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("configHttpAuthFailures")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();

    if (existing?.blockedUntil && existing.blockedUntil > args.now) {
      return {
        blocked: true,
        retryAfterMs: existing.blockedUntil - args.now,
      };
    }

    if (
      !existing ||
      existing.blockedUntil ||
      args.now - existing.windowStart >= args.windowMs
    ) {
      if (existing) {
        await ctx.db.patch(existing._id, {
          windowStart: args.now,
          count: 1,
          blockedUntil: undefined,
          updatedAt: args.now,
        });
      } else {
        await ctx.db.insert("configHttpAuthFailures", {
          key: args.key,
          windowStart: args.now,
          count: 1,
          updatedAt: args.now,
        });
      }

      return { blocked: false };
    }

    const nextCount = existing.count + 1;
    const blockedUntil =
      nextCount >= args.maxFailures ? args.now + args.blockMs : undefined;
    await ctx.db.patch(existing._id, {
      count: nextCount,
      blockedUntil: blockedUntil,
      updatedAt: args.now,
    });

    return blockedUntil
      ? { blocked: true, retryAfterMs: args.blockMs }
      : { blocked: false };
  },
});
