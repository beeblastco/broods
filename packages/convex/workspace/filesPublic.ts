"use node";
// S3 is the single source of truth for runtime workspace contents.

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { action, type ActionCtx } from "../_generated/server";
import { authKit, type AuthUser } from "../auth";
import {
  deleteWorkspacePath,
  listWorkspaceFiles,
  readWorkspaceFile,
  renameWorkspacePath,
  uploadWorkspaceFile,
  withStorageAccess,
  workspaceFileDownloadUrl,
  type WorkspaceFileEntry,
  type WorkspaceFsRef,
} from "../model/workspaceFs";

const fileEntry = v.object({
  path: v.string(),
  name: v.string(),
  isFolder: v.boolean(),
  sizeBytes: v.optional(v.number()),
  updatedAt: v.optional(v.string()),
});

type RuntimeWorkspace = WorkspaceFsRef & {
  accountId: Id<"accounts">;
  workspaceId: Id<"workspaceConfigs">;
};

export const downloadUrl = action({
  args: {
    projectId: v.id("projects"),
    workspaceId: v.string(),
    path: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const workspace = await resolveWorkspace(ctx, args);

    return await workspaceFileDownloadUrl(workspace, args.path);
  },
});

export const list = action({
  args: { projectId: v.id("projects"), workspaceId: v.string() },
  returns: v.array(fileEntry),
  handler: async (ctx, args): Promise<WorkspaceFileEntry[]> => {
    const workspace = await resolveWorkspace(ctx, args);

    return await listWorkspaceFiles(workspace);
  },
});

export const read = action({
  args: {
    projectId: v.id("projects"),
    workspaceId: v.string(),
    path: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const workspace = await resolveWorkspace(ctx, args);

    return await readWorkspaceFile(workspace, args.path);
  },
});

export const remove = action({
  args: {
    projectId: v.id("projects"),
    workspaceId: v.string(),
    path: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const workspace = await resolveWorkspace(ctx, args, "admin");
    await deleteWorkspacePath(workspace, args.path);

    return null;
  },
});

export const rename = action({
  args: {
    projectId: v.id("projects"),
    workspaceId: v.string(),
    path: v.string(),
    newPath: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const workspace = await resolveWorkspace(ctx, args, "admin");
    await renameWorkspacePath(workspace, args.path, args.newPath);

    return null;
  },
});

export const upload = action({
  args: {
    projectId: v.id("projects"),
    workspaceId: v.string(),
    path: v.string(),
    contentBase64: v.string(),
    contentType: v.optional(v.string()),
  },
  returns: fileEntry,
  handler: async (ctx, args): Promise<WorkspaceFileEntry> => {
    const workspace = await resolveWorkspace(ctx, args, "admin");

    return await uploadWorkspaceFile(workspace, {
      path: args.path,
      contentBase64: args.contentBase64,
      contentType: args.contentType,
    });
  },
});

async function requireActionUser(ctx: ActionCtx): Promise<AuthUser> {
  const user = await authKit.getAuthUser(ctx);
  if (!user) throw new Error("User not found or not authenticated");

  return user;
}

async function resolveWorkspace(
  ctx: ActionCtx,
  args: { projectId: Id<"projects">; workspaceId: string },
  requiredRole?: "admin",
): Promise<RuntimeWorkspace> {
  const user = await requireActionUser(ctx);
  const workspace: RuntimeWorkspace | null = await ctx.runQuery(
    internal.workspace.files.resolveRuntimeWorkspaceInternal,
    {
      authId: user.id,
      projectId: args.projectId,
      workspaceId: args.workspaceId,
      ...(requiredRole ? { requiredRole: requiredRole } : {}),
    },
  );
  if (!workspace) {
    throw new Error(
      requiredRole
        ? "Workspace files can only be changed by an org admin."
        : "Workspace not found",
    );
  }

  return await withStorageAccess(ctx, workspace);
}
