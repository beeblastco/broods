/**
 * Sandbox snapshot/image registry scoped to an account. Mirrors broods's image
 * build state so the dashboard can list snapshots with their unified build status.
 * `listForActiveOrg` is the dashboard read; `upsert` is the create-or-refresh
 * writer broods calls when a snapshot is captured (or its build status changes).
 */

import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { getActiveAccountForUser } from "./org";
import { sandboxSnapshotsFields } from "./schema";

const sandboxSnapshotDoc = v.object({
    ...sandboxSnapshotsFields,
    _id: v.id("sandboxSnapshots"),
    _creationTime: v.number(),
});

/**
 * Public query: lists sandbox snapshots/images for the caller's active org.
 * Used by the dashboard Sandbox tab's Snapshots view.
 * @returns the account's snapshot rows, or `[]` when no org/account resolves.
 */
export const listForActiveOrg = query({
    args: {},
    returns: v.array(sandboxSnapshotDoc),
    handler: async (ctx) => {
        const account = await getActiveAccountForUser(ctx);
        if (!account) return [];

        return await ctx.db
            .query("sandboxSnapshots")
            .withIndex("by_accountId", (q) => q.eq("accountId", account._id))
            .collect();
    },
});

/**
 * Create-or-refresh a snapshot/image row, keyed by (account, name). Called by
 * broods when a snapshot is captured from a running sandbox or when the image
 * pipeline reports a build-status transition.
 * @param accountId the owning account.
 * @param name the snapshot name (unique per account).
 * @param provider the sandbox compute backend the image targets.
 * @param baseImage the base image/template the snapshot derived from.
 * @param externalImageId the provider-side image id/ARN.
 * @param status the unified build status; defaults to `active`.
 */
export const upsert = internalMutation({
    args: {
        accountId: v.id("accounts"),
        name: v.string(),
        provider: sandboxSnapshotsFields.provider,
        baseImage: v.string(),
        externalImageId: v.string(),
        status: v.optional(sandboxSnapshotsFields.status),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const existing = await ctx.db
            .query("sandboxSnapshots")
            .withIndex("by_accountId_and_name", (q) => q.eq("accountId", args.accountId).eq("name", args.name))
            .unique();

        const now = Date.now();
        const status = args.status ?? "active";
        if (existing) {
            await ctx.db.patch(existing._id, {
                provider: args.provider,
                baseImage: args.baseImage,
                externalImageId: args.externalImageId,
                status,
                lastUsedAt: now,
            });

            return null;
        }

        await ctx.db.insert("sandboxSnapshots", {
            accountId: args.accountId,
            name: args.name,
            provider: args.provider,
            baseImage: args.baseImage,
            externalImageId: args.externalImageId,
            status,
            pulledCount: 0,
            createdAt: now,
            lastUsedAt: now,
        });

        return null;
    },
});
