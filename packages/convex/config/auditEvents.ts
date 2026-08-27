/**
 * Account-visible configuration audit event queries and maintenance, plus the
 * failed-auth rate limiter state for the public config HTTP surface.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import {
  insertConfigAuditEvent,
  type ConfigAuditActor,
  type ConfigAuditResource,
} from "../model/auditEvents";
import {
  configAuditActorKindValidator,
  configAuditResourceKindValidator,
} from "../schema";

const auditActorValidator = v.object({
  kind: configAuditActorKindValidator,
  id: v.optional(v.string()),
  email: v.optional(v.string()),
  name: v.optional(v.string()),
});

const auditResourceValidator = v.object({
  kind: configAuditResourceKindValidator,
  id: v.optional(v.string()),
  name: v.optional(v.string()),
});

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const AUTH_FAILURE_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PRUNE_BATCH_SIZE = 200;

/**
 * Delete old config audit events and stale failed-auth counters in bounded batches.
 * @returns counts deleted during this invocation.
 */
export const pruneExpired = internalMutation({
  args: {
    now: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    auditDeleted: v.number(),
    authFailuresDeleted: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const batchSize = Math.min(
      Math.max(1, Math.floor(args.batchSize ?? DEFAULT_PRUNE_BATCH_SIZE)),
      500,
    );
    const auditCutoff = now - RETENTION_MS;
    const authFailureCutoff = now - AUTH_FAILURE_RETENTION_MS;

    // Range on the creation index so a sweep with nothing due reads nothing,
    // instead of re-reading the oldest batchSize rows on every tick.
    const expiredAuditRows: Doc<"configAuditEvents">[] = await ctx.db
      .query("configAuditEvents")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", auditCutoff))
      .take(batchSize);
    for (const row of expiredAuditRows) {
      await ctx.db.delete(row._id);
    }

    const authFailureRows: Doc<"configHttpAuthFailures">[] = await ctx.db
      .query("configHttpAuthFailures")
      .withIndex("by_updatedAt", (q) => q.lt("updatedAt", authFailureCutoff))
      .take(batchSize);
    for (const row of authFailureRows) {
      await ctx.db.delete(row._id);
    }

    if (
      expiredAuditRows.length === batchSize ||
      authFailureRows.length === batchSize
    ) {
      await ctx.scheduler.runAfter(
        0,
        internal.config.auditEvents.pruneExpired,
        {
          now: now,
          batchSize: batchSize,
        },
      );
    }

    return {
      auditDeleted: expiredAuditRows.length,
      authFailuresDeleted: authFailureRows.length,
    };
  },
});

/**
 * Record one config audit event from HTTP actions.
 * @returns inserted event id.
 */
export const record = internalMutation({
  args: {
    accountId: v.id("accounts"),
    projectId: v.optional(v.id("projects")),
    stageId: v.optional(v.id("stages")),
    actor: auditActorValidator,
    action: v.string(),
    resource: auditResourceValidator,
    summary: v.string(),
    detailsJson: v.optional(v.string()),
  },
  returns: v.id("configAuditEvents"),
  handler: async (ctx, args) => {
    return await insertConfigAuditEvent(ctx.db, {
      accountId: args.accountId,
      projectId: args.projectId,
      stageId: args.stageId,
      actor: args.actor as ConfigAuditActor,
      action: args.action,
      resource: args.resource as ConfigAuditResource,
      summary: args.summary,
      detailsJson: args.detailsJson,
    });
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
