/**
 * Workspace file tree CRUD. Files are stored in Convex storage; this table
 * tracks path metadata and is scoped to a projectId + canvas nodeId.
 *
 * Also owns capability links for workspace files (the `workspaceDownloadTokens`
 * table). A token is the whole credential, so it is stored only as a SHA-256
 * hash and the plaintext lives nowhere but the URL that was handed out.
 * Redeeming one mints a fresh presigned S3 URL server-side, which is what keeps
 * AWS signature material out of chat clients entirely.
 */

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { authKit } from "../auth";
import { getProjectForRole } from "../model/ownership/project";
import { grantUpload, uploadQuotaMessage } from "../model/uploads";
import { getActiveAccountForUser } from "../org/orgs";
import {
  MAX_WORKSPACE_FILE_BYTES,
  normalizeWorkspaceConfig,
} from "../model/workspaceRules";

export const DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS = 24 * 60 * 60;
// Expired rows are dead weight, not a security boundary — redeeming always
// re-checks expiresAt. One bounded sweep per mint keeps the table from growing.
const DOWNLOAD_TOKEN_PRUNE_BATCH_SIZE = 50;
export const MAX_DOWNLOAD_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const resolvedToken = v.object({
  accountId: v.id("accounts"),
  workspaceId: v.id("workspaceConfigs"),
  path: v.string(),
  filename: v.string(),
  expiresAt: v.number(),
});

