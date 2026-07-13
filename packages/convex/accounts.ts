/**
 * Account CRUD + secret-hash lookup. Called by broods's
 * ConvexStorageProvider (via deploy key) and by the dashboard's org lifecycle.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { deleteAccountContents, deleteAccountContentsBatch } from "./model/cascade";
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

/**
 * Creates an account with a unique organization binding.
 * @returns the complete persisted account document
 */
export const create = internalMutation({
    args: {
        orgId: v.string(),
        username: v.string(),
        description: v.optional(v.string()),
        secretHash: v.string(),
        status: v.optional(statusValidator),
    },
    returns: accountDoc,
    handler: async (ctx, args) => {
        const existing = await ctx.db
            .query("accounts")
            .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
            .unique();
        if (existing) {
            throw new Error(`Account already exists for orgId=${args.orgId}`);
        }

        const now = Date.now();
        const accountId = await ctx.db.insert("accounts", {
            orgId: args.orgId,
            username: args.username,
            description: args.description,
            secretHash: args.secretHash,
            status: args.status ?? "active",
            createdAt: now,
            updatedAt: now,
        });
        const account = await ctx.db.get(accountId);
        if (!account) {
            throw new Error("Failed to read created account");
        }

        return account;
    },
});

/**
 * Updates an existing account's mutable fields.
 * @returns the updated document, or null when the account does not exist
 */
export const update = internalMutation({
    args: {
        accountId: v.id("accounts"),
        username: v.optional(v.string()),
        description: v.optional(v.union(v.string(), v.null())),
        status: v.optional(statusValidator),
        secretHash: v.optional(v.string()),
    },
    returns: v.union(accountDoc, v.null()),
    handler: async (ctx, args) => {
        const { accountId, ...patch } = args;
        const account = await ctx.db.get(accountId);
        if (!account) {

            return null;
        }

        await ctx.db.patch(accountId, {
            ...(patch.username !== undefined && { username: patch.username }),
            ...(patch.description !== undefined && { description: patch.description ?? undefined }),
            ...(patch.status !== undefined && { status: patch.status }),
            ...(patch.secretHash !== undefined && { secretHash: patch.secretHash }),
            updatedAt: Date.now(),
        });

        return await ctx.db.get(accountId);
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

        await deleteAccountContents(ctx, accountId);

        return null;
    },
});

/** Removes one bounded batch of an account's related rows. */
export const removeBatch = internalMutation({
    args: { accountId: v.id("accounts") },
    returns: v.boolean(),
    handler: async (ctx, args) => {
        return await deleteAccountContentsBatch(ctx, args.accountId);
    },
});
