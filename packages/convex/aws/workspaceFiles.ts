"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { workspaceStorageValidator } from "../workspace/files";
import {
  deleteWorkspacePath,
  listWorkspaceFiles,
  purgeWorkspaceFilesystem,
  renameWorkspacePath,
  uploadWorkspaceFile,
  withStorageAccess,
  workspaceFileDownloadUrl,
  type WorkspaceFileEntry,
} from "../model/workspaceFs";

// Per-workspace storage, so a bring-your-own bucket is used where the sandbox mounts it.
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

export const list = internalAction({
  args: workspaceRef,
  returns: v.array(fileEntry),
  handler: async (ctx, args): Promise<WorkspaceFileEntry[]> => {
    return await listWorkspaceFiles(await withStorageAccess(ctx, args));
  },
});

export const upload = internalAction({
  args: {
    ...workspaceRef,
    path: v.string(),
    contentBase64: v.string(),
    contentType: v.optional(v.string()),
  },
  returns: fileEntry,
  handler: async (ctx, args): Promise<WorkspaceFileEntry> => {
    return await uploadWorkspaceFile(await withStorageAccess(ctx, args), {
      path: args.path,
      contentBase64: args.contentBase64,
      contentType: args.contentType,
    });
  },
});

export const downloadUrl = internalAction({
  args: { ...workspaceRef, path: v.string() },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    return await workspaceFileDownloadUrl(
      await withStorageAccess(ctx, args),
      args.path,
    );
  },
});

export const removePath = internalAction({
  args: { ...workspaceRef, path: v.string() },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    return await deleteWorkspacePath(
      await withStorageAccess(ctx, args),
      args.path,
    );
  },
});

export const purge = internalAction({
  args: workspaceRef,
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    return await purgeWorkspaceFilesystem(await withStorageAccess(ctx, args));
  },
});

export const renamePath = internalAction({
  args: { ...workspaceRef, path: v.string(), newPath: v.string() },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    return await renameWorkspacePath(
      await withStorageAccess(ctx, args),
      args.path,
      args.newPath,
    );
  },
});
