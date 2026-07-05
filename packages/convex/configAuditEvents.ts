/**
 * Account-visible configuration audit event queries and maintenance.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, query } from "./_generated/server";
import { authKit } from "./auth";
import {
    accountIdForProject,
    insertConfigAuditEvent,
    type ConfigAuditActor,
    type ConfigAuditResource,
} from "./model/auditEvents";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { getOwnedProject } from "./model/ownership/project";
import {
    configAuditActorKindValidator,
    configAuditEventsFields,
    configAuditResourceKindValidator,
} from "./schema";

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

const auditEventDoc = v.object({
    ...configAuditEventsFields,
    _id: v.id("configAuditEvents"),
    _creationTime: v.number(),
});

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const AUTH_FAILURE_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PRUNE_BATCH_SIZE = 200;

/**
 * List recent configuration audit events for a project/environment visible to the caller.
 * @returns newest matching audit events, capped at 500 rows.
 */
export const listRecent = query({
    args: {
        projectId: v.id("projects"),
        environmentId: v.optional(v.id("environments")),
        limit: v.optional(v.number()),
    },
    returns: v.array(auditEventDoc),
    handler: async (ctx, args) => {
        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const project = await getOwnedProject(ctx, user.id, args.projectId);
        if (!project) return [];
        if (args.environmentId !== undefined) {
            const environment = await getOwnedEnvironment(ctx, user.id, args.environmentId);
            if (!environment || environment.projectId !== args.projectId) return [];
        }

        const accountId = await accountIdForProject(ctx, args.projectId);
        if (!accountId) return [];
        const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 100)), 500);

        if (args.environmentId !== undefined) {
            return await ctx.db
                .query("configAuditEvents")
                .withIndex("by_account_project_environment", (q) =>
                    q
                        .eq("accountId", accountId)
                        .eq("projectId", args.projectId)
                        .eq("environmentId", args.environmentId!),
                )
                .order("desc")
                .take(limit);
        }

        return await ctx.db
            .query("configAuditEvents")
            .withIndex("by_account", (q) => q.eq("accountId", accountId))
            .filter((q) => q.eq(q.field("projectId"), args.projectId))
            .order("desc")
            .take(limit);
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
        environmentId: v.optional(v.id("environments")),
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
            environmentId: args.environmentId,
            actor: args.actor as ConfigAuditActor,
            action: args.action,
            resource: args.resource as ConfigAuditResource,
            summary: args.summary,
            detailsJson: args.detailsJson,
        });
    },
});

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
        const batchSize = Math.min(Math.max(1, Math.floor(args.batchSize ?? DEFAULT_PRUNE_BATCH_SIZE)), 500);
        const auditCutoff = now - RETENTION_MS;
        const authFailureCutoff = now - AUTH_FAILURE_RETENTION_MS;

        const auditRows: Doc<"configAuditEvents">[] = await ctx.db
            .query("configAuditEvents")
            .take(batchSize);
        const expiredAuditRows = auditRows.filter((row) => row._creationTime < auditCutoff);
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

        if (expiredAuditRows.length === batchSize || authFailureRows.length === batchSize) {
            await ctx.scheduler.runAfter(0, internal.configAuditEvents.pruneExpired, {
                now: now,
                batchSize: batchSize,
            });
        }

        return {
            auditDeleted: expiredAuditRows.length,
            authFailuresDeleted: authFailureRows.length,
        };
    },
});
