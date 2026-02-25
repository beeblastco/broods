/**
 * User ownership verification helper.
 */
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

/**
 * Verify user exists and return the user record.
 * @param ctx Query or mutation context
 * @param authId User's authentication ID
 * @returns User document
 * @throws Error if user record not found
 */
export async function verifyUserOwnership(
  ctx: QueryCtx | MutationCtx,
  authId: string,
): Promise<Doc<"users">> {
  const userRecord = await ctx.db
    .query("users")
    .withIndex("by_authId", (q) => q.eq("authId", authId))
    .unique();
  if (!userRecord) {
    throw new Error("User record not found");
  }

  return userRecord;
}
