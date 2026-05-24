/**
 * Agent CRUD scoped to an account. Every mutation revalidates the agent's
 * accountId against the caller-supplied accountId for defence in depth.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { authKit } from "./auth";
import { getActiveOrgForUser } from "./model/ownership/org";
import { agentsFields } from "./schema";

const agentDoc = v.object({
    ...agentsFields,
    _id: v.id("agents"),
    _creationTime: v.number(),
});

export const getById = internalQuery({
    args: {
        accountId: v.id("accounts"),
        agentId: v.id("agents"),
    },
    returns: v.union(agentDoc, v.null()),
    handler: async (ctx, args) => {
        const agent = await ctx.db.get(args.agentId);
        if (!agent || agent.accountId !== args.accountId) {
            return null;
        }

        return agent;
    },
});

/**
 * Public query: lists the caller's active-org agents. Used by the cron-jobs
 * UI dropdown to pick which agent a scheduled run targets.
 */
export const listForActiveOrg = query({
    args: {},
    returns: v.array(agentDoc),
    handler: async (ctx) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
            .unique();
        if (!user) return [];

        const org = await getActiveOrgForUser(ctx, user._id);
        if (!org) return [];

        const account = await ctx.db
            .query("accounts")
            .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
            .unique();
        if (!account) return [];

        return await ctx.db
            .query("agents")
            .withIndex("by_accountId", (q) => q.eq("accountId", account._id))
            .collect();
    },
});

export const list = internalQuery({
    args: { accountId: v.id("accounts") },
    returns: v.array(agentDoc),
    handler: async (ctx, args) => {
        return await ctx.db
            .query("agents")
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
    returns: v.id("agents"),
    handler: async (ctx, args) => {
        const account = await ctx.db.get(args.accountId);
        if (!account) {
            throw new Error(`Account not found: ${args.accountId}`);
        }

        const now = Date.now();
        return await ctx.db.insert("agents", {
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
        agentId: v.id("agents"),
        name: v.optional(v.string()),
        description: v.optional(v.string()),
        encryptedConfig: v.optional(v.string()),
        encryptionIv: v.optional(v.string()),
        encryptionTag: v.optional(v.string()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { accountId, agentId, ...patch } = args;
        const agent = await ctx.db.get(agentId);
        if (!agent || agent.accountId !== accountId) {
            throw new Error("Agent does not belong to the supplied accountId");
        }

        await ctx.db.patch(agentId, {
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
        agentId: v.id("agents"),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const agent = await ctx.db.get(args.agentId);
        if (!agent || agent.accountId !== args.accountId) {
            throw new Error("Agent does not belong to the supplied accountId");
        }
        await ctx.db.delete(args.agentId);

        return null;
    },
});
