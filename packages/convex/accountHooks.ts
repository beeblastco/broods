/**
 * Internal account hook metadata API consumed by core's Convex storage adapter.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { accountHookEventValidator, accountHooksFields } from "./schema";

const accountHookDoc = v.object({
    ...accountHooksFields,
    _id: v.id("accountHooks"),
    _creationTime: v.number(),
});

export const getById = internalQuery({
    args: {
        accountId: v.id("accounts"),
        hookId: v.string(),
    },
    returns: v.union(accountHookDoc, v.null()),
    handler: async (ctx, args) => {
        const normalized = ctx.db.normalizeId("accountHooks", args.hookId);
        if (!normalized) return null;
        const doc = await ctx.db.get(normalized);
        if (!doc || doc.accountId !== args.accountId || doc.status !== "active") return null;

        return doc;
    },
});

export const list = internalQuery({
    args: { accountId: v.id("accounts") },
    returns: v.array(accountHookDoc),
    handler: async (ctx, args) => {
        return await ctx.db
            .query("accountHooks")
            .withIndex("by_accountId_and_status", (q) =>
                q.eq("accountId", args.accountId).eq("status", "active"),
            )
            .collect();
    },
});

export const create = internalMutation({
    args: {
        accountId: v.id("accounts"),
        name: v.string(),
        description: v.optional(v.string()),
        events: v.array(accountHookEventValidator),
        bundleStorageKey: v.string(),
        sha256: v.string(),
    },
    returns: v.id("accountHooks"),
    handler: async (ctx, args) => {
        const account = await ctx.db.get(args.accountId);
        if (!account) {
            throw new Error(`Account not found: ${args.accountId}`);
        }

        const now = Date.now();

        return await ctx.db.insert("accountHooks", {
            accountId: args.accountId,
            name: args.name,
            description: args.description,
            events: args.events,
            bundleStorageKey: args.bundleStorageKey,
            sha256: args.sha256,
            status: "active",
            createdAt: now,
            updatedAt: now,
        });
    },
});

export const update = internalMutation({
    args: {
        accountId: v.id("accounts"),
        hookId: v.string(),
        name: v.optional(v.string()),
        description: v.optional(v.union(v.string(), v.null())),
        events: v.optional(v.array(accountHookEventValidator)),
        bundleStorageKey: v.optional(v.string()),
        sha256: v.optional(v.string()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const normalized = ctx.db.normalizeId("accountHooks", args.hookId);
        if (!normalized) {
            throw new Error("Hook does not belong to the supplied accountId");
        }
        const doc = await ctx.db.get(normalized);
        if (!doc || doc.accountId !== args.accountId || doc.status !== "active") {
            throw new Error("Hook does not belong to the supplied accountId");
        }

        await ctx.db.patch(normalized, {
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.description !== undefined
                ? { description: args.description === null ? undefined : args.description }
                : {}),
            ...(args.events !== undefined ? { events: args.events } : {}),
            ...(args.bundleStorageKey !== undefined ? { bundleStorageKey: args.bundleStorageKey } : {}),
            ...(args.sha256 !== undefined ? { sha256: args.sha256 } : {}),
            updatedAt: Date.now(),
        });

        return null;
    },
});

export const remove = internalMutation({
    args: {
        accountId: v.id("accounts"),
        hookId: v.string(),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const normalized = ctx.db.normalizeId("accountHooks", args.hookId);
        if (!normalized) {
            throw new Error("Hook does not belong to the supplied accountId");
        }
        const doc = await ctx.db.get(normalized);
        if (!doc || doc.accountId !== args.accountId) {
            throw new Error("Hook does not belong to the supplied accountId");
        }

        await ctx.db.patch(normalized, {
            status: "deleted",
            deletedAt: Date.now(),
            updatedAt: Date.now(),
        });

        return null;
    },
});
