/**
 * Workspace file tree CRUD. Files are stored in Convex storage; this table
 * tracks path metadata and is scoped to a projectId + canvas nodeId.
 */

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { getOwnedProject } from "./model/ownership/project";

function pathPrefixUpperBound(path: string): string {
    return `${path}\uffff`;
}

/**
 * List all file/folder entries for a workspace node.
 * @param projectId owning project
 * @param nodeId canvas node ID of the workspace
 * @returns flat array of file metadata records
 */
export const list = query({
    args: {
        projectId: v.id("projects"),
        nodeId: v.string(),
    },
    handler: async (ctx, args) => {
        const { projectId, nodeId } = args;

        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        // Return empty rather than throwing so a just-deleted project doesn't crash
        // the reactive workspace panel before it unmounts.
        const project = await getOwnedProject(ctx, user.id, projectId);
        if (!project) return [];

        return await ctx.db
            .query("workspaceFiles")
            .withIndex("by_projectId_and_nodeId", (q) =>
                q.eq("projectId", projectId).eq("nodeId", nodeId),
            )
            .collect();
    },
});

/**
 * Generate a one-time upload URL for Convex file storage.
 * @returns a pre-signed upload URL
 */
export const generateUploadUrl = mutation({
    args: {},
    handler: async (ctx) => {
        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        return await ctx.storage.generateUploadUrl();
    },
});

/**
 * Create a file or folder entry after the binary has been uploaded to storage.
 * @param projectId owning project
 * @param nodeId canvas workspace node ID
 * @param path full path from workspace root, e.g. "src/components/Button.tsx"
 * @param name filename or folder name
 * @param isFolder true for directory entries
 * @param storageId Convex storage ID for the uploaded file (omit for folders)
 * @param mimeType MIME type of the file
 * @param sizeBytes file size in bytes
 * @returns the new document ID
 */
export const create = mutation({
    args: {
        projectId: v.id("projects"),
        nodeId: v.string(),
        path: v.string(),
        name: v.string(),
        isFolder: v.boolean(),
        storageId: v.optional(v.id("_storage")),
        mimeType: v.optional(v.string()),
        sizeBytes: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        const { projectId, nodeId, path, name, isFolder, storageId, mimeType, sizeBytes } = args;

        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const project = await getOwnedProject(ctx, user.id, projectId);
        if (!project) throw new Error("Project not found.");

        const now = Date.now();

        return await ctx.db.insert("workspaceFiles", {
            authId: user.id,
            projectId: projectId,
            nodeId: nodeId,
            path: path,
            name: name,
            isFolder: isFolder,
            storageId: storageId,
            mimeType: mimeType,
            sizeBytes: sizeBytes,
            createdAt: now,
            updatedAt: now,
        });
    },
});

/**
 * Delete a single file entry and its storage object (if any).
 * @param fileId the workspaceFiles document to remove
 */
export const remove = mutation({
    args: { fileId: v.id("workspaceFiles") },
    handler: async (ctx, args) => {
        const { fileId } = args;

        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const file = await ctx.db.get(fileId);
        if (!file) throw new Error("File not found.");
        const project = await getOwnedProject(ctx, user.id, file.projectId);
        if (!project) throw new Error("File not found.");

        if (file.storageId) {
            await ctx.storage.delete(file.storageId);
        }
        await ctx.db.delete(fileId);

        return null;
    },
});

/**
 * Rename a file or folder. For folders, all descendant paths are updated atomically.
 * @param fileId the workspaceFiles document to rename
 * @param newName the new filename or folder name (no slashes)
 */
