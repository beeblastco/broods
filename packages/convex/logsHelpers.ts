/**
 * Endpoint-resolution helper for the logs/usage reads: maps a project to the
 * `endpointId`s that key the usage tables. Takes a query ctx so the reactive
 * `logs.ts` queries can call it directly.
 */

import type { Id } from "./_generated/dataModel";
import { type QueryCtx } from "./_generated/server";
import { getOwnedProject } from "./model/ownership/project";

/**
 * Active deployment endpointIds for a project, optionally narrowed to a single
 * environment. Returns `[]` when the caller does not own the project.
 * @param ctx QueryCtx for the reactive query calling this helper
 * @param authId WorkOS auth id of the caller
 * @param projectId project to scope to
 * @param environmentId optional environment to narrow to
 * @returns active endpointId strings
 */
export async function projectEndpointIds(
  ctx: QueryCtx,
  authId: string,
  projectId: Id<"projects">,
  environmentId?: Id<"environments">,
): Promise<string[]> {
  const project = await getOwnedProject(ctx, authId, projectId);
  if (!project) return [];

  const deployments = environmentId
    ? await ctx.db
        .query("agentDeployments")
        .withIndex("by_projectId_and_environmentId_and_status", (q) =>
          q
            .eq("projectId", projectId)
            .eq("environmentId", environmentId)
            .eq("status", "active"),
        )
        .collect()
    : await ctx.db
        .query("agentDeployments")
        .withIndex("by_projectId_and_environmentId_and_status", (q) =>
          q.eq("projectId", projectId),
        )
        .collect();

  return deployments
    .filter((deployment) => deployment.status === "active")
    .map((deployment) => deployment.endpointId);
}