const workspaceFileDoc = v.object({
  _id: v.id("workspaceFiles"),
  _creationTime: v.number(),
  authId: v.string(),
  projectId: v.id("projects"),
  nodeId: v.string(),
  path: v.string(),
  name: v.string(),
  isFolder: v.boolean(),
  storageId: v.optional(v.id("_storage")),
  mimeType: v.optional(v.string()),
  sizeBytes: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

/**
 * A workspace's storage block, shaped as `WorkspaceStorageConfig`. Carried
 * alongside the workspace ids so file operations reach the bucket the sandbox
 * actually mounts instead of always assuming the managed one.
 */
export const workspaceStorageValidator = v.object({
  provider: v.literal("s3"),
  bucket: v.optional(v.string()),
  region: v.optional(v.string()),
  endpoint: v.optional(v.string()),
  prefix: v.optional(v.string()),
  auth: v.optional(
    v.union(
      v.object({ type: v.literal("managed") }),
      v.object({
        type: v.literal("assumeRole"),
        roleArn: v.string(),
        externalId: v.optional(v.string()),
      }),
    ),
  ),
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
const WORKSPACE_ADMIN_REQUIRED =
  "Workspace files can only be changed by an org admin.";

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
  returns: v.id("workspaceFiles"),
  handler: async (ctx, args) => {
    const {
      projectId,
      nodeId,
      path,
      name,
      isFolder,
      storageId,
      mimeType,
      sizeBytes,
    } = args;

    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const project = await getProjectForRole(ctx, user.id, projectId, "admin");
    if (!project) throw new Error(WORKSPACE_ADMIN_REQUIRED);

    // The blob's own size is the truth; the client-supplied value is only a
    // hint and the cap is enforced here, not at upload time.
    const blob = storageId ? await ctx.db.system.get(storageId) : null;
    if (storageId && !blob) {
      throw new Error("Uploaded file was not found in storage.");
    }
    if (blob && blob.size > MAX_WORKSPACE_FILE_BYTES) {
      await ctx.storage.delete(blob._id);
      throw new Error(
        `Workspace files are capped at ${MAX_WORKSPACE_FILE_BYTES} bytes.`,
      );
    }

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
      sizeBytes: blob ? blob.size : sizeBytes,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Store one download token and sweep a bounded batch of expired rows.
 * @param accountId account owning the workspace
 * @param workspaceId workspace the file lives in
 * @param path normalized workspace-relative path
 * @param filename name offered to whoever follows the link
 * @param tokenHash SHA-256 hex of the minted token
 * @param expiresAt epoch millis the token stops working
 * @param now caller's clock in epoch millis
 */
export const createDownloadToken = internalMutation({
  args: {
    accountId: v.id("accounts"),
    workspaceId: v.id("workspaceConfigs"),
    path: v.string(),
    filename: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("workspaceDownloadTokens", {
      accountId: args.accountId,
      workspaceId: args.workspaceId,
      path: args.path,
      filename: args.filename,
      tokenHash: args.tokenHash,
      expiresAt: args.expiresAt,
      createdAt: args.now,
    });
    const stale = await ctx.db
      .query("workspaceDownloadTokens")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", args.now))
      .take(DOWNLOAD_TOKEN_PRUNE_BATCH_SIZE);
    for (const record of stale) await ctx.db.delete(record._id);

    return null;
  },
});

/**
 * Generate a one-time upload URL for Convex file storage, counted against the
 * account's hourly upload quota.
 * @returns a pre-signed upload URL
 */
export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }
    const account = await getActiveAccountForUser(ctx, "admin");
    if (!account) throw new Error(WORKSPACE_ADMIN_REQUIRED);

    const grant = await grantUpload(ctx, account._id, "workspace");
    if ("retryAt" in grant) throw new Error(uploadQuotaMessage(grant.retryAt));

    return grant.uploadUrl;
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
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const { projectId, nodeId, path } = args;

    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const project = await getProjectForRole(ctx, user.id, projectId);
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
 * Internal: create a signed download URL for one legacy file during migration.
 * @param authId WorkOS auth id of the caller that started the migration
 * @param projectId owning project
 * @param nodeId canvas node ID of the workspace
 * @param path file path inside the legacy workspace tree
 * @returns signed URL or null when the file cannot be read
 */
export const getFileDownloadUrlInternal = internalQuery({
  args: {
    authId: v.string(),
    projectId: v.id("projects"),
    nodeId: v.string(),
    path: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const project = await getProjectForRole(ctx, args.authId, args.projectId);
    if (!project) return null;

    const file = await ctx.db
      .query("workspaceFiles")
      .withIndex("by_projectId_nodeId_and_path", (q) =>
        q
          .eq("projectId", args.projectId)
          .eq("nodeId", args.nodeId)
          .eq("path", args.path),
      )
      .first();

    if (!file?.storageId) return null;

    return await ctx.storage.getUrl(file.storageId);
  },
});

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
  returns: v.array(workspaceFileDoc),
  handler: async (ctx, args) => {
    const { projectId, nodeId } = args;

    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    // Return empty rather than throwing so a just-deleted project doesn't crash
    // the reactive workspace panel before it unmounts.
    const project = await getProjectForRole(ctx, user.id, projectId);
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
 * Internal: list legacy Convex-storage files after checking project ownership.
 * @param authId WorkOS auth id of the caller that started the migration
 * @param projectId owning project
 * @param nodeId canvas node ID of the workspace
 * @returns legacy file metadata rows for migration
 */
export const listForMigrationInternal = internalQuery({
  args: {
    authId: v.string(),
    projectId: v.id("projects"),
    nodeId: v.string(),
  },
  returns: v.array(workspaceFileDoc),
  handler: async (ctx, args) => {
    const project = await getProjectForRole(ctx, args.authId, args.projectId);
    if (!project) return [];

    return await ctx.db
      .query("workspaceFiles")
      .withIndex("by_projectId_and_nodeId", (q) =>
        q.eq("projectId", args.projectId).eq("nodeId", args.nodeId),
      )
      .collect();
  },
});

/**
 * Delete a single file entry and its storage object (if any).
 * @param fileId the workspaceFiles document to remove
 */
export const remove = mutation({
  args: { fileId: v.id("workspaceFiles") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { fileId } = args;

    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const file = await ctx.db.get(fileId);
    if (!file) throw new Error("File not found.");
    const project = await getProjectForRole(
      ctx,
      user.id,
      file.projectId,
      "admin",
    );
    if (!project) throw new Error(WORKSPACE_ADMIN_REQUIRED);

    if (file.storageId) {
      await ctx.storage.delete(file.storageId);
    }
    await ctx.db.delete(fileId);

    return null;
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
  returns: v.null(),
  handler: async (ctx, args) => {
    const { projectId, nodeId, folderPath } = args;

    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const project = await getProjectForRole(ctx, user.id, projectId, "admin");
    if (!project) throw new Error(WORKSPACE_ADMIN_REQUIRED);

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
      if (doc.path !== folderPath && !doc.path.startsWith(folderPath + "/"))
        continue;
      if (doc.storageId) {
        await ctx.storage.delete(doc.storageId);
      }
      await ctx.db.delete(doc._id);
    }

    return null;
  },
});

/**
 * Internal: remove one legacy file row and storage object after S3 migration.
 * @param authId WorkOS auth id of the caller that started the migration
 * @param fileId legacy workspaceFiles row to delete
 */
export const removeForMigrationInternal = internalMutation({
  args: {
    authId: v.string(),
    fileId: v.id("workspaceFiles"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId);
    if (!file) return null;

    const project = await getProjectForRole(ctx, args.authId, file.projectId);
    if (!project) return null;

    if (file.storageId) {
      await ctx.storage.delete(file.storageId);
    }
    await ctx.db.delete(args.fileId);

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
  returns: v.null(),
  handler: async (ctx, args) => {
    const { fileId, newName } = args;

    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const file = await ctx.db.get(fileId);
    if (!file) throw new Error("File not found.");
    const project = await getProjectForRole(
      ctx,
      user.id,
      file.projectId,
      "admin",
    );
    if (!project) throw new Error(WORKSPACE_ADMIN_REQUIRED);

    const trimmed = newName.trim();
    if (!trimmed || trimmed.includes("/")) throw new Error("Invalid name.");

    const slash = file.path.lastIndexOf("/");
    const newPath =
      slash === -1 ? trimmed : `${file.path.slice(0, slash)}/${trimmed}`;
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

    await ctx.db.patch(fileId, {
      name: trimmed,
      path: newPath,
      updatedAt: now,
    });

    return null;
  },
});

/**
 * Look up a download token by hash, ignoring anything already expired.
 * @param tokenHash SHA-256 hex of the presented token
 * @param now caller's clock in epoch millis
 * @returns the file the token grants, or null when unknown or expired
 */
export const resolveByHash = internalQuery({
  args: { tokenHash: v.string(), now: v.number() },
  returns: v.union(resolvedToken, v.null()),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("workspaceDownloadTokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!record || record.expiresAt <= args.now) return null;

    return {
      accountId: record.accountId,
      workspaceId: record.workspaceId,
      path: record.path,
      filename: record.filename,
      expiresAt: record.expiresAt,
    };
  },
});

/**
 * Internal: resolve an S3-backed workspace for a caller-owned project.
 * @param authId WorkOS auth id of the caller
 * @param projectId owning project
 * @param workspaceId workspaceConfigs document ID stored on the canvas node
 * @returns runtime account/workspace identifiers, or null when inaccessible
 */
export const resolveRuntimeWorkspaceInternal = internalQuery({
  args: {
    authId: v.string(),
    projectId: v.id("projects"),
    workspaceId: v.string(),
    requiredRole: v.optional(
      v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
    ),
  },
  returns: v.union(
    v.object({
      accountId: v.id("accounts"),
      workspaceId: v.id("workspaceConfigs"),
      storage: workspaceStorageValidator,
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const project = await getProjectForRole(
      ctx,
      args.authId,
      args.projectId,
      args.requiredRole,
    );
    if (!project) return null;
    const workspaceId = ctx.db.normalizeId(
      "workspaceConfigs",
      args.workspaceId,
    );
    if (!workspaceId) return null;
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace || workspace.projectId !== args.projectId) return null;

    return {
      accountId: workspace.accountId,
      workspaceId: workspace._id,
      storage: normalizeWorkspaceConfig(workspace.config).storage,
    };
  },
});

function pathPrefixUpperBound(path: string): string {
  return `${path}\uffff`;
}
