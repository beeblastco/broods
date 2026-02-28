/**
 * Reusable cascading delete helpers for session and agent config cleanup.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Delete a session and all its nested data (messages, tasks, tool approvals).
 * @param ctx Mutation context
 * @param sessionId Session to delete
 */
export async function deleteSessionCascade(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
): Promise<void> {
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const message of messages) {
    await ctx.db.delete(message._id);
  }

  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const task of tasks) {
    await ctx.db.delete(task._id);
  }

  const approvals = await ctx.db
    .query("toolApprovals")
    .withIndex("by_sessionId_and_status", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const approval of approvals) {
    await ctx.db.delete(approval._id);
  }

  await ctx.db.delete(sessionId);
}

/**
 * Delete related data for an agent config (deployments, connections).
 * Does NOT delete the config or its sessions — handle those separately.
 * @param ctx Mutation context
 * @param configId Agent config whose related data to delete
 */
export async function deleteAgentConfigRelated(
  ctx: MutationCtx,
  configId: Id<"agentConfigs">,
): Promise<void> {
  const deployments = await ctx.db
    .query("agentDeployments")
    .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", configId))
    .collect();
  for (const deployment of deployments) {
    await ctx.db.delete(deployment._id);
  }

  const connections = await ctx.db
    .query("agentConnections")
    .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", configId))
    .collect();
  for (const connection of connections) {
    await ctx.db.delete(connection._id);
  }

  const inboundConnections = await ctx.db
    .query("agentConnections")
    .withIndex("by_targetType_and_targetId", (q) =>
      q.eq("targetType", "agent").eq("targetId", String(configId)),
    )
    .collect();
  for (const connection of inboundConnections) {
    await ctx.db.delete(connection._id);
  }
}
