/** One read model for the dashboard's key lists: org keys, a project's runtime and API keys. */

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { keyActionsValidator } from "./accountApiKeys";
import { authKit } from "./auth";
import {
  API_POLICY_ACTIONS,
  type ApiPolicyAction,
  type PolicyDocument,
} from "./model/policyRules";
import {
  hasDashboardPermission,
  memberAccess,
  policiesAllowOrTier,
} from "./model/access";
import { actorOf, actorsOf, actorValidator } from "./model/actor";
import { getActiveOrgForUser, userByAuthId } from "./model/ownership/org";
import { getProjectForRole } from "./model/ownership/project";

/** The account key has no `_id` and no `actions`: it reaches everything. */
const orgKeyValidator = v.object({
  _id: v.optional(v.id("accountApiKeys")),
  name: v.string(),
  description: v.optional(v.string()),
  keyHint: v.optional(v.string()),
  actions: v.optional(keyActionsValidator),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  expiresAt: v.optional(v.number()),
  lastUsedAt: v.optional(v.number()),
  createdAt: v.number(),
  createdBy: v.optional(actorValidator),
});

const orgKeysValidator = v.object({
  keys: v.array(orgKeyValidator),
  stages: v.array(
    v.object({
      projectId: v.id("projects"),
      projectName: v.string(),
      stageId: v.id("stages"),
      stageName: v.string(),
    }),
  ),
});

const runtimeKeyValidator = v.object({
  stageId: v.id("stages"),
  stageName: v.string(),
  keyHint: v.string(),
  lastUsedAt: v.optional(v.number()),
  rotatedAt: v.optional(v.number()),
  rotatedBy: v.optional(actorValidator),
});

const apiKeyValidator = v.object({
  _id: v.id("deployKeys"),
  name: v.string(),
  description: v.optional(v.string()),
  stageId: v.id("stages"),
  stageName: v.string(),
  keyHint: v.string(),
  lastUsedAt: v.optional(v.number()),
  createdAt: v.number(),
  createdBy: v.optional(actorValidator),
});

const projectKeysValidator = v.object({
  runtime: v.array(runtimeKeyValidator),
  api: v.array(apiKeyValidator),
  writable: v.array(v.object({ _id: v.id("stages"), name: v.string() })),
});

type OrgKeys = Infer<typeof orgKeysValidator>;
type ProjectKeys = Infer<typeof projectKeysValidator>;

export const listForOrg = query({
  args: {},
  returns: v.union(orgKeysValidator, v.null()),
  handler: async (ctx): Promise<OrgKeys | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) return null;
    const user = await userByAuthId(ctx, authUser.id);
    if (!user) return null;
    const org = await getActiveOrgForUser(ctx, user._id);
    if (
      !org ||
      !(await hasDashboardPermission(ctx, org._id, user, "keys:read"))
    ) {
      return null;
    }
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
      .unique();
    const stages = await orgStages(ctx, org._id);
    if (!account) return { keys: [], stages: stages };
    const scoped = await ctx.db
      .query("accountApiKeys")
      .withIndex("by_accountId", (q) => q.eq("accountId", account._id))
      .collect();
    const people = await actorsOf(
      ctx,
      scoped.map((key) => key.createdBy),
    );

    return {
      keys: [
        {
          name: "Account key",
          description: "The account API: projects, stages, members",
          keyHint: account.secretHint,
          createdAt: account.secretRotatedAt ?? account.createdAt,
          createdBy: await actorOf(ctx, account.secretRotatedBy),
        },
        ...scoped.map((key) => ({
          _id: key._id,
          name: key.name,
          description: key.description,
          keyHint: key.keyHint,
          actions: grantedActions(key.policy),
          projectId: key.projectId,
          stageId: key.stageId,
          expiresAt: key.expiresAt,
          lastUsedAt: key.lastUsedAt,
          createdAt: key.createdAt,
          createdBy: key.createdBy ? people.get(key.createdBy) : undefined,
        })),
      ],
      stages: stages,
    };
  },
});

