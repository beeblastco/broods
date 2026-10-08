/**
 * Resolves which account-plane objects belong to a project.
 *
 * `agents` rows are account-scoped and carry no projectId. The only link
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

/** The agents of exactly one stage, which is what a stage webhook URL routes on. */
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

/**
 * Whether `agentId` has a config row in `projectId` on any stage: one indexed
 * read, for a check on a single cron or conversation.
 */
export async function agentInProject(
  ctx: Ctx,
  agentId: Id<"agents">,
  projectId: Id<"projects">,
): Promise<boolean> {
  const configs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_agentId", (q) => q.eq("agentId", agentId))
    .collect();

  return configs.some((config) => config.projectId === projectId);
}

/** The crons whose agent belongs to `projectId` and is owned by `accountId`. */
export async function cronsInProject(
  ctx: Ctx,
  projectId: Id<"projects">,
  accountId: Id<"accounts">,
): Promise<Doc<"crons">[]> {
  // One range per agent, so a cron run elsewhere in the account does not
  // re-run the dashboard's always-mounted `listForProject` subscription.
  const agents = await agentsInProject(ctx, projectId, accountId);
  const crons = await Promise.all(
    agents.map((agent) =>
      ctx.db
        .query("crons")
        .withIndex("by_accountId_and_agentId", (q) =>
          q.eq("accountId", accountId).eq("agentId", agent._id),
        )
        .collect(),
    ),
  );

  return crons.flat();
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
    .withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId))
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

/** Stage names are matched case- and whitespace-insensitively everywhere. */
export function stageNameEquals(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

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

/** The API resource families whose rows live in one stage. */
export const STAGE_SCOPED_RESOURCE_TYPES = [
  "agents",
  "channels",
  "crons",
  "mcp",
  "policies",
  "sandboxes",
  "workspaces",
] as const;

export type StageScopedResourceType =
  (typeof STAGE_SCOPED_RESOURCE_TYPES)[number];

/**
 * The stage one of `accountId`'s resources lives in, for a stage-pinned role's
 * check. Null when the row is missing, belongs to another account, is
 * account-scoped, or (for an agent) has config rows on more than one stage.
 */
export async function resourceStageScope(
  ctx: Ctx,
  accountId: Id<"accounts">,
  type: StageScopedResourceType,
  id: string,
): Promise<ProjectStageScope | null> {
  switch (type) {
    case "agents":
      return await agentStageScope(ctx, accountId, id);
    case "crons": {
      const cronId = ctx.db.normalizeId("crons", id);
      const cron = cronId ? await ctx.db.get(cronId) : null;
      if (!cron || cron.accountId !== accountId) return null;

      return await agentStageScope(ctx, accountId, cron.agentId);
    }
    case "channels":
      return rowStageScope(accountId, await getRow(ctx, "channelRecords", id));
    case "mcp":
      return rowStageScope(accountId, await getRow(ctx, "mcp", id));
    case "policies":
      return rowStageScope(accountId, await getRow(ctx, "agentPolicies", id));
    case "sandboxes":
      return rowStageScope(accountId, await getRow(ctx, "sandboxConfigs", id));
    case "workspaces":
      return rowStageScope(
        accountId,
        await getRow(ctx, "workspaceConfigs", id),
      );
  }
}

async function agentStageScope(
  ctx: Ctx,
  accountId: Id<"accounts">,
  id: string,
): Promise<ProjectStageScope | null> {
  const agent = await getRow(ctx, "agents", id);
  if (!agent || agent.accountId !== accountId) return null;
  const configs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_agentId", (q) => q.eq("agentId", agent._id))
    .collect();
  const [first] = configs;
  if (
    !first ||
    configs.some(
      (config) =>
        config.projectId !== first.projectId ||
        config.stageId !== first.stageId,
    )
  ) {
    return null;
  }

  return { projectId: first.projectId, stageId: first.stageId };
}

async function getRow<
  T extends
    | "agentPolicies"
    | "agents"
    | "channelRecords"
    | "mcp"
    | "sandboxConfigs"
    | "workspaceConfigs",
>(ctx: Ctx, table: T, id: string): Promise<Doc<T> | null> {
  const normalized = ctx.db.normalizeId(table, id);

  return normalized ? await ctx.db.get(normalized) : null;
}

function rowStageScope(
  accountId: Id<"accounts">,
  row: {
    accountId: Id<"accounts">;
    projectId?: Id<"projects">;
    stageId?: Id<"stages">;
  } | null,
): ProjectStageScope | null {
  if (!row || row.accountId !== accountId) return null;
  if (!row.projectId || !row.stageId) return null;

  return { projectId: row.projectId, stageId: row.stageId };
}
