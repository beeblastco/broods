// Agents, crons and conversations take their project from agentConfigs.projectId, never a
// stored copy, so a cron can not claim another project than the agent it runs.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type Ctx = QueryCtx | MutationCtx;

export type ProjectStageScope = {
  projectId: Id<"projects">;
  stageId: Id<"stages">;
};

export async function agentsInProject(
  ctx: Ctx,
  projectId: Id<"projects">,
  accountId: Id<"accounts">,
): Promise<Doc<"agents">[]> {
  const configs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) => q.eq("projectId", projectId))
    .collect();

  return await agentsForConfigs(ctx, configs, accountId);
}

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

export async function cronsInProject(
  ctx: Ctx,
  projectId: Id<"projects">,
  accountId: Id<"accounts">,
): Promise<Doc<"crons">[]> {
  // One range per agent, so a cron run elsewhere does not re-run `listForProject`.
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
    // `agentConfigs.agentId` is a loose string: a stale row can name another account's agent.
    if (agent.accountId !== accountId) continue;

    agents.push(agent);
  }

  return agents;
}

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

export type StageScopedRef = { type: StageScopedResourceType; id: string };

export async function refsOutsideStage(
  ctx: Ctx,
  accountId: Id<"accounts">,
  pin: { projectId: string; stageId: string },
  refs: StageScopedRef[],
): Promise<StageScopedRef[]> {
  const outside: StageScopedRef[] = [];
  for (const ref of refs) {
    const scope = await resourceStageScope(ctx, accountId, ref.type, ref.id);
    if (scope?.projectId !== pin.projectId || scope.stageId !== pin.stageId) {
      outside.push(ref);
    }
  }

  return outside;
}

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
