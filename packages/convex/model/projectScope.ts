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

/** The (project, environment) pair every environment-scoped resource hangs off. */
export type ProjectEnvironmentScope = {
  projectId: Id<"projects">;
  environmentId: Id<"environments">;
};

/** Environment names are matched case- and whitespace-insensitively everywhere. */
export function environmentNameEquals(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

// Resolve-only: an unknown name yields null rather than creating a project,
// which is what separates every read path from the CLI's ensure path.
export async function resolveProjectEnvironment(
  ctx: Ctx,
  account: Doc<"accounts">,
  project: string,
  environment: string,
): Promise<{
  projectDoc: Doc<"projects">;
  environmentDoc: Doc<"environments">;
} | null> {
  const orgId = ctx.db.normalizeId("orgs", account.orgId);
  if (!orgId) return null;
  const name = project.trim();
  if (!name) return null;

  const projects = await ctx.db
    .query("projects")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .collect();
  const projectDoc = projects.find(
    (entry) => entry.name === name || entry.slug === name,
  );
  if (!projectDoc) return null;

  const environments = await ctx.db
    .query("environments")
    .withIndex("by_projectId", (q) => q.eq("projectId", projectDoc._id))
    .collect();
  const environmentDoc = environments.find((entry) =>
    environmentNameEquals(entry.name, environment),
  );
  if (!environmentDoc) return null;

  return {
    projectDoc: projectDoc,
    environmentDoc: environmentDoc,
  };
}

/**
 * The agents that `accountId` owns and that belong to `projectId`, across
 * every environment.
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
  // Prefix scan on the compound index: every environment of this project.
  const configs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_environmentId", (q) =>
      q.eq("projectId", projectId),
    )
    .collect();

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
