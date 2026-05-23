/**
 * Message append + list for a conversation. Both accountId and conversationId
 * are validated on every write so a leaked deploy key cannot cross-tenant.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { messagesFields } from "./schema";

const messageDoc = v.object({
    ...messagesFields,
    _id: v.id("messages"),
    _creationTime: v.number(),
});

/** Lists every message in a conversation owned by the supplied account. */
export const list = internalQuery({
    args: {
        accountId: v.id("accounts"),
        conversationId: v.id("conversations"),
    },
    returns: v.array(messageDoc),
    handler: async (ctx, args) => {
        const { accountId, conversationId } = args;

        const conversation = await ctx.db.get(conversationId);
        if (!conversation || conversation.accountId !== accountId) {
            return [];
        }

        const messages = await ctx.db
            .query("messages")
            .withIndex("by_conversationId", (q) =>
                q.eq("conversationId", conversationId),
            )
            .collect();

        return messages;
    },
});

/**
 * Appends a message to a conversation and bumps its lastMessageAt. Verifies
 * both account ownership and conversation ownership.
 */
export const create = internalMutation({
    args: {
        accountId: v.id("accounts"),
        conversationId: v.id("conversations"),
        role: v.union(
            v.literal("system"),
            v.literal("user"),
            v.literal("assistant"),
            v.literal("tool"),
        ),
        content: v.string(),
        metadata: v.optional(v.any()),
    },
    returns: v.id("messages"),
    handler: async (ctx, args) => {
        const { accountId, conversationId, role, content, metadata } = args;

        const conversation = await ctx.db.get(conversationId);
        if (!conversation || conversation.accountId !== accountId) {
            throw new Error(
                "Conversation does not belong to the supplied accountId",
            );
        }

        const now = Date.now();
        const messageId = await ctx.db.insert("messages", {
            conversationId: conversationId,
            accountId: accountId,
            role: role,
            content: content,
            metadata: metadata,
            createdAt: now,
        });

        await ctx.db.patch(conversationId, { lastMessageAt: now });

        return messageId;
    },
});
