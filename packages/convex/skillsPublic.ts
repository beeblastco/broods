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
import type { Doc } from "./_generated/dataModel";
import { authKit } from "./auth";
import { createJsonSkillFiles, createOrReplaceSkill, fetchGitHubSkillFiles, getSkill, readSkillFileBytes } from "./model/skills";

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
async function requireAccountForToken(ctx: ActionCtx, bearerToken: string): Promise<Doc<"accounts">> {
    const account = await ctx.runQuery(internal.accounts.getBySecretHash, {
        secretHash: hashToken(bearerToken),
    });
    if (!account) throw new Error("Invalid Bearer token.");

    return account;
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
        bearerToken: v.string(),
    },
    handler: async (ctx, args) => {
        const { projectId, nodeId, bearerToken } = args;

        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const account = await requireAccountForToken(ctx, bearerToken);

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

        const skill = await createOrReplaceSkill(account._id, skillFiles);

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
        bearerToken: v.string(),
        githubUrl: v.string(),
    },
    handler: async (ctx, args) => {
        const { bearerToken, githubUrl } = args;

        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const account = await requireAccountForToken(ctx, bearerToken);
        const files = await fetchGitHubSkillFiles(githubUrl);
        const skill = await createOrReplaceSkill(account._id, files);

        return { name: skill.name, path: skill.path, description: skill.description };
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
        bearerToken: v.string(),
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

        const account = await requireAccountForToken(ctx, bearerToken);
        const skill = await createOrReplaceSkill(account._id, createJsonSkillFiles(name, description, content));

        return { name: skill.name, path: skill.path, description: skill.description };
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
        bearerToken: v.string(),
    },
    handler: async (ctx, args) => {
        const { projectId, nodeId, skillName, bearerToken } = args;

        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const account = await requireAccountForToken(ctx, bearerToken);

        const project = await ctx.runQuery(api.project.getById, { projectId: projectId });
        if (!project) {
            throw new Error("Project not found.");
        }

        const skill = await getSkill(account._id, skillName);
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
            const uploadUrl = await ctx.runMutation(api.workspaceFiles.generateUploadUrl, {});
            const content = Buffer.from(await readSkillFileBytes(skill.path, file.path));

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

        return { name: skill.name, description: skill.description, fileCount: skill.files.length };
    },
});
