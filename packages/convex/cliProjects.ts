/**
 * Project listing and deletion for the `broods project` commands.
 *
 * Deletion reuses the dashboard's `purgeProject`, so a project removed from the
 * CLI leaves exactly what the dashboard's danger panel leaves: no stages, no
 * agent configs, no canvas, no env vars, no workspace files or blobs.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { purgeProject } from "./model/cascade";
import { resolveProject } from "./model/projectScope";

const projectValidator = v.object({
  id: v.id("projects"),
  name: v.string(),
  slug: v.string(),
  /** No stage, agent, variable or deployment: safe to delete without reading further. */
  empty: v.boolean(),
  stageCount: v.number(),
  agentCount: v.number(),
  variableCount: v.number(),
  deploymentCount: v.number(),
  updatedAt: v.number(),
});

/**
 * Every project in the account's org, each with the counts that say whether it
 * still holds anything. Sorted empty-last so a cleanup pass reads top-down.
 */
export const listByAccount = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.union(v.null(), v.array(projectValidator)),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.status !== "active") return null;
    const orgId = ctx.db.normalizeId("orgs", account.orgId);
    if (!orgId) return null;

    const projectDocs = await ctx.db
      .query("projects")
      .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
      .collect();
    const projects = [];
    for (const project of projectDocs) {
      projects.push(await summarize(ctx, project));
    }

    return projects.sort((left, right) =>
      left.empty !== right.empty
        ? left.empty
          ? 1
          : -1
        : left.name.localeCompare(right.name),
    );
  },
});

/**
 * Delete one project of the account's org and everything under it.
 *
 * Returns null when the name matches no project, so the caller can answer 404
 * rather than reporting a deletion that never happened. The counts come from
 * before the purge; they are what the CLI prints back.
 */
export const removeByAccount = internalMutation({
  args: {
    accountId: v.id("accounts"),
    project: v.string(),
  },
  returns: v.union(v.null(), projectValidator),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.status !== "active") return null;

    const projectDoc = await resolveProject(ctx, account, args.project);
    if (!projectDoc) return null;

    const summary = await summarize(ctx, projectDoc);
    await purgeProject(ctx, projectDoc._id);

    return summary;
  },
});

async function summarize(
  ctx: MutationCtx | QueryCtx,
  project: Doc<"projects">,
): Promise<{
  id: Id<"projects">;
  name: string;
  slug: string;
  empty: boolean;
  stageCount: number;
  agentCount: number;
  variableCount: number;
  deploymentCount: number;
  updatedAt: number;
}> {
  const stages = await ctx.db
    .query("stages")
    .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
    .collect();
  const agents = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", project._id),
    )
    .collect();
  const variables = await ctx.db
    .query("environmentVariables")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", project._id),
    )
    .collect();
  const deployments = await ctx.db
    .query("agentDeployments")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", project._id),
    )
    .collect();

  return {
    id: project._id,
    name: project.name,
    slug: project.slug,
    empty:
      stages.length === 0 &&
      agents.length === 0 &&
      variables.length === 0 &&
      deployments.length === 0,
    stageCount: stages.length,
    agentCount: agents.length,
    variableCount: variables.length,
    deploymentCount: deployments.length,
    updatedAt: project.updatedAt,
  };
}
