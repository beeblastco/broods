/**
 * Shared message helpers for persistence and format mapping.
 */
import { type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { messageContentFields, messageRoleEnum } from "../schema";

/**
 * Shared query logic to map persisted messages to model format.
 * @param ctx Query context
 * @param sessionId Session ID
 * @returns Model-formatted messages
 */
export async function listModelMessages(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
): Promise<Array<{
  role: Infer<typeof messageRoleEnum>;
  content: Infer<typeof messageContentFields>;
  providerOptions?: unknown;
}>> {
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
    .order("asc")
    .collect();

  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    providerOptions: message.providerOptions,
  }));
}

/**
 * Shared mutation logic for creating persisted messages.
 * @param ctx Mutation context
 * @param args Message persistence payload
 * @returns Created message ID
 */
export async function createMessage(
  ctx: MutationCtx,
  args: {
    sessionId: Id<"sessions">;
    message: {
      role: Infer<typeof messageRoleEnum>;
      content: Infer<typeof messageContentFields>;
    };
    providerOptions?: unknown;
    metadata?: unknown;
  },
): Promise<Id<"messages">> {
  const { sessionId, message, providerOptions, metadata } = args;

  const messageId = await ctx.db.insert("messages", {
    sessionId: sessionId,
    role: message.role,
    content: message.content,
    providerOptions: providerOptions,
    metadata: metadata,
    updatedAt: Date.now(),
  });

  await ctx.db.patch(sessionId, {
    updatedAt: Date.now(),
  });

  return messageId;
}
