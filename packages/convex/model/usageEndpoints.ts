import type { Id } from "../_generated/dataModel";
import { type QueryCtx } from "../_generated/server";
import { getProjectForRole } from "./ownership/project";

export async function projectEndpointIds(
  ctx: QueryCtx,
  authId: string,
  projectId: Id<"projects">,
  stageId?: Id<"stages">,
): Promise<string[]> {
  const project = await getProjectForRole(ctx, authId, projectId);
  if (!project) return [];

  const deployments = stageId
    ? await ctx.db
        .query("agentDeployments")
        .withIndex("by_projectId_and_stageId_and_status", (q) =>
          q
            .eq("projectId", projectId)
            .eq("stageId", stageId)
            .eq("status", "active"),
        )
        .collect()
    : await ctx.db
        .query("agentDeployments")
        .withIndex("by_projectId_and_stageId_and_status", (q) =>
          q.eq("projectId", projectId),
        )
        .collect();

  return deployments
    .filter((deployment) => deployment.status === "active")
    .map((deployment) => deployment.endpointId);
}
