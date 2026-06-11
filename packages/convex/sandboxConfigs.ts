/**
 * Sandbox config CRUD scoped to an account. Mirrors agents.ts: the doc _id is
 * the public sandboxId, every mutation revalidates the doc's accountId against
 * the caller-supplied accountId, and the config blob is stored encrypted
 * (filthy-panty encrypts before writing; the dashboard never reads it).
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { sandboxConfigsFields } from "./schema";

const sandboxConfigDoc = v.object({
    ...sandboxConfigsFields,
    _id: v.id("sandboxConfigs"),
    _creationTime: v.number(),
});

/**
 * Look up a sandbox config by the public string id. The validator accepts
 * `v.string()` (not `v.id`) so unknown / non-Convex-id values resolve to `null`
 * (= "not found") instead of throwing at the adapter boundary.
 */
export const getById = internalQuery({
    args: {
        accountId: v.id("accounts"),
        sandboxId: v.string(),
    },
    returns: v.union(sandboxConfigDoc, v.null()),
    handler: async (ctx, args) => {
        const normalized = ctx.db.normalizeId("sandboxConfigs", args.sandboxId);
        if (!normalized) return null;
        const doc = await ctx.db.get(normalized);
        if (!doc || doc.accountId !== args.accountId) return null;
        return doc;
    },
});

export const list = internalQuery({
    args: { accountId: v.id("accounts") },
    returns: v.array(sandboxConfigDoc),
    handler: async (ctx, args) => {
        return await ctx.db
            .query("sandboxConfigs")
            .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
            .collect();
    },
});

export const create = internalMutation({
    args: {
        accountId: v.id("accounts"),
        name: v.string(),
        description: v.optional(v.string()),
        encryptedConfig: v.optional(v.string()),
        encryptionIv: v.optional(v.string()),
        encryptionTag: v.optional(v.string()),
    },
    returns: v.id("sandboxConfigs"),
    handler: async (ctx, args) => {
        const account = await ctx.db.get(args.accountId);
        if (!account) {
            throw new Error(`Account not found: ${args.accountId}`);
        }

        const now = Date.now();
        return await ctx.db.insert("sandboxConfigs", {
            accountId: args.accountId,
            name: args.name,
            description: args.description,
            encryptedConfig: args.encryptedConfig,
            encryptionIv: args.encryptionIv,
            encryptionTag: args.encryptionTag,
            createdAt: now,
            updatedAt: now,
        });
    },
});

export const update = internalMutation({
    args: {
        accountId: v.id("accounts"),
        sandboxId: v.string(),
        name: v.optional(v.string()),
        description: v.optional(v.string()),
        encryptedConfig: v.optional(v.string()),
        encryptionIv: v.optional(v.string()),
        encryptionTag: v.optional(v.string()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { accountId, sandboxId, ...patch } = args;
        const normalized = ctx.db.normalizeId("sandboxConfigs", sandboxId);
        if (!normalized) {
            throw new Error("Sandbox config does not belong to the supplied accountId");
        }
        const doc = await ctx.db.get(normalized);
        if (!doc || doc.accountId !== accountId) {
            throw new Error("Sandbox config does not belong to the supplied accountId");
        }

        await ctx.db.patch(normalized, {
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.description !== undefined && { description: patch.description }),
            ...(patch.encryptedConfig !== undefined && { encryptedConfig: patch.encryptedConfig }),
            ...(patch.encryptionIv !== undefined && { encryptionIv: patch.encryptionIv }),
            ...(patch.encryptionTag !== undefined && { encryptionTag: patch.encryptionTag }),
            updatedAt: Date.now(),
        });

        return null;
    },
});

export const remove = internalMutation({
    args: {
        accountId: v.id("accounts"),
        sandboxId: v.string(),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const normalized = ctx.db.normalizeId("sandboxConfigs", args.sandboxId);
        if (!normalized) {
            throw new Error("Sandbox config does not belong to the supplied accountId");
        }
        const doc = await ctx.db.get(normalized);
        if (!doc || doc.accountId !== args.accountId) {
            throw new Error("Sandbox config does not belong to the supplied accountId");
        }

        await ctx.db.delete(normalized);
        return null;
    },
});
