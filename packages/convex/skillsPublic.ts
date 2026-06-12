"use node";
/**
 * Public skill actions that call the filthy-panty account-manage API.
 * Runs in Node.js runtime for Buffer / crypto access.
 * The caller supplies their account Bearer token; this action hashes it to
 * verify ownership before forwarding files to filthy-panty.
 */

import { createHash } from "node:crypto";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { authKit } from "./auth";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 30 * 1024 * 1024;

function accountManageUrl(): string {
    const url = process.env.FILTHY_PANTY_ACCOUNT_MANAGE_URL;
    if (!url) throw new Error("FILTHY_PANTY_ACCOUNT_MANAGE_URL is not configured");
    return url.replace(/\/$/, "");
}

/** SHA-256 hex of the raw token — matches what the accounts table stores. */
function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/**
 * Package all workspaceFiles for a skill node and publish them to filthy-panty.
 * @param projectId owning project
 * @param nodeId canvas skill node ID
 * @param bearerToken the caller's filthy-panty account Bearer token
 * @returns published skill metadata (name, description, sizeBytes)
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

        // Verify the token belongs to an account owned by this user's org
        const secretHash = hashToken(bearerToken);
        const account = await ctx.runQuery(internal.accounts.getBySecretHash, {
            secretHash: secretHash,
        });
        if (!account) throw new Error("Invalid Bearer token.");

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

        // Download and base64-encode each file from Convex storage
        const skillFiles: Array<{ path: string; contentBase64: string }> = [];
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
                contentBase64: Buffer.from(buffer).toString("base64"),
            });
        }

        // POST to filthy-panty
        const response = await fetch(`${accountManageUrl()}/accounts/me/skills`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${bearerToken}`,
            },
            body: JSON.stringify({ source: "files", files: skillFiles }),
        });

        if (!response.ok) {
            const msg = await response.text().catch(() => response.statusText);
            throw new Error(`Publish failed (${response.status}): ${msg}`);
        }

        const result = (await response.json()) as {
            name: string;
            description?: string;
            sizeBytes?: number;
        };

        return result;
    },
});

/**
 * Create a skill in filthy-panty directly from a GitHub repository URL.
 * filthy-panty fetches and extracts the repository; no local file management needed.
 * @param bearerToken the caller's filthy-panty account Bearer token
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

        const response = await fetch(`${accountManageUrl()}/accounts/me/skills`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${bearerToken}`,
            },
            body: JSON.stringify({ source: "github", url: githubUrl }),
        });

        if (!response.ok) {
            const msg = await response.text().catch(() => response.statusText);
            throw new Error(`GitHub import failed (${response.status}): ${msg}`);
        }

        return (await response.json()) as { name: string; path: string; description?: string };
    },
});

/**
 * Create a simple skill in filthy-panty from name, description, and markdown content.
 * filthy-panty generates the SKILL.md; no local file management needed.
 * @param bearerToken the caller's filthy-panty account Bearer token
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

        const response = await fetch(`${accountManageUrl()}/accounts/me/skills`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${bearerToken}`,
            },
            body: JSON.stringify({ source: "json", name: name, description: description, content: content }),
        });

        if (!response.ok) {
            const msg = await response.text().catch(() => response.statusText);
            throw new Error(`Skill creation failed (${response.status}): ${msg}`);
        }

        return (await response.json()) as { name: string; path: string; description?: string };
    },
});

/**
 * Import an existing skill from filthy-panty and store its files in workspaceFiles.
 * Existing files for this nodeId are cleared before import.
 * @param projectId owning project
 * @param nodeId canvas skill node ID
 * @param skillName the filthy-panty skill name (without accountId prefix)
 * @param bearerToken the caller's filthy-panty account Bearer token
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

        const project = await ctx.runQuery(api.project.getById, { projectId: projectId });
        if (!project) {
            throw new Error("Project not found.");
        }

        // Fetch skill from filthy-panty
        const response = await fetch(
            `${accountManageUrl()}/accounts/me/skills/${encodeURIComponent(skillName)}`,
            { headers: { "Authorization": `Bearer ${bearerToken}` } },
        );

        if (!response.ok) {
            const msg = await response.text().catch(() => response.statusText);
            throw new Error(`Import failed (${response.status}): ${msg}`);
        }

        const skill = (await response.json()) as {
            name: string;
            description?: string;
            files: Array<{ path: string; bytes: string }>;
        };

        // Clear existing files for this node before importing
        await ctx.runMutation(internal.workspaceFiles.clearNodeInternal, {
            projectId: projectId,
            nodeId: nodeId,
        });

        // Upload each file to Convex storage and create workspaceFiles entries
        for (const file of skill.files) {
            const uploadUrl = await ctx.runMutation(api.workspaceFiles.generateUploadUrl, {});
            const content = Buffer.from(file.bytes, "base64");

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
