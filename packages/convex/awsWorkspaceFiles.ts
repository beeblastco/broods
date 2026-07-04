"use node";

/**
 * Node-runtime internal actions for S3 workspace file operations, called by
 * the default-runtime config HTTP surface (configHttp). Dashboard actions use
 * model/workspaceFs directly via workspaceFilesPublic instead.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import {
    deleteWorkspacePath,
    listWorkspaceFiles,
    renameWorkspacePath,
    uploadWorkspaceFile,
    workspaceFileDownloadUrl,
} from "./model/workspaceFs";

const fileEntry = v.object({
    path: v.string(),
    name: v.string(),
    isFolder: v.boolean(),
    sizeBytes: v.optional(v.number()),
    updatedAt: v.optional(v.string()),
});

/**
 * List a workspace's files and folders.
 * @param accountId account owning the workspace
 * @param workspaceId workspace config id
 * @returns files plus synthesized folder entries
 */
export const list = internalAction({
    args: { accountId: v.id("accounts"), workspaceId: v.id("workspaceConfigs") },
    returns: v.array(fileEntry),
    handler: async (_ctx, args) => {
        return await listWorkspaceFiles(args.accountId, args.workspaceId);
    },
});

/**
 * Upload or replace one workspace file.
 * @param accountId account owning the workspace
 * @param workspaceId workspace config id
 * @param path file path, contentBase64 contents, contentType optional
 * @returns the stored file entry
 */
export const upload = internalAction({
    args: {
        accountId: v.id("accounts"),
        workspaceId: v.id("workspaceConfigs"),
        path: v.string(),
        contentBase64: v.string(),
        contentType: v.optional(v.string()),
    },
    returns: fileEntry,
    handler: async (_ctx, args) => {
        return await uploadWorkspaceFile(args.accountId, args.workspaceId, {
            path: args.path,
            contentBase64: args.contentBase64,
            contentType: args.contentType,
        });
    },
});

/**
 * Presign a download URL for one workspace file.
 * @param accountId account owning the workspace
 * @param workspaceId workspace config id
 * @param path the file path
 * @returns a short-lived S3 GET URL
 */
export const downloadUrl = internalAction({
    args: { accountId: v.id("accounts"), workspaceId: v.id("workspaceConfigs"), path: v.string() },
    returns: v.string(),
    handler: async (_ctx, args) => {
        return await workspaceFileDownloadUrl(args.accountId, args.workspaceId, args.path);
    },
});

/**
 * Delete a workspace file or folder prefix.
 * @param accountId account owning the workspace
 * @param workspaceId workspace config id
 * @param path the file or folder path
 * @returns the number of objects deleted
 */
export const removePath = internalAction({
    args: { accountId: v.id("accounts"), workspaceId: v.id("workspaceConfigs"), path: v.string() },
    returns: v.number(),
    handler: async (_ctx, args) => {
        return await deleteWorkspacePath(args.accountId, args.workspaceId, args.path);
    },
});

/**
 * Rename a workspace file or folder prefix.
 * @param accountId account owning the workspace
 * @param workspaceId workspace config id
 * @param path source path, newPath destination path
 * @returns the number of objects moved
 */
export const renamePath = internalAction({
    args: {
        accountId: v.id("accounts"),
        workspaceId: v.id("workspaceConfigs"),
        path: v.string(),
        newPath: v.string(),
    },
    returns: v.number(),
    handler: async (_ctx, args) => {
        return await renameWorkspacePath(args.accountId, args.workspaceId, args.path, args.newPath);
    },
});
