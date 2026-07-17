"use node";
/**
 * Authenticated dashboard actions for mounted workspace files. S3 is the
 * single source of truth for runtime workspace contents; the shared ops live
 * in model/workspaceFs (also used by the config HTTP surface).
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, type ActionCtx } from "./_generated/server";
import { authKit } from "./auth";
import {
  MAX_WORKSPACE_FILE_BYTES,
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

type RuntimeWorkspace = {
  accountId: Id<"accounts">;
  workspaceId: Id<"workspaceConfigs">;
};
type LegacyFile = {
  _id: Id<"workspaceFiles">;
  path: string;
  isFolder: boolean;
  storageId?: Id<"_storage">;
};

async function requireActionUser(ctx: ActionCtx) {
  const user = await authKit.getAuthUser(ctx);
  if (!user) throw new Error("User not found or not authenticated");

  return user;
}

/** Moves legacy files into S3 when needed and returns the authoritative file list. */
export const migrateLegacy = action({
  args: {
    projectId: v.id("projects"),
    nodeId: v.string(),
    workspaceId: v.string(),
  },
  returns: v.array(fileEntry),
  handler: async (ctx, args) => {
    const user = await requireActionUser(ctx);
    const workspace = await resolveWorkspace(ctx, args);
    const legacyFiles: LegacyFile[] = await ctx.runQuery(
      internal.workspaceFiles.listForMigrationInternal,
      {
        authId: user.id,
        projectId: args.projectId,
        nodeId: args.nodeId,
      },
    );
    if (legacyFiles.length === 0)
      return await listWorkspaceFiles(
        workspace.accountId,
        workspace.workspaceId,
      );
    const current = await listWorkspaceFiles(
      workspace.accountId,
      workspace.workspaceId,
    );
    const existingPaths = new Set(current.map((file) => file.path));
    let changed = false;

    for (const file of legacyFiles) {
      if (!file.isFolder && file.storageId && !existingPaths.has(file.path)) {
        const url: string | null = await ctx.runQuery(
          internal.workspaceFiles.getFileDownloadUrlInternal,
          {
            authId: user.id,
            projectId: args.projectId,
            nodeId: args.nodeId,
            path: file.path,
          },
        );
        if (!url) continue;
        const response = await fetch(url);
        if (!response.ok) continue;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_WORKSPACE_FILE_BYTES) continue;
        await uploadWorkspaceFile(workspace.accountId, workspace.workspaceId, {
          path: file.path,
          contentBase64: Buffer.from(bytes).toString("base64"),
          contentType: response.headers.get("content-type") ?? undefined,
        });
        changed = true;
      }
      await ctx.runMutation(
        internal.workspaceFiles.removeForMigrationInternal,
        {
          authId: user.id,
          fileId: file._id,
        },
      );
    }

    return changed
      ? await listWorkspaceFiles(workspace.accountId, workspace.workspaceId)
      : current;
  },
});

/** Lists files from the S3 namespace mounted by the selected runtime workspace. */
export const list = action({
  args: { projectId: v.id("projects"), workspaceId: v.string() },
  returns: v.array(fileEntry),
  handler: async (ctx, args) => {
    const workspace = await resolveWorkspace(ctx, args);

    return await listWorkspaceFiles(workspace.accountId, workspace.workspaceId);
  },
});

/** Uploads or replaces one file in the mounted S3 workspace. */
export const upload = action({
  args: {
    projectId: v.id("projects"),
    workspaceId: v.string(),
    path: v.string(),
    contentBase64: v.string(),
    contentType: v.optional(v.string()),
  },
  returns: fileEntry,
  handler: async (ctx, args) => {
    const workspace = await resolveWorkspace(ctx, args);

    return await uploadWorkspaceFile(
      workspace.accountId,
      workspace.workspaceId,
      {
        path: args.path,
        contentBase64: args.contentBase64,
        contentType: args.contentType,
      },
    );
  },
});

/** Deletes a file or folder prefix from the mounted S3 workspace. */
export const remove = action({
  args: {
    projectId: v.id("projects"),
    workspaceId: v.string(),
    path: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workspace = await resolveWorkspace(ctx, args);
    await deleteWorkspacePath(
      workspace.accountId,
      workspace.workspaceId,
      args.path,
    );

    return null;
  },
});

/** Renames a file or folder prefix inside the mounted S3 workspace. */
export const rename = action({
  args: {
    projectId: v.id("projects"),
    workspaceId: v.string(),
    path: v.string(),
    newPath: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workspace = await resolveWorkspace(ctx, args);
    await renameWorkspacePath(
      workspace.accountId,
      workspace.workspaceId,
      args.path,
      args.newPath,
    );

    return null;
  },
});

/** Returns a short-lived S3 download URL for a mounted workspace file. */
export const getDownloadUrl = action({
  args: {
    projectId: v.id("projects"),
    workspaceId: v.string(),
    path: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const workspace = await resolveWorkspace(ctx, args);

    return await workspaceFileDownloadUrl(
      workspace.accountId,
      workspace.workspaceId,
      args.path,
    );
  },
});

async function resolveWorkspace(
  ctx: ActionCtx,
  args: { projectId: Id<"projects">; workspaceId: string },
): Promise<RuntimeWorkspace> {
  const user = await requireActionUser(ctx);
  const workspace: RuntimeWorkspace | null = await ctx.runQuery(
    internal.workspaceFiles.resolveRuntimeWorkspaceInternal,
    {
      authId: user.id,
      projectId: args.projectId,
      workspaceId: args.workspaceId,
    },
  );
  if (!workspace) throw new Error("Workspace not found");

  return workspace;
}
