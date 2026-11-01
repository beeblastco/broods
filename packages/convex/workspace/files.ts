import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { authKit } from "../auth";
import { requireActiveAccount } from "../model/activeAccount";
import { deleteWorkspaceFile } from "../model/cascade";
import {
  getProjectForRole,
  getProjectForWrite,
} from "../model/ownership/project";
import {
  claimUploadedBlob,
  grantUpload,
  uploadQuotaMessage,
} from "../model/uploads";
import { getActiveAccountForUser } from "../org/orgs";
import {
  MAX_WORKSPACE_FILE_BYTES,
  normalizeWorkspaceConfig,
} from "../model/workspaceRules";

export const DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS = 24 * 60 * 60;
// Redeeming re-checks expiresAt; this per-mint sweep only keeps the table from growing.
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

// Lets file ops reach the bucket the sandbox actually mounts, not always the managed one.
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
        type: v.literal("r2"),
        accessKeyId: v.string(),
        secretAccessKey: v.string(),
      }),
      v.object({
        type: v.literal("assumeRole"),
        roleArn: v.string(),
      }),
    ),
  ),
});

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
  },
  returns: v.id("workspaceFiles"),
  handler: async (ctx, args): Promise<Id<"workspaceFiles">> => {
    const { projectId, nodeId, path, name, isFolder, storageId, mimeType } =
      args;

    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const project = await getProjectForWrite(ctx, user.id, projectId, "admin");
    if (!project) throw new Error(WORKSPACE_ADMIN_REQUIRED);

    const blob = storageId ? await claimUploadedBlob(ctx, storageId) : null;
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
      sizeBytes: blob?.size,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// Only the token's SHA-256 is stored; the plaintext lives only in the URL handed out.
// Redeeming mints a fresh presigned S3 URL, so AWS signatures never reach chat clients.
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
  handler: async (ctx, args): Promise<null> => {
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

export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx): Promise<string> => {
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

export const getFileDownloadUrl = query({
  args: {
    projectId: v.id("projects"),
    nodeId: v.string(),
    path: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args): Promise<string | null> => {
    const { projectId, nodeId, path } = args;

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

export const list = query({
  args: {
    projectId: v.id("projects"),
    nodeId: v.string(),
  },
  returns: v.array(workspaceFileDoc),
  handler: async (ctx, args): Promise<Doc<"workspaceFiles">[]> => {
    const { projectId, nodeId } = args;

    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    // Empty, not a throw: a just-deleted project must not crash the panel before it unmounts.
    const project = await getProjectForRole(ctx, user.id, projectId);
    if (!project) return [];

    return await ctx.db
      .query("workspaceFiles")
      .withIndex("by_projectId_nodeId_and_path", (q) =>
        q.eq("projectId", projectId).eq("nodeId", nodeId),
      )
      .collect();
  },
});

export const remove = mutation({
  args: { fileId: v.id("workspaceFiles") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { fileId } = args;

    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const file = await ctx.db.get(fileId);
    if (!file) throw new Error("File not found.");
    const project = await getProjectForWrite(
      ctx,
      user.id,
      file.projectId,
      "admin",
    );
    if (!project) throw new Error(WORKSPACE_ADMIN_REQUIRED);

    await deleteWorkspaceFile(ctx, file);

    return null;
  },
});

export const removeFolder = mutation({
  args: {
    projectId: v.id("projects"),
    nodeId: v.string(),
    folderPath: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { projectId, nodeId, folderPath } = args;

    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const project = await getProjectForWrite(ctx, user.id, projectId, "admin");
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
      await deleteWorkspaceFile(ctx, doc);
    }

    return null;
  },
});

export const rename = mutation({
  args: {
    fileId: v.id("workspaceFiles"),
    newName: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { fileId, newName } = args;

    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const file = await ctx.db.get(fileId);
    if (!file) throw new Error("File not found.");
    const project = await getProjectForWrite(
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
    // Only a change passes requiredRole, and a disabled account may not make one.
    if (args.requiredRole) await requireActiveAccount(ctx, workspace.accountId);

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
