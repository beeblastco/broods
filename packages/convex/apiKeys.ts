/**
 * The key lists the dashboard draws: the org's own keys on Organization ›
 * API access, and a project's runtime keys (one per stage, minted with it)
 * and API keys (made by people, for deploys and integrations) on Project ›
 * Settings › Keys. One read model over the three stores so every list reads
 * the same: who made the key, when, and when it last authenticated. Admins
 * only; a member gets null and the page shows a lock.
 */

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { authKit } from "./auth";
import { getProjectForRole } from "./model/ownership/project";
import { getActiveCaller } from "./org/orgs";
import { listStagesForProject } from "./stage";

/** Who made or rotated a key, resolved to a name and avatar for the list. */
const actorValidator = v.object({
  name: v.string(),
  avatarUrl: v.optional(v.string()),
});

const orgKeyValidator = v.object({
  kind: v.literal("account"),
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
  /** The member who minted or rotated it; absent when the CLI did. */
  rotatedBy: v.optional(actorValidator),
  /** The CLI's display name for the minter, when no member row is known. */
  rotatedByName: v.optional(v.string()),
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

export type OrgKey = Infer<typeof orgKeyValidator>;
export type ProjectKeys = Infer<typeof projectKeysValidator>;

/** The org's own keys. Today that is the account key; null for a member. */
export const listForOrg = query({
  args: {},
  returns: v.union(v.array(orgKeyValidator), v.null()),
  handler: async (ctx): Promise<OrgKey[] | null> => {
    const caller = await getActiveCaller(ctx, "admin");
    if (!caller) return null;
    const account = caller.account;

    return [
      {
        kind: "account",
        name: "Account key",
        description: "The account API: projects, stages, members",
        keyHint: account.secretHint,
        createdAt: account.secretRotatedAt ?? account.createdAt,
        createdBy: await actorOf(ctx, account.secretRotatedBy),
      },
    ];
  },
});

/** A project's runtime keys per stage and its API keys; null for a member. */
export const listForProject = query({
  args: { projectId: v.id("projects") },
  returns: v.union(projectKeysValidator, v.null()),
  handler: async (ctx, args): Promise<ProjectKeys | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) return null;
    const project = await getProjectForRole(
      ctx,
      authUser.id,
      args.projectId,
      "admin",
    );
    if (!project) return null;
    const stages = await listStagesForProject(ctx, authUser.id, args.projectId);

    const runtime: ProjectKeys["runtime"] = [];
    const api: ProjectKeys["api"] = [];
    for (const stage of stages) {
      const deployment = await ctx.db
        .query("agentDeployments")
        .withIndex("by_projectId_and_stageId_and_status", (q) =>
          q
            .eq("projectId", args.projectId)
            .eq("stageId", stage._id)
            .eq("status", "active"),
        )
        .first();
      if (deployment) {
        runtime.push({
          stageId: stage._id,
          stageName: stage.name,
          keyHint: deployment.keyHint,
          lastUsedAt: deployment.lastUsedAt,
          rotatedAt: deployment.createdAt,
          rotatedBy: await actorOf(ctx, deployment.createdByUserId),
          rotatedByName: deployment.createdBy,
        });
      }
      const keys = await ctx.db
        .query("deployKeys")
        .withIndex("by_projectId_and_stageId", (q) =>
          q.eq("projectId", args.projectId).eq("stageId", stage._id),
        )
        .collect();
      for (const key of keys) {
        if (key.status !== "active") continue;
        api.push({
          _id: key._id,
          name: key.name,
          description: key.description,
          stageId: stage._id,
          stageName: stage.name,
          keyHint: key.keyHint,
          lastUsedAt: key.lastUsedAt,
          createdAt: key.createdAt,
          createdBy: await actorOf(ctx, key.createdBy),
        });
      }
    }

    return { runtime: runtime, api: api };
  },
});

/** A user id as the name and avatar a list draws; undefined when unknown. */
async function actorOf(
  ctx: QueryCtx,
  userId: Id<"users"> | undefined,
): Promise<Infer<typeof actorValidator> | undefined> {
  if (!userId) return undefined;
  const user: Doc<"users"> | null = await ctx.db.get(userId);

  return user ? { name: user.name, avatarUrl: user.avatarUrl } : undefined;
}
