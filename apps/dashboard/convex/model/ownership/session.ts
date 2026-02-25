/**
 * Session ownership verification helper.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

/**
 * Verify session ownership and return the session record.
 * @param ctx Query or mutation context
 * @param sessionId Session document ID
 * @param authId User's authentication ID
 * @returns Session document
 * @throws Error if session not found or user doesn't own it
 */
export async function verifySessionOwnership(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"sessions">,
  authId: string,
): Promise<Doc<"sessions">> {
  const session = await ctx.db.get(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  if (session.authId !== authId) {
    throw new Error("Access denied");
  }

  return session;
}