export const listForProject = query({
  args: { projectId: v.id("projects") },
  returns: v.union(projectKeysValidator, v.null()),
  handler: async (ctx, args): Promise<ProjectKeys | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) return null;
    const [project, user] = await Promise.all([
      getProjectForRole(ctx, authUser.id, args.projectId),
      userByAuthId(ctx, authUser.id),
    ]);
    if (!project || !user) return null;
    const access = await memberAccess(ctx, project.orgId, user);
    if (!access) return null;
    const stages = (
      await ctx.db
        .query("stages")
        .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
        .collect()
    ).filter((stage) =>
      policiesAllowOrTier(access, "keys:read", {
        projectId: args.projectId,
        stageId: stage._id,
      }),
    );
    if (stages.length === 0) return null;
    const writable = stages
      .filter((stage) =>
        policiesAllowOrTier(access, "keys:write", {
          projectId: args.projectId,
          stageId: stage._id,
        }),
      )
      .map((stage) => ({ _id: stage._id, name: stage.name }));
    const perStage = await Promise.all(
      stages.map((stage) => stageKeys(ctx, stage)),
    );
    const people = await actorsOf(
      ctx,
      perStage.flatMap(({ deployment, keys }) => [
        deployment?.createdByUserId,
        ...keys.map((key) => key.createdBy),
      ]),
    );

    const runtime: ProjectKeys["runtime"] = [];
    const api: ProjectKeys["api"] = [];
    for (const [index, stage] of stages.entries()) {
      const { deployment, keys } = perStage[index];
      if (deployment) {
        runtime.push({
          stageId: stage._id,
          stageName: stage.name,
          keyHint: deployment.keyHint,
          lastUsedAt: deployment.lastUsedAt,
          rotatedAt: deployment.createdAt,
          rotatedBy:
            (deployment.createdByUserId &&
              people.get(deployment.createdByUserId)) ||
            (deployment.createdBy ? { name: deployment.createdBy } : undefined),
        });
      }
      for (const key of keys) {
        api.push({
          _id: key._id,
          name: key.name,
          description: key.description,
          stageId: stage._id,
          stageName: stage.name,
          keyHint: key.keyHint,
          lastUsedAt: key.lastUsedAt,
          createdAt: key.createdAt,
          createdBy: key.createdBy ? people.get(key.createdBy) : undefined,
        });
      }
    }

    return { runtime: runtime, api: api, writable: writable };
  },
});

function grantedActions(policy: PolicyDocument): ApiPolicyAction[] {
  const granted = new Set(
    policy.rules
      .filter((rule) => rule.effect === "allow")
      .flatMap((rule) => rule.actions),
  );

  return API_POLICY_ACTIONS.filter((action) => granted.has(action));
}

async function orgStages(
  ctx: QueryCtx,
  orgId: Id<"orgs">,
): Promise<OrgKeys["stages"]> {
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId))
    .collect();
  const perProject = await Promise.all(
    projects.map(async (project) => {
      const stages = await ctx.db
        .query("stages")
        .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
        .collect();

      return stages.map((stage) => ({
        projectId: project._id,
        projectName: project.name,
        stageId: stage._id,
        stageName: stage.name,
      }));
    }),
  );

  return perProject
    .flat()
    .sort(
      (a, b) =>
        a.projectName.localeCompare(b.projectName) ||
        a.stageName.localeCompare(b.stageName),
    );
}

async function stageKeys(
  ctx: QueryCtx,
  stage: Doc<"stages">,
): Promise<{
  deployment: Doc<"agentDeployments"> | null;
  keys: Doc<"deployKeys">[];
}> {
  const [deployment, keys] = await Promise.all([
    ctx.db
      .query("agentDeployments")
      .withIndex("by_projectId_and_stageId_and_status", (q) =>
        q
          .eq("projectId", stage.projectId)
          .eq("stageId", stage._id)
          .eq("status", "active"),
      )
      .first(),
    ctx.db
      .query("deployKeys")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", stage.projectId).eq("stageId", stage._id),
      )
      .collect(),
  ]);

  return {
    deployment: deployment,
    keys: keys.filter((key) => key.status === "active"),
  };
}
