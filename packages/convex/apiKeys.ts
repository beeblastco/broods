/**
 * The key lists the dashboard draws: the org's own keys on Organization ›
 * API access, and a project's runtime keys (one per stage, minted with it)
 * and API keys (made by people, for deploys and integrations) on Project ›
 * Settings › Keys. One read model over the three stores so every list reads
 * the same: who made the key, when, and when it last authenticated. Needs
 * `keys:read` where the key lives; otherwise null and the page shows a lock.
 */

import { v, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { authKit } from "./auth";
import {
  hasDashboardPermission,
  memberAccess,
  policiesAllow,
  tierPermissions,
} from "./model/access";
import { actorOf, actorsOf, actorValidator } from "./model/actor";
import { orgIdOf, userByAuthId } from "./model/ownership/org";
import { getProjectForRole } from "./model/ownership/project";
import { getActiveCaller } from "./org/orgs";

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
});

type OrgKey = Infer<typeof orgKeyValidator>;
type ProjectKeys = Infer<typeof projectKeysValidator>;

/** The org's own keys. Today that is the account key; null without `keys:read`. */
export const listForOrg = query({
  args: {},
  returns: v.union(v.array(orgKeyValidator), v.null()),
  handler: async (ctx): Promise<OrgKey[] | null> => {
    const caller = await getActiveCaller(ctx);
    if (!caller) return null;
    const orgId = orgIdOf(ctx, caller.account);
    if (
      !orgId ||
      !(await hasDashboardPermission(ctx, orgId, caller.user, "keys:read"))
    ) {
      return null;
    }
    const account = caller.account;

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
    const stages = (
      await ctx.db
        .query("stages")
        .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
        .collect()
    ).filter(
      (stage) =>
        tierPermissions(access.tier).includes("keys:read") ||
        policiesAllow(access.policies, "keys:read", {
          projectId: args.projectId,
          stageId: stage._id,
        }),
    );
    if (stages.length === 0) return null;
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

    return { runtime: runtime, api: api };
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