export const rename = mutation({
    args: {
        fileId: v.id("workspaceFiles"),
        newName: v.string(),
    },
    handler: async (ctx, args) => {
        const { fileId, newName } = args;

        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const file = await ctx.db.get(fileId);
        if (!file) throw new Error("File not found.");
        const project = await getOwnedProject(ctx, user.id, file.projectId);
        if (!project) throw new Error("File not found.");

        const trimmed = newName.trim();
        if (!trimmed || trimmed.includes("/")) throw new Error("Invalid name.");

        const slash = file.path.lastIndexOf("/");
        const newPath = slash === -1 ? trimmed : `${file.path.slice(0, slash)}/${trimmed}`;
        const now = Date.now();

        if (file.isFolder) {
            const descendants = await ctx.db
                .query("workspaceFiles")
                .withIndex("by_projectId_nodeId_and_path", (q) =>
                    q
                        .eq("projectId", file.projectId)
                        .eq("nodeId", file.nodeId)
                        .gte("path", `${file.path}/`)
                        .lt("path", pathPrefixUpperBound(`${file.path}/`)),
                )
                .collect();

            for (const doc of descendants) {
                const childNewPath = newPath + doc.path.slice(file.path.length);
                await ctx.db.patch(doc._id, { path: childNewPath, updatedAt: now });
            }
        }

        await ctx.db.patch(fileId, { name: trimmed, path: newPath, updatedAt: now });

        return null;
    },
});

/**
 * Return a short-lived signed download URL for a single file entry.
 * @param projectId owning project
 * @param nodeId canvas node ID
 * @param path file path (e.g. "SKILL.md")
 * @returns signed URL, or null if the file does not exist / has no storageId
 */
export const getFileDownloadUrl = query({
    args: {
        projectId: v.id("projects"),
        nodeId: v.string(),
        path: v.string(),
    },
    handler: async (ctx, args) => {
        const { projectId, nodeId, path } = args;

        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const project = await getOwnedProject(ctx, user.id, projectId);
        if (!project) return null;

        const file = await ctx.db
            .query("workspaceFiles")
            .withIndex("by_projectId_nodeId_and_path", (q) =>
                q.eq("projectId", projectId).eq("nodeId", nodeId).eq("path", path),
            )
            .first();

        if (!file?.storageId) return null;

        return await ctx.storage.getUrl(file.storageId);
    },
});

/**
 * Delete a folder and all descendants (files + subfolders) matching a path prefix.
 * @param projectId owning project
 * @param nodeId canvas workspace node ID
 * @param folderPath the folder path to remove including all children
 */
export const removeFolder = mutation({
    args: {
        projectId: v.id("projects"),
        nodeId: v.string(),
        folderPath: v.string(),
    },
    handler: async (ctx, args) => {
        const { projectId, nodeId, folderPath } = args;

        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const project = await getOwnedProject(ctx, user.id, projectId);
        if (!project) throw new Error("Project not found.");

        const descendants = await ctx.db
            .query("workspaceFiles")
            .withIndex("by_projectId_nodeId_and_path", (q) =>
                q
                    .eq("projectId", projectId)
                    .eq("nodeId", nodeId)
                    .gte("path", folderPath)
                    .lt("path", pathPrefixUpperBound(folderPath)),
            )
            .collect();

        for (const doc of descendants) {
            if (doc.path !== folderPath && !doc.path.startsWith(folderPath + "/")) continue;
            if (doc.storageId) {
                await ctx.storage.delete(doc.storageId);
            }
            await ctx.db.delete(doc._id);
        }

        return null;
    },
});


/**
 * Internal: delete all files for a node (used by skillsPublic.importSkill before re-import).
 * @param projectId owning project
 * @param nodeId canvas node whose files should be wiped
 */
export const clearNodeInternal = internalMutation({
    args: {
        projectId: v.id("projects"),
        nodeId: v.string(),
    },
    handler: async (ctx, args) => {
        const { projectId, nodeId } = args;

        const all = await ctx.db
            .query("workspaceFiles")
            .withIndex("by_projectId_and_nodeId", (q) =>
                q.eq("projectId", projectId).eq("nodeId", nodeId),
            )
            .collect();

        for (const doc of all) {
            if (doc.storageId) {
                await ctx.storage.delete(doc.storageId);
            }
            await ctx.db.delete(doc._id);
        }

        return null;
    },
});
