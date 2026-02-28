/**
 * Shared agent config helpers for connection and subagent resolution.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

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

      if (!config || config.authId !== authId) {
        return null;
      }

      return config;
    }),
  );

  return resolved.filter((config): config is NonNullable<typeof config> => config !== null);
}

/**
 * Sync isSubAgent flags from inbound agent->agent connections.
 * A config becomes a subagent when any agent in the same environment targets it.
 */
export async function syncSubAgentFlagsForEnvironment(
  ctx: MutationCtx,
  args: {
    projectId: Id<"projects">;
    environmentId: Id<"environments">;
  },
): Promise<void> {
  const { projectId, environmentId } = args;

  const agentConfigs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_environmentId", (q) =>
      q.eq("projectId", projectId).eq("environmentId", environmentId),
    )
    .collect();

  if (agentConfigs.length === 0) {
    return;
  }

  const configIds = new Set(agentConfigs.map((config) => String(config._id)));
  const inboundSubAgentIds = new Set<string>();

  for (const config of agentConfigs) {
    const connections = await ctx.db
      .query("agentConnections")
      .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", config._id))
      .collect();

    for (const connection of connections) {
      if (
        connection.targetType === "agent" &&
        configIds.has(connection.targetId)
      ) {
        inboundSubAgentIds.add(connection.targetId);
      }
    }
  }

  for (const config of agentConfigs) {
    const nextIsSubAgent = inboundSubAgentIds.has(String(config._id));
    if (config.isSubAgent !== nextIsSubAgent) {
      await ctx.db.patch(config._id, {
        isSubAgent: nextIsSubAgent,
        updatedAt: Date.now(),
      });
    }
  }
}
