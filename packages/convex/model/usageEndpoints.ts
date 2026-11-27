import type { Doc, Id } from "../_generated/dataModel";
import { type QueryCtx } from "../_generated/server";
import { getProjectForRole } from "./ownership/project";

// Endpoint ids are not unique across accounts, so every usage read names the account too.
export type UsageEndpoint = Pick<
  Doc<"agentDeployments">,
  "accountId" | "endpointId"
>;

export async function projectEndpoints(
  ctx: QueryCtx,
  authId: string,
  projectId: Id<"projects">,
  stageId?: Id<"stages">,
): Promise<UsageEndpoint[]> {
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
    .map((deployment) => ({
      accountId: deployment.accountId,
      endpointId: deployment.endpointId,
    }));
}
