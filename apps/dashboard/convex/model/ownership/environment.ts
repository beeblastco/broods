/**
 * Environment ownership verification helper.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

/**
 * Verify environment ownership and return the environment record.
 * @param ctx Query or mutation context
 * @param environmentId Environment document ID
 * @param authId User's authentication ID
 * @returns Environment document
 * @throws Error if environment not found or user doesn't own it
 */
export async function verifyEnvironmentOwnership(
  ctx: QueryCtx | MutationCtx,
  environmentId: Id<"environments">,
  authId: string,
): Promise<Doc<"environments">> {
  const environment = await ctx.db.get(environmentId);
  if (!environment) {
    throw new Error("Environment not found");
  }
  if (environment.authId !== authId) {
    throw new Error("Access denied");
  }

  return environment;
}
