"use node";

/**
 * Node-runtime internal actions for S3 workspace file operations, called by
 * the default-runtime config HTTP surface (configHttp). Dashboard actions use
 * model/workspaceFs directly via workspaceFilesPublic instead.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { workspaceStorageValidator } from "./workspaceFiles";
import {
  deleteWorkspacePath,
  listWorkspaceFiles,
  purgeWorkspaceFilesystem,
  renameWorkspacePath,
  uploadWorkspaceFile,
  workspaceFileDownloadUrl,
} from "./model/workspaceFs";

// Every op takes the workspace's own storage block so a bring-your-own bucket is
// read and written where the sandbox mounts it, not in the managed bucket.
const workspaceRef = {
  accountId: v.id("accounts"),
  workspaceId: v.id("workspaceConfigs"),
  storage: v.optional(workspaceStorageValidator),
};

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
  args: workspaceRef,
  returns: v.array(fileEntry),
  handler: async (_ctx, args) => {
    return await listWorkspaceFiles(args);
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
    ...workspaceRef,
    path: v.string(),
    contentBase64: v.string(),
    contentType: v.optional(v.string()),
  },
  returns: fileEntry,
  handler: async (_ctx, args) => {
    return await uploadWorkspaceFile(args, {
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
  args: { ...workspaceRef, path: v.string() },
  returns: v.string(),
  handler: async (_ctx, args) => {
    return await workspaceFileDownloadUrl(args, args.path);
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
  args: { ...workspaceRef, path: v.string() },
  returns: v.number(),
  handler: async (_ctx, args) => {
    return await deleteWorkspacePath(args, args.path);
  },
});

/**
 * Purge all files in a managed workspace filesystem namespace.
 * @param accountId account owning the workspace
 * @param workspaceId workspace config id
 * @returns the number of objects deleted
 */
export const purge = internalAction({
  args: workspaceRef,
  returns: v.number(),
  handler: async (_ctx, args) => {
    return await purgeWorkspaceFilesystem(args);
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
  args: { ...workspaceRef, path: v.string(), newPath: v.string() },
  returns: v.number(),
  handler: async (_ctx, args) => {
    return await renameWorkspacePath(args, args.path, args.newPath);
  },
});
