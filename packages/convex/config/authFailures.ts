/**
 * Failed-auth rate limiter state for the public config HTTP surface: one
 * counter per (ip, token prefix) key, and its daily prune.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";

const AUTH_FAILURE_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PRUNE_BATCH_SIZE = 200;

/**
 * Delete stale failed-auth counters in bounded batches.
 * @returns count deleted during this invocation.
 */
export const pruneExpired = internalMutation({
  args: {
    now: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const now = args.now ?? Date.now();
    const batchSize = Math.min(
      Math.max(1, Math.floor(args.batchSize ?? DEFAULT_PRUNE_BATCH_SIZE)),
      500,
    );
    const cutoff = now - AUTH_FAILURE_RETENTION_MS;
    const rows: Doc<"configHttpAuthFailures">[] = await ctx.db
      .query("configHttpAuthFailures")
      .withIndex("by_updatedAt", (q) => q.lt("updatedAt", cutoff))
      .take(batchSize);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    if (rows.length === batchSize) {
      await ctx.scheduler.runAfter(
        0,
        internal.config.authFailures.pruneExpired,
        {
          now: now,
          batchSize: batchSize,
        },
      );
    }

    return rows.length;
  },
});

/**
 * Record one failed auth attempt and report whether the key is blocked.
 * @returns blocked status and optional retry delay in milliseconds.
 */
export const recordAuthFailure = internalMutation({
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
  handler: async (
    ctx,
    args,
  ): Promise<{ blocked: boolean; retryAfterMs?: number }> => {
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
