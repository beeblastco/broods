/**
 * Resolves which account-plane objects belong to a project.
 *
 * `agents` rows are account-scoped and carry no projectId — the only link
 * between the account plane and the project plane is `agentConfigs.projectId`,
 * written by the canvas or by the API back-sync. Crons and conversations have
 * no projectId either; they point at an agent, so their project is whatever
 * their agent's is. Deriving that here, rather than storing a copy on each
 * table, is what makes it impossible for a cron to claim a different project
 * than the agent it actually runs.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type Ctx = QueryCtx | MutationCtx;

/** The (project, stage) pair every stage-scoped resource hangs off. */
export type ProjectStageScope = {
  projectId: Id<"projects">;
  stageId: Id<"stages">;
};

/** Stage names are matched case- and whitespace-insensitively everywhere. */
export function stageNameEquals(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

// Resolve-only: an unknown name yields null rather than creating a project,
// which is what separates every read path from the CLI's ensure path.
export async function resolveProject(
  ctx: Ctx,
  account: Doc<"accounts">,
  project: string,
): Promise<Doc<"projects"> | null> {
  const orgId = ctx.db.normalizeId("orgs", account.orgId);
  if (!orgId) return null;
  const name = project.trim();
  if (!name) return null;

  const projects = await ctx.db
    .query("projects")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .collect();

  return (
    projects.find((entry) => entry.name === name || entry.slug === name) ?? null
  );
}

export async function resolveProjectStage(
  ctx: Ctx,
  account: Doc<"accounts">,
  project: string,
  stage: string,
): Promise<{
  projectDoc: Doc<"projects">;
  stageDoc: Doc<"stages">;
} | null> {
  const projectDoc = await resolveProject(ctx, account, project);
  if (!projectDoc) return null;

  const stages = await ctx.db
    .query("stages")
    .withIndex("by_projectId", (q) => q.eq("projectId", projectDoc._id))
    .collect();
  const stageDoc = stages.find((entry) => stageNameEquals(entry.name, stage));
  if (!stageDoc) return null;

  return {
    projectDoc: projectDoc,
    stageDoc: stageDoc,
  };
}

/**
 * The agents that `accountId` owns and that belong to `projectId`, across
 * every stage.
 *
 * Both halves are required. `agentConfigs.agentId` is a loose `v.string()`,
 * so a stale or hand-edited row can name an agent on another account; without
 * the accountId check that agent's metadata would surface in this project's
 * scheduler and offer an unusable picker option. Agents with no config row
 * belong to no project and are absent.
 */
export async function agentsInProject(
  ctx: Ctx,
  projectId: Id<"projects">,
  accountId: Id<"accounts">,
): Promise<Doc<"agents">[]> {
  // Prefix scan on the compound index: every stage of this project.
  const configs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) => q.eq("projectId", projectId))
    .collect();

  return await agentsForConfigs(ctx, configs, accountId);
}

/**
 * The agents of exactly one stage. The stage-scoped webhook URL routes on
 * this, so a sibling stage sharing the same channel credentials is excluded
 * rather than left to a tie-break.
 */
export async function agentsInStage(
  ctx: Ctx,
  scope: ProjectStageScope,
  accountId: Id<"accounts">,
): Promise<Doc<"agents">[]> {
  const configs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", scope.projectId).eq("stageId", scope.stageId),
    )
    .collect();

  return await agentsForConfigs(ctx, configs, accountId);
}

/** The crons whose agent belongs to `projectId` and is owned by `accountId`. */
export async function cronsInProject(
  ctx: Ctx,
  projectId: Id<"projects">,
  accountId: Id<"accounts">,
): Promise<Doc<"crons">[]> {
  const agentIds = new Set(
    (await agentsInProject(ctx, projectId, accountId)).map(
      (agent) => agent._id,
    ),
  );

  const crons = await ctx.db
    .query("crons")
    .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
    .collect();

  return crons.filter((cron) => agentIds.has(cron.agentId));
}

// `agentConfigs.agentId` is a loose `v.string()`, so the accountId check is
// what stops a stale row naming another account's agent from surfacing here.
async function agentsForConfigs(
  ctx: Ctx,
  configs: Doc<"agentConfigs">[],
  accountId: Id<"accounts">,
): Promise<Doc<"agents">[]> {
  const agents: Doc<"agents">[] = [];
  for (const config of configs) {
    if (!config.agentId) continue;
    const normalized = ctx.db.normalizeId("agents", config.agentId);
    if (!normalized) continue;
    const agent = await ctx.db.get(normalized);
    if (!agent) continue;
    if (agent.accountId !== accountId) continue;

    agents.push(agent);
  }

  return agents;
}
