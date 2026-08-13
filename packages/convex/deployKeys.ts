/**
 * Project + stage scoped deploy keys for the `broods` CLI. Unlike the org
 * Bearer secret (Settings → API Access), a deploy key authorizes only one
 * project/stage. The plaintext token is returned once at creation; only its
 * SHA-256 hash is stored.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { getOwnedStage } from "./model/ownership/stage";
import { getProjectForRole } from "./model/ownership/project";
import { deployKeysFields } from "./schema";

const DEPLOY_KEY_PREFIX = "fp_deploy_";

const deployKeyDoc = v.object({
  ...deployKeysFields,
  _id: v.id("deployKeys"),
  _creationTime: v.number(),
});

/**
 * SHA-256 hex digest matching the org-secret hashing in cliHttp/orgLifecycle, so
 * the same `by_keyHash`/`by_secretHash` lookups work in `resolveCliAuth`.
 * @param value plaintext token
 * @returns lowercase hex digest
 */
async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Generate a random `fp_deploy_<base64url>` token. */
function generateDeployToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64url = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${DEPLOY_KEY_PREFIX}${base64url}`;
}

/** Masked label for listing a key without revealing it: prefix + last four chars. */
function deployKeyHint(token: string): string {
  return `${DEPLOY_KEY_PREFIX}…${token.slice(-4)}`;
}

export const list = query({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: v.array(deployKeyDoc),
  handler: async (ctx, { projectId, stageId }) => {
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

    return ctx.db
      .query("deployKeys")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", projectId).eq("stageId", stageId),
      )
      .collect();
  },
});

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
    name: v.string(),
  },
  returns: v.object({
    _id: v.id("deployKeys"),
    token: v.string(),
    keyHint: v.string(),
  }),
  handler: async (ctx, { projectId, stageId, name }) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const project = await getProjectForRole(ctx, user.id, projectId, "admin");
    if (!project) throw new Error("Project not found.");
    if (!project.orgId) {
      throw new Error("Project is not linked to an organization.");
    }

    const stage = await getOwnedStage(ctx, user.id, stageId);
    if (!stage || stage.projectId !== projectId) {
      throw new Error("Stage not found.");
    }

    // A deploy key resolves to the project's org account, so that account must
    // already be provisioned (Settings → API Access).
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId!))
      .unique();
    if (!account) {
      throw new Error(
        "Provision your organization's API account first (Settings → API Access).",
      );
    }

    const token = generateDeployToken();
    const keyHash = await sha256Hex(token);
    const now = Date.now();
    const _id = await ctx.db.insert("deployKeys", {
      accountId: account._id,
      projectId: projectId,
      stageId: stageId,
      name: name.trim() || "Deploy key",
      keyHash: keyHash,
      keyHint: deployKeyHint(token),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    return { _id: _id, token: token, keyHint: deployKeyHint(token) };
  },
});

export const remove = mutation({
  args: { deployKeyId: v.id("deployKeys") },
  returns: v.id("deployKeys"),
  handler: async (ctx, { deployKeyId }) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const deployKey = await ctx.db.get(deployKeyId);
    if (!deployKey) throw new Error("Deploy key not found.");

    const project = await getProjectForRole(
      ctx,
      user.id,
      deployKey.projectId,
      "admin",
    );
    if (!project) throw new Error("Deploy key not found.");
    const stage = await getOwnedStage(ctx, user.id, deployKey.stageId);
    if (!stage || stage.projectId !== deployKey.projectId)
      throw new Error("Deploy key not found.");

    await ctx.db.delete(deployKeyId);

    return deployKeyId;
  },
});
