/**
 * Agent config ownership verification helper.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

/**
 * Verify agent config ownership and return the config record.
 * @param ctx Query or mutation context
 * @param agentConfigId Agent config document ID
 * @param authId User's authentication ID
 * @returns Agent config document
 * @throws Error if config not found or user doesn't own it
 */
export async function verifyAgentConfigOwnership(
  ctx: QueryCtx | MutationCtx,
  agentConfigId: Id<"agentConfigs">,
  authId: string,
): Promise<Doc<"agentConfigs">> {
  const config = await ctx.db.get(agentConfigId);
  if (!config) {
    throw new Error("Agent config not found");
  }
  if (config.authId !== authId) {
    throw new Error("Access denied");
  }

  return config;
}
