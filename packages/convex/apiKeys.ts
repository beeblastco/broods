/**
 * The key lists the dashboard draws: the org's own keys on Organization ›
 * API access, and a project's runtime keys (one per stage, minted with it)
 * and API keys (made by people, for deploys and integrations) on Project ›
 * Settings › Keys. One read model over the three stores so every list reads
 * the same: who made the key, when, and when it last authenticated. Needs
 * `keys:read` where the key lives; otherwise null and the page shows a lock.
 */

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { authKit } from "./auth";
import {
  hasDashboardPermission,
  memberAccess,
  policiesAllowOrTier,
} from "./model/access";
import { actorOf, actorsOf, actorValidator } from "./model/actor";
import { getActiveOrgForUser, userByAuthId } from "./model/ownership/org";
import { getProjectForRole } from "./model/ownership/project";

const orgKeyValidator = v.object({
  name: v.string(),
  description: v.string(),
  keyHint: v.optional(v.string()),
  createdAt: v.number(),
  createdBy: v.optional(actorValidator),
});

const runtimeKeyValidator = v.object({
  stageId: v.id("stages"),
  stageName: v.string(),
  keyHint: v.string(),
  lastUsedAt: v.optional(v.number()),
  rotatedAt: v.optional(v.number()),
  /** The member who minted or rotated it, or the CLI's name for them. */
  rotatedBy: v.optional(actorValidator),
  /** Whether the viewer may rotate it: `keys:write` on this stage. */
  canWrite: v.boolean(),
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
  /** Whether the viewer may revoke it: `keys:write` on its stage. */
  canWrite: v.boolean(),
});

const projectKeysValidator = v.object({
  runtime: v.array(runtimeKeyValidator),
  api: v.array(apiKeyValidator),
  /** The stages the viewer may make keys on. Each stage answers for itself. */
  writable: v.array(v.id("stages")),
});

type OrgKey = Infer<typeof orgKeyValidator>;
type ProjectKeys = Infer<typeof projectKeysValidator>;

/** The org's own keys: the account key, or an empty list before the org has an account. Null without `keys:read`. */
export const listForOrg = query({
  args: {},
  returns: v.union(v.array(orgKeyValidator), v.null()),
  handler: async (ctx): Promise<OrgKey[] | null> => {
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
    if (!account) return [];

    return [
      {
        name: "Account key",
        description: "The account API: projects, stages, members",
        keyHint: account.secretHint,
        createdAt: account.secretRotatedAt ?? account.createdAt,
        createdBy: await actorOf(ctx, account.secretRotatedBy),
      },
    ];
  },
});

/** A project's runtime keys per stage and its API keys, each stage the viewer may read; null without `keys:read` anywhere in it. */
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
    const allows = (
      action: "keys:read" | "keys:write",
      stageId: Id<"stages">,
    ): boolean =>
      policiesAllowOrTier(access, action, {
        projectId: args.projectId,
        stageId: stageId,
      });
    const stages = (
      await ctx.db
        .query("stages")
        .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
        .collect()
    ).filter((stage) => allows("keys:read", stage._id));
    if (stages.length === 0) return null;
    const writable = stages
      .filter((stage) => allows("keys:write", stage._id))
      .map((stage) => stage._id);
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
          canWrite: writable.includes(stage._id),
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
          canWrite: writable.includes(stage._id),
        });
      }
    }

    return { runtime: runtime, api: api, writable: writable };
  },
});

/** One stage's active runtime deployment and active API keys. */
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
