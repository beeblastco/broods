/**
 * Shared agent config helpers for connection and subagent resolution.
 */
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * Resolve explicitly connected subagents for a parent config.
 * @param ctx Convex query context
 * @param parentConfigId Parent agent config ID
 * @param authId Owner auth ID
 * @returns Connected subagent configs
 */
export async function resolveConnectedSubAgents(
  ctx: QueryCtx,
  parentConfigId: Id<"agentConfigs">,
  authId: string,
) {
  const connections = await ctx.db
    .query("agentConnections")
    .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", parentConfigId))
    .collect();

  const agentConnections = connections.filter((connection) => connection.targetType === "agent");
  if (agentConnections.length === 0) {
    return [];
  }

  const resolved = await Promise.all(
    agentConnections.map(async (connection) => {
      const configId = connection.targetId as Id<"agentConfigs">;
      const config = await ctx.db.get(configId);

      if (!config || config.authId !== authId || !config.isSubAgent) {
        return null;
      }

      return config;
    }),
  );

  return resolved.filter((config): config is NonNullable<typeof config> => config !== null);
}
