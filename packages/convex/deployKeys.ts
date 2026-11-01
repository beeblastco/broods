/**
 * Project + stage scoped project keys (`bpdk_…`) for the `broods` CLI. Unlike
 * the account key (Settings → API Access), a project key authorizes only one
 * project/stage. The plaintext token is returned once at creation; only its
 * SHA-256 hash is stored.
 */

import { type Infer, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { authKit } from "./auth";
import { requireDashboardPermission } from "./model/access";
import {
  keyHint,
  PROJECT_KEY_PREFIX,
  randomToken,
  sha256Hex,
} from "./model/accountSecrets";
import { userByAuthId } from "./model/ownership/org";
import { getOwnedStage } from "./model/ownership/stage";
import { getProjectForWrite } from "./model/ownership/project";
import { deployKeysFields } from "./schema";

// What `list` sends to the browser: the row minus `keyHash`.
const { keyHash: _keyHash, ...deployKeyListFields } = deployKeysFields;
const deployKeyListItem = v.object({
  ...deployKeyListFields,
  _id: v.id("deployKeys"),
  _creationTime: v.number(),
});

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
    name: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.object({
    _id: v.id("deployKeys"),
    token: v.string(),
    keyHint: v.string(),
  }),
  handler: async (
    ctx,
    { projectId, stageId, name, description },
  ): Promise<{ _id: Id<"deployKeys">; token: string; keyHint: string }> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const project = await getProjectForWrite(ctx, user.id, projectId);
    if (!project) throw new Error("Project not found.");

    const stage = await getOwnedStage(ctx, user.id, stageId);
    if (!stage || stage.projectId !== projectId) {
      throw new Error("Stage not found.");
    }
    const member = await userByAuthId(ctx, user.id);
    if (!member) throw new Error("User row not found");
    await requireDashboardPermission(ctx, project.orgId, member, "keys:write", {
      projectId: projectId,
      stageId: stageId,
    });

    return await insertDeployKey(ctx, {
      orgId: project.orgId,
      projectId: projectId,
      stageId: stageId,
      name: name,
      description: description,
      createdBy: member._id,
    });
  },
});

export const list = query({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: v.array(deployKeyListItem),
  handler: async (
    ctx,
    { projectId, stageId },
  ): Promise<Infer<typeof deployKeyListItem>[]> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    // Return empty rather than throwing so a just-deleted stage doesn't
    // crash reactive subscribers before they unmount.
    const stage = await getOwnedStage(ctx, user.id, stageId);
    if (!stage || stage.projectId !== projectId) {
      return [];
    }

    const keys = await ctx.db
      .query("deployKeys")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", projectId).eq("stageId", stageId),
      )
      .collect();

    return keys.map(({ keyHash: _hash, ...key }) => key);
  },
});

export const remove = mutation({
  args: { deployKeyId: v.id("deployKeys") },
  returns: v.id("deployKeys"),
  handler: async (ctx, { deployKeyId }): Promise<Id<"deployKeys">> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const deployKey = await ctx.db.get(deployKeyId);
    if (!deployKey) throw new Error("Project key not found.");

    const project = await getProjectForWrite(ctx, user.id, deployKey.projectId);
    if (!project) throw new Error("Project key not found.");
    const stage = await getOwnedStage(ctx, user.id, deployKey.stageId);
    if (!stage || stage.projectId !== deployKey.projectId)
      throw new Error("Project key not found.");
    const member = await userByAuthId(ctx, user.id);
    if (!member) throw new Error("User row not found");
    await requireDashboardPermission(ctx, project.orgId, member, "keys:write", {
      projectId: deployKey.projectId,
      stageId: deployKey.stageId,
    });

    await ctx.db.delete(deployKeyId);

    return deployKeyId;
  },
});

/**
 * Mints a project key for one stage and answers its plaintext, shown once.
 * Used by `create` and by a GitHub repo link, which seals it into a repo secret.
 */
export async function insertDeployKey(
  ctx: MutationCtx,
  key: {
    orgId: Id<"orgs">;
    projectId: Id<"projects">;
    stageId: Id<"stages">;
    name: string;
    description?: string;
    createdBy: Id<"users">;
  },
): Promise<{ _id: Id<"deployKeys">; token: string; keyHint: string }> {
  // A project key resolves to the project's org account, so that account must
  // already be provisioned (Settings → API Access).
  const account = await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", key.orgId))
    .unique();
  if (!account) {
    throw new Error(
      "Provision your organization's API account first (Settings → API Access).",
    );
  }

  const token = randomToken(PROJECT_KEY_PREFIX);
  const now = Date.now();
  const _id = await ctx.db.insert("deployKeys", {
    accountId: account._id,
    projectId: key.projectId,
    stageId: key.stageId,
    name: key.name.trim() || "API key",
    description: key.description?.trim() || undefined,
    keyHash: await sha256Hex(token),
    keyHint: keyHint(PROJECT_KEY_PREFIX, token),
    status: "active",
    createdBy: key.createdBy,
    createdAt: now,
    updatedAt: now,
  });

  return {
    _id: _id,
    token: token,
    keyHint: keyHint(PROJECT_KEY_PREFIX, token),
  };
}
