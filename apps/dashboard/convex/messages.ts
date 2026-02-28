/**
 * Message persistence helpers for agent conversations.
 */
import { withSystemFields } from "convex-helpers/validators";
import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { createMessage, listModelMessages } from "./model/messages";
import { messageContentFields, messageFields, messageRoleEnum } from "./schema";
import { verifySessionOwnership } from "./model/ownership";

/** Validator for message records with system fields. */
const messageValidator = v.object(withSystemFields("messages", messageFields));

/** Validator for model message format used by the AI SDK. */
const modelMessageValidator = v.object({
  role: messageRoleEnum,
  content: messageContentFields,
  providerOptions: v.optional(v.any()),
});

/**
 * List messages in a session for the authenticated user.
 * @param sessionId Session ID
 * @returns Conversation messages sorted ascending by creation time
 */
export const list = query({
  args: {
    sessionId: v.id("sessions"),
  },
  returns: v.array(messageValidator),
  handler: async (ctx, args) => {
    const { sessionId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    await verifySessionOwnership(ctx, sessionId, user.subject);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .order("asc")
      .collect();

    return messages;
  },
});

/**
 * List model messages for internal agent execution.
 * @param sessionId Session ID
 * @returns Messages mapped to AI SDK model-message format
 */
export const listInternal = internalQuery({
  args: {
    sessionId: v.id("sessions"),
  },
  returns: v.array(modelMessageValidator),
  handler: async (ctx, args) => {
    const { sessionId } = args;
    return await listModelMessages(ctx, sessionId);
  },
});

/**
 * List model messages for gateway execution with shared-secret auth.
 * @param sessionId Session ID
 * @returns Messages mapped to AI SDK model-message format
 */
export const listForGateway = internalQuery({
  args: {
    sessionId: v.id("sessions"),
  },
  returns: v.array(modelMessageValidator),
  handler: async (ctx, args) => {
    const { sessionId } = args;

    return await listModelMessages(ctx, sessionId);
  },
});

/**
 * Create one message in a session for internal orchestration.
 * @param sessionId Session ID
 * @param message Message payload
 * @param providerOptions Optional provider metadata
 * @param metadata Optional custom metadata
 * @returns Created message ID
 */
export const createInternal = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    message: v.object({
      role: messageRoleEnum,
      content: messageContentFields,
    }),
    providerOptions: v.optional(v.any()),
    metadata: v.optional(v.any()),
  },
  returns: v.id("messages"),
  handler: async (ctx, args) => {
    return await createMessage(ctx, args);
  },
});

/**
 * Create one message from gateway with shared-secret auth.
 * @param sessionId Session ID
 * @param message Message payload
 * @param providerOptions Optional provider metadata
 * @param metadata Optional custom metadata
 * @returns Created message ID
 */
export const createForGateway = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    message: v.object({
      role: messageRoleEnum,
      content: messageContentFields,
    }),
    providerOptions: v.optional(v.any()),
    metadata: v.optional(v.any()),
  },
  returns: v.id("messages"),
  handler: async (ctx, args) => {
    return await createMessage(ctx, args);
  },
});

