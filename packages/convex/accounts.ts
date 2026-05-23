/**
 * Account CRUD + secret-hash lookup. Called by filthy-panty's
 * ConvexStorageProvider (via deploy key) and by cherry-coke's org lifecycle.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { accountsFields } from "./schema";

const accountDoc = v.object({
    ...accountsFields,
    _id: v.id("accounts"),
    _creationTime: v.number(),
});

/** Returns an account by its document id, or null when missing. */
export const getById = internalQuery({
    args: { accountId: v.id("accounts") },
    returns: v.union(accountDoc, v.null()),
    handler: async (ctx, args) => {
        const { accountId } = args;
        const account = await ctx.db.get(accountId);

        return account ?? null;
    },
});

/** Returns the account whose stored secretHash matches, or null. */
export const getBySecretHash = internalQuery({
    args: { secretHash: v.string() },
    returns: v.union(accountDoc, v.null()),
    handler: async (ctx, args) => {
        const { secretHash } = args;
        const account = await ctx.db
            .query("accounts")
            .withIndex("by_secretHash", (q) => q.eq("secretHash", secretHash))
            .unique();

        return account ?? null;
    },
});

/** Returns the account for a given org, or null when not yet provisioned. */
export const getByOrgId = internalQuery({
    args: { orgId: v.string() },
    returns: v.union(accountDoc, v.null()),
    handler: async (ctx, args) => {
        const { orgId } = args;
        const account = await ctx.db
            .query("accounts")
            .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
            .unique();

        return account ?? null;
    },
});

/** Lists all accounts. Admin/operational use only; not for end-user surfaces. */
export const list = internalQuery({
    args: {},
    returns: v.array(accountDoc),
    handler: async (ctx) => {
        const accounts = await ctx.db.query("accounts").collect();

        return accounts;
    },
});

/** Creates a new account row. The doc id becomes the public accountId. */
export const create = internalMutation({
    args: {
        orgId: v.string(),
        username: v.string(),
        description: v.optional(v.string()),
        secretHash: v.string(),
        status: v.optional(
            v.union(v.literal("active"), v.literal("disabled")),
        ),
    },
    returns: v.id("accounts"),
    handler: async (ctx, args) => {
        const { orgId, username, description, secretHash, status } = args;

        const existing = await ctx.db
            .query("accounts")
            .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
            .unique();
        if (existing) {
            throw new Error(`Account already exists for orgId=${orgId}`);
        }

        const now = Date.now();
        const accountId = await ctx.db.insert("accounts", {
            orgId: orgId,
            username: username,
            description: description,
            secretHash: secretHash,
            status: status ?? "active",
            createdAt: now,
            updatedAt: now,
        });

        return accountId;
    },
});

/** Patches account fields. Cannot change orgId. */
export const update = internalMutation({
    args: {
        accountId: v.id("accounts"),
        username: v.optional(v.string()),
        description: v.optional(v.string()),
        status: v.optional(
            v.union(v.literal("active"), v.literal("disabled")),
        ),
        secretHash: v.optional(v.string()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { accountId, username, description, status, secretHash } = args;

        const account = await ctx.db.get(accountId);
        if (!account) {
            throw new Error(`Account not found: ${accountId}`);
        }

        await ctx.db.patch(accountId, {
            ...(username !== undefined ? { username: username } : {}),
            ...(description !== undefined ? { description: description } : {}),
            ...(status !== undefined ? { status: status } : {}),
            ...(secretHash !== undefined ? { secretHash: secretHash } : {}),
            updatedAt: Date.now(),
        });

        return null;
    },
});

/**
 * Removes an account and cascade-deletes its agents, conversations, messages,
 * skills, and async results. S3 cleanup is the caller's responsibility.
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

        const agents = await ctx.db
            .query("agents")
            .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
            .collect();
        for (const agent of agents) {
            await ctx.db.delete(agent._id);
        }

        const conversations = await ctx.db
            .query("conversations")
            .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
            .collect();
        for (const conversation of conversations) {
            await ctx.db.delete(conversation._id);
        }

        const messages = await ctx.db
            .query("messages")
            .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
            .collect();
        for (const message of messages) {
            await ctx.db.delete(message._id);
        }

        const skills = await ctx.db
            .query("skills")
            .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
            .collect();
        for (const skill of skills) {
            await ctx.db.delete(skill._id);
        }

        const asyncResults = await ctx.db
            .query("asyncResults")
            .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
            .collect();
        for (const result of asyncResults) {
            await ctx.db.delete(result._id);
        }

        await ctx.db.delete(accountId);

        return null;
    },
});
