/**
 * Public conversation-history functions for the dashboard's agent Test chat.
 * Reads the runtime's own transcript store (`runtimeConversationEvents`) —
 * the product `conversations` table has no runtime writer and only annotates
 * runtime keys with titles. See model/conversationHistory.ts for the shape.
 *
 * Every function resolves the caller's ownership through the agent config's
 * project before touching any runtime row; conversation keys are addressed
 * behind an account+agent scoped prefix, so a guessed key from another tenant
 * can never resolve.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import {
  deleteAgentConversation,
  listAgentConversations,
  listConversationMessages,
  readConversationDeliverables,
  recordConversationDeliverables,
  renameAgentConversation,
  resolveAgentConversationScope,
} from "./model/conversationHistory";

const conversationSummary = v.object({
  conversationKey: v.string(),
  title: v.string(),
  createdAt: v.number(),
  lastMessageAt: v.number(),
});

export const listForAgent = query({
  args: { configId: v.id("agentConfigs") },
  returns: v.object({
    conversations: v.array(conversationSummary),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const scope = await resolveAgentConversationScope(
      ctx,
      user.id,
      args.configId,
    );
    if (!scope) return { conversations: [], truncated: false };

    return await listAgentConversations(ctx, scope);
  },
});

export const listMessages = query({
  args: {
    configId: v.id("agentConfigs"),
    conversationKey: v.string(),
    afterCursor: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(v.object({ cursor: v.string(), event: v.any() })),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const scope = await resolveAgentConversationScope(
      ctx,
      user.id,
      args.configId,
    );
    if (!scope) return { page: [], isDone: true, continueCursor: null };

    return await listConversationMessages(
      ctx,
      scope,
      args.conversationKey,
      args.afterCursor,
    );
  },
});

export const renameConversation = mutation({
  args: {
    configId: v.id("agentConfigs"),
    conversationKey: v.string(),
    title: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const scope = await resolveAgentConversationScope(
      ctx,
      user.id,
      args.configId,
    );
    if (!scope) throw new Error("Agent not found");
    await renameAgentConversation(ctx, scope, args.conversationKey, args.title);

    return null;
  },
});

export const deleteConversation = mutation({
  args: {
    configId: v.id("agentConfigs"),
    conversationKey: v.string(),
  },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const scope = await resolveAgentConversationScope(
      ctx,
      user.id,
      args.configId,
    );
    if (!scope) throw new Error("Agent not found");

    return await deleteAgentConversation(ctx, scope, args.conversationKey);
  },
});

const deliverableFile = v.object({
  path: v.string(),
  workspaceId: v.string(),
  sizeBytes: v.optional(v.number()),
  foundAt: v.number(),
});

/**
 * Record files the agent produced in a conversation (ticket 13): the
 * dashboard diffs the workspace around each run and persists what appeared,
 * so the deliverable cards survive the panel closing.
 */
export const recordDeliverables = mutation({
  args: {
    configId: v.id("agentConfigs"),
    conversationKey: v.string(),
    files: v.array(deliverableFile),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const scope = await resolveAgentConversationScope(
      ctx,
      user.id,
      args.configId,
    );
    if (!scope) throw new Error("Agent not found");
    await recordConversationDeliverables(
      ctx,
      scope,
      args.conversationKey,
      args.files,
    );

    return null;
  },
});

/** The deliverables recorded for one conversation, oldest first. */
export const listDeliverables = query({
  args: {
    configId: v.id("agentConfigs"),
    conversationKey: v.string(),
  },
  returns: v.array(deliverableFile),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const scope = await resolveAgentConversationScope(
      ctx,
      user.id,
      args.configId,
    );
    if (!scope) return [];

    return await readConversationDeliverables(ctx, scope, args.conversationKey);
  },
});
