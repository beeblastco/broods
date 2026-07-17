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

export const list = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
  },
  returns: v.array(messageDoc),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) {
      return [];
    }

    return await ctx.db
      .query("messages")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .collect();
  },
});

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
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) {
      throw new Error("Conversation does not belong to the supplied accountId");
    }

    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      conversationId: args.conversationId,
      accountId: args.accountId,
      role: args.role,
      content: args.content,
      metadata: args.metadata,
      createdAt: now,
    });

    await ctx.db.patch(args.conversationId, { lastMessageAt: now });

    return messageId;
  },
});
