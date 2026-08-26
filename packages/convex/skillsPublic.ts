"use node";
/**
 * Public skill actions for the Convex config plane: publish, create, and
 * import skill bundles directly against S3 (epic #85 phase 9 — no core proxy).
 * Runs in Node.js runtime for Buffer / crypto / S3 access.
 * The caller supplies their account Bearer token; each action hashes it to
 * resolve and verify the owning account before touching that account's skills.
 */

import { createHash } from "node:crypto";
import { v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { authKit } from "./auth";
import {
  createJsonSkillFiles,
  createOrReplaceSkill,
  deleteSkill,
  fetchGitHubSkillFiles,
  getSkill,
  listAccountSkills,
  readSkillFileBytes,
} from "./model/skills";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 30 * 1024 * 1024;

/** SHA-256 hex of the raw token — matches what the accounts table stores. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Resolve the account a Bearer token belongs to.
 * @param ctx action context for the lookup query
 * @param bearerToken the caller's broods account Bearer token
 * @returns the matching account document
 * @throws when the token matches no account
 */
async function requireAccountForToken(
  ctx: ActionCtx,
  bearerToken: string,
): Promise<Doc<"accounts">> {
  const account = await ctx.runQuery(internal.accounts.getBySecretHash, {
    secretHash: hashToken(bearerToken),
  });
  if (!account) throw new Error("Invalid Bearer token.");

  return account;
}

/**
 * Resolve the acting account: a supplied Bearer token wins (CLI/REST parity),
 * otherwise the signed-in user's active workspace account. The dashboard
 * passes no token any more — it must never hold the account secret in the
 * browser (ticket 17's auth fix).
 */
async function resolveActingAccountId(
  ctx: ActionCtx,
  bearerToken: string | undefined,
): Promise<Id<"accounts">> {
  if (bearerToken) {
    const account = await requireAccountForToken(ctx, bearerToken);

    return account._id;
  }
  const active = await ctx.runQuery(api.org.getActiveAccount, {});
  if (!active) {
    throw new Error("No active workspace for this user.");
  }

  return active.accountId;
}

/**
 * Package all workspaceFiles for a skill node and publish them to S3.
 * @param projectId owning project
 * @param nodeId canvas skill node ID
 * @param bearerToken the caller's broods account Bearer token
 * @returns published skill metadata (name, description, path, sizeBytes)
 */
export const publishSkill = action({
  args: {
    projectId: v.id("projects"),
    nodeId: v.string(),
    bearerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { projectId, nodeId, bearerToken } = args;

    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const accountId = await resolveActingAccountId(ctx, bearerToken);

    // Load the file list
    const files = await ctx.runQuery(api.workspaceFiles.list, {
      projectId: projectId,
      nodeId: nodeId,
    });

    const fileItems = files.filter((f) => !f.isFolder && f.storageId);
    if (!fileItems.length) throw new Error("No files to publish.");

    const hasSkillMd = fileItems.some(
      (f) => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md"),
    );
    if (!hasSkillMd) {
      throw new Error("SKILL.md is required at the root of the skill bundle.");
    }

    // Download each file from Convex storage
    const skillFiles: Array<{ path: string; bytes: Uint8Array }> = [];
    let totalBytes = 0;

    for (const file of fileItems) {
      const url = await ctx.storage.getUrl(file.storageId!);
      if (!url) throw new Error(`Storage URL not found for: ${file.path}`);

      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to download file: ${file.path}`);

      const buffer = await res.arrayBuffer();
      const bytes = buffer.byteLength;

      if (bytes > MAX_FILE_BYTES) {
        throw new Error(`${file.path} exceeds the 5 MB per-file limit.`);
      }
      totalBytes += bytes;
      if (totalBytes > MAX_BUNDLE_BYTES) {
        throw new Error("Total bundle size exceeds the 30 MB limit.");
      }

      skillFiles.push({
        path: file.path,
        bytes: new Uint8Array(buffer),
      });
    }

    const skill = await createOrReplaceSkill(accountId, skillFiles);

    return {
      name: skill.name,
      description: skill.description,
      path: skill.path,
      sizeBytes: totalBytes,
    };
  },
});

/**
 * Create a skill directly from a GitHub repository URL: download and extract
 * the tarball, then store the bundle in S3.
 * @param bearerToken the caller's broods account Bearer token
 * @param githubUrl GitHub tree URL (https://github.com/{owner}/{repo}/tree/{ref}/{path})
 * @returns created skill metadata including the path to use as skill reference
 */
export const createFromGithub = action({
  args: {
    bearerToken: v.optional(v.string()),
    githubUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const { bearerToken, githubUrl } = args;

    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const accountId = await resolveActingAccountId(ctx, bearerToken);
    const files = await fetchGitHubSkillFiles(githubUrl);
    const skill = await createOrReplaceSkill(accountId, files);

    return {
      name: skill.name,
      path: skill.path,
      description: skill.description,
    };
  },
});

/**
 * Create a simple skill from name, description, and markdown content by
 * generating its SKILL.md and storing it in S3.
 * @param bearerToken the caller's broods account Bearer token
 * @param name skill name (lowercase letters, numbers, hyphens, max 64 chars)
 * @param description short description (max 1024 chars)
 * @param content markdown skill instructions
 * @returns created skill metadata including the path to use as skill reference
 */
export const createFromJson = action({
  args: {
    bearerToken: v.optional(v.string()),
    name: v.string(),
    description: v.string(),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const { bearerToken, name, description, content } = args;

    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const accountId = await resolveActingAccountId(ctx, bearerToken);
    const skill = await createOrReplaceSkill(
      accountId,
      createJsonSkillFiles(name, description, content),
    );

    return {
      name: skill.name,
      path: skill.path,
      description: skill.description,
    };
  },
});

/**
 * Import an existing skill from S3 and store its files in workspaceFiles.
 * Existing files for this nodeId are cleared before import.
 * @param projectId owning project
 * @param nodeId canvas skill node ID
 * @param skillName the broods skill name (without accountId prefix)
 * @param bearerToken the caller's broods account Bearer token
 * @returns imported skill metadata
 */
export const importSkill = action({
  args: {
    projectId: v.id("projects"),
    nodeId: v.string(),
    skillName: v.string(),
    bearerToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { projectId, nodeId, skillName, bearerToken } = args;

    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const accountId = await resolveActingAccountId(ctx, bearerToken);

    const project = await ctx.runQuery(api.project.getById, {
      projectId: projectId,
    });
    if (!project) {
      throw new Error("Project not found.");
    }

    const skill = await getSkill(accountId, skillName);
    if (!skill) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    // Clear existing files for this node before importing
    await ctx.runMutation(internal.workspaceFiles.clearNodeInternal, {
      projectId: projectId,
      nodeId: nodeId,
    });

    // Upload each file to Convex storage and create workspaceFiles entries
    for (const file of skill.files) {
      const uploadUrl = await ctx.runMutation(
        api.workspaceFiles.generateUploadUrl,
        {},
      );
      const content = Buffer.from(
        await readSkillFileBytes(skill.path, file.path),
      );

      const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: content,
      });
      if (!uploadRes.ok) {
        throw new Error(`Failed to store file: ${file.path}`);
      }

      const { storageId } = (await uploadRes.json()) as { storageId: string };
      const parts = file.path.split("/");
      const name = parts[parts.length - 1];

      await ctx.runMutation(api.workspaceFiles.create, {
        projectId: projectId,
        nodeId: nodeId,
        path: file.path,
        name: name,
        isFolder: false,
        storageId: storageId as never,
        mimeType: "text/plain",
        sizeBytes: content.byteLength,
      });
    }

    return {
      name: skill.name,
      description: skill.description,
      fileCount: skill.files.length,
    };
  },
});

/**
 * The account's skill library, straight from the real store (S3) — the
 * `skills` table has no writers and stays empty, so listing it would lie.
 */
export const listLibrary = action({
  args: {},
  returns: v.array(
    v.object({
      name: v.string(),
      description: v.optional(v.string()),
      path: v.string(),
    }),
  ),
  handler: async (ctx) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const accountId = await resolveActingAccountId(ctx, undefined);
    const skills = await listAccountSkills(accountId);

    return skills.map((skill) => ({
      name: skill.name,
      ...(skill.description !== undefined
        ? { description: skill.description }
        : {}),
      path: skill.path,
    }));
  },
});

/** One skill's full detail: metadata, file manifest, and SKILL.md text. */
export const getSkillDetail = action({
  args: { name: v.string() },
  returns: v.union(
    v.object({
      name: v.string(),
      description: v.optional(v.string()),
      path: v.string(),
      files: v.array(
        v.object({ path: v.string(), size: v.optional(v.number()) }),
      ),
      skillMd: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const accountId = await resolveActingAccountId(ctx, undefined);
    const skill = await getSkill(accountId, args.name);
    if (!skill) return null;
    const skillMdBytes = await readSkillFileBytes(skill.path, "SKILL.md");

    return {
      name: skill.name,
      ...(skill.description !== undefined
        ? { description: skill.description }
        : {}),
      path: skill.path,
      files: skill.files.map((file) => ({
        path: file.path,
        ...(file.size !== undefined ? { size: file.size } : {}),
      })),
      skillMd: new TextDecoder().decode(skillMdBytes),
    };
  },
});

/**
 * Replace a skill's SKILL.md in place. The new markdown must keep the same
 * frontmatter name — renames go through `renameSkill` so the old prefix is
 * cleaned up.
 */
export const updateSkillMd = action({
  args: { name: v.string(), content: v.string() },
  returns: v.object({ name: v.string(), path: v.string() }),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const accountId = await resolveActingAccountId(ctx, undefined);
    const existing = await getSkill(accountId, args.name);
    if (!existing) throw new Error(`Skill not found: ${args.name}`);

    const files = await Promise.all(
      existing.files.map(async (file) => ({
        path: file.path,
        bytes:
          file.path === "SKILL.md"
            ? new TextEncoder().encode(args.content)
            : await readSkillFileBytes(existing.path, file.path),
      })),
    );
    const updated = await createOrReplaceSkill(accountId, files);
    if (updated.name !== args.name) {
      // The frontmatter name changed under us: the bundle landed at the new
      // name. Remove the old prefix so no orphan skill is left behind.
      await deleteSkill(accountId, args.name);
    }

    return { name: updated.name, path: updated.path };
  },
});

/** Rename a skill: rewrite the SKILL.md frontmatter, move all files, delete the old prefix. */
export const renameSkill = action({
  args: { name: v.string(), newName: v.string() },
  returns: v.object({ name: v.string(), path: v.string() }),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const accountId = await resolveActingAccountId(ctx, undefined);
    if (args.newName === args.name) {
      const unchanged = await getSkill(accountId, args.name);
      if (!unchanged) throw new Error(`Skill not found: ${args.name}`);

      return { name: unchanged.name, path: unchanged.path };
    }
    const existing = await getSkill(accountId, args.name);
    if (!existing) throw new Error(`Skill not found: ${args.name}`);
    const clash = await getSkill(accountId, args.newName);
    if (clash) throw new Error(`A skill named ${args.newName} already exists.`);

    const files = await Promise.all(
      existing.files.map(async (file) => {
        const bytes = await readSkillFileBytes(existing.path, file.path);
        if (file.path !== "SKILL.md") return { path: file.path, bytes: bytes };
        const markdown = new TextDecoder()
          .decode(bytes)
          .replace(/^name:\s*.*$/m, `name: ${args.newName}`);

        return {
          path: file.path,
          bytes: new TextEncoder().encode(markdown),
        };
      }),
    );
    const renamed = await createOrReplaceSkill(accountId, files);
    if (renamed.name !== args.newName) {
      // Frontmatter rewrite failed to take — roll the new copy back.
      await deleteSkill(accountId, renamed.name);
      throw new Error(
        "Rename failed: SKILL.md frontmatter could not be rewritten.",
      );
    }
    await deleteSkill(accountId, args.name);

    return { name: renamed.name, path: renamed.path };
  },
});

/** Delete a skill from the library (S3 prefix removal). */
export const deleteSkillByName = action({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const accountId = await resolveActingAccountId(ctx, undefined);
    await deleteSkill(accountId, args.name);

    return null;
  },
});
