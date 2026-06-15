/**
 * Account CRUD + secret-hash lookup. Called by filthy-panty's
 * ConvexStorageProvider (via deploy key) and by the dashboard's org lifecycle.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { accountsFields } from "./schema";

const accountDoc = v.object({
    ...accountsFields,
    _id: v.id("accounts"),
    _creationTime: v.number(),
});

const statusValidator = v.union(v.literal("active"), v.literal("disabled"));

export const getById = internalQuery({
    args: { accountId: v.id("accounts") },
    returns: v.union(accountDoc, v.null()),
    handler: async (ctx, args) => {
        return await ctx.db.get(args.accountId);
    },
});

export const getBySecretHash = internalQuery({
    args: { secretHash: v.string() },
    returns: v.union(accountDoc, v.null()),
    handler: async (ctx, args) => {
        return await ctx.db
            .query("accounts")
            .withIndex("by_secretHash", (q) => q.eq("secretHash", args.secretHash))
            .unique();
    },
});

export const getByOrgId = internalQuery({
    args: { orgId: v.string() },
    returns: v.union(accountDoc, v.null()),
    handler: async (ctx, args) => {
        return await ctx.db
            .query("accounts")
            .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
            .unique();
    },
});

export const list = internalQuery({
    args: {},
    returns: v.array(accountDoc),
    handler: async (ctx) => {
        return await ctx.db.query("accounts").collect();
    },
});

export const create = internalMutation({
    args: {
        orgId: v.string(),
        username: v.string(),
        description: v.optional(v.string()),
        secretHash: v.string(),
        status: v.optional(statusValidator),
    },
    returns: v.id("accounts"),
    handler: async (ctx, args) => {
        const existing = await ctx.db
            .query("accounts")
            .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
            .unique();
        if (existing) {
            throw new Error(`Account already exists for orgId=${args.orgId}`);
        }

        const now = Date.now();
        return await ctx.db.insert("accounts", {
            orgId: args.orgId,
            username: args.username,
            description: args.description,
            secretHash: args.secretHash,
            status: args.status ?? "active",
            createdAt: now,
            updatedAt: now,
        });
    },
});

export const update = internalMutation({
    args: {
        accountId: v.id("accounts"),
        username: v.optional(v.string()),
        description: v.optional(v.string()),
        status: v.optional(statusValidator),
        secretHash: v.optional(v.string()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { accountId, ...patch } = args;
        const account = await ctx.db.get(accountId);
        if (!account) {
            throw new Error(`Account not found: ${accountId}`);
        }

        await ctx.db.patch(accountId, {
            ...(patch.username !== undefined && { username: patch.username }),
            ...(patch.description !== undefined && { description: patch.description }),
            ...(patch.status !== undefined && { status: patch.status }),
            ...(patch.secretHash !== undefined && { secretHash: patch.secretHash }),
            updatedAt: Date.now(),
        });

        return null;
    },
});

/**
 * Removes an account and cascade-deletes its agents, sandbox/workspace configs,
 * conversations, messages, skills, async results, and cron jobs. S3 cleanup is
 * the caller's responsibility.
 */
export const remove = internalMutation({
    args: { accountId: v.id("accounts") },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { accountId } = args;
        const account = await ctx.db.get(accountId);
        if (!account) {
            return null;
        }

        const tables = [
            "agents",
            "sandboxConfigs",
            "workspaceConfigs",
            "conversations",
            "messages",
            "skills",
            "asyncResults",
            "crons",
        ] as const;
        for (const table of tables) {
            const docs = await ctx.db
                .query(table)
                .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
                .collect();
            for (const doc of docs) {
                await ctx.db.delete(doc._id);
            }
        }

        await ctx.db.delete(accountId);

        return null;
    },
});
