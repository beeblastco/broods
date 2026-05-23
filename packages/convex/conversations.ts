/**
 * Conversation CRUD scoped to an account. Every mutation revalidates the
 * conversation's accountId for defence in depth.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { conversationsFields } from "./schema";

const conversationDoc = v.object({
    ...conversationsFields,
    _id: v.id("conversations"),
    _creationTime: v.number(),
});

export const getById = internalQuery({
    args: {
        accountId: v.id("accounts"),
        conversationId: v.id("conversations"),
    },
    returns: v.union(conversationDoc, v.null()),
    handler: async (ctx, args) => {
        const conversation = await ctx.db.get(args.conversationId);
        if (!conversation || conversation.accountId !== args.accountId) {
            return null;
        }

        return conversation;
    },
});

export const list = internalQuery({
    args: { accountId: v.id("accounts") },
    returns: v.array(conversationDoc),
    handler: async (ctx, args) => {
        return await ctx.db
            .query("conversations")
            .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
            .collect();
    },
});

export const listByAgent = internalQuery({
    args: {
        accountId: v.id("accounts"),
        agentId: v.id("agents"),
    },
    returns: v.array(conversationDoc),
    handler: async (ctx, args) => {
        return await ctx.db
            .query("conversations")
            .withIndex("by_accountId_and_agentId", (q) =>
                q.eq("accountId", args.accountId).eq("agentId", args.agentId),
            )
            .collect();
    },
});

export const create = internalMutation({
    args: {
        accountId: v.id("accounts"),
        agentId: v.id("agents"),
        title: v.optional(v.string()),
    },
    returns: v.id("conversations"),
    handler: async (ctx, args) => {
        const agent = await ctx.db.get(args.agentId);
        if (!agent || agent.accountId !== args.accountId) {
            throw new Error("Agent does not belong to the supplied accountId");
        }

        const now = Date.now();
        return await ctx.db.insert("conversations", {
            accountId: args.accountId,
            agentId: args.agentId,
            title: args.title,
            createdAt: now,
            lastMessageAt: now,
        });
    },
});

export const update = internalMutation({
    args: {
        accountId: v.id("accounts"),
        conversationId: v.id("conversations"),
        title: v.optional(v.string()),
        lastMessageAt: v.optional(v.number()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { accountId, conversationId, title, lastMessageAt } = args;
        const conversation = await ctx.db.get(conversationId);
        if (!conversation || conversation.accountId !== accountId) {
            throw new Error("Conversation does not belong to the supplied accountId");
        }

        await ctx.db.patch(conversationId, {
            ...(title !== undefined && { title }),
            ...(lastMessageAt !== undefined && { lastMessageAt }),
        });

        return null;
    },
});

/**
 * Removes a conversation and all its messages, after verifying account ownership.
 */
export const remove = internalMutation({
    args: {
        accountId: v.id("accounts"),
        conversationId: v.id("conversations"),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const conversation = await ctx.db.get(args.conversationId);
        if (!conversation || conversation.accountId !== args.accountId) {
            return null;
        }

        const messages = await ctx.db
            .query("messages")
            .withIndex("by_conversationId", (q) =>
                q.eq("conversationId", args.conversationId),
            )
            .collect();
        for (const message of messages) {
            await ctx.db.delete(message._id);
        }

        await ctx.db.delete(args.conversationId);

        return null;
    },
});
