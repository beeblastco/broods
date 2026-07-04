"use node";
/**
 * Authenticated actions for mounted workspace files. S3 is the single source of
 * truth for runtime workspace contents; Convex owns the AWS writes directly.
 */

import { createHash } from "node:crypto";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, type ActionCtx } from "./_generated/server";
import { authKit } from "./auth";
import {
    copyS3Object,
    deleteS3Object,
    deleteS3Prefix,
    ensureS3DirectoryMarkers,
    getS3ObjectUrl,
    listS3Prefix,
    s3ObjectExists,
    writeS3Object,
} from "./model/s3";

const FILESYSTEM_NAMESPACE_PREFIX = "fs-";
const HASH_HEX_LENGTH = 40;
const MAX_FILE_BYTES = 512 * 1024;

const fileEntry = v.object({
    path: v.string(),
    name: v.string(),
    isFolder: v.boolean(),
    sizeBytes: v.optional(v.number()),
    updatedAt: v.optional(v.string()),
});

type RuntimeWorkspace = { accountId: Id<"accounts">; workspaceId: Id<"workspaceConfigs"> };
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
        const legacyFiles: LegacyFile[] = await ctx.runQuery(internal.workspaceFiles.listForMigrationInternal, {
            authId: user.id,
            projectId: args.projectId,
            nodeId: args.nodeId,
        });
        if (legacyFiles.length === 0) return await listWorkspaceFiles(workspace);
        const current = await listWorkspaceFiles(workspace);
        const existingPaths = new Set(current.map((file) => file.path));
        let changed = false;

        for (const file of legacyFiles) {
            if (!file.isFolder && file.storageId && !existingPaths.has(file.path)) {
                const url: string | null = await ctx.runQuery(internal.workspaceFiles.getFileDownloadUrlInternal, {
                    authId: user.id,
                    projectId: args.projectId,
                    nodeId: args.nodeId,
                    path: file.path,
                });
                if (!url) continue;
                const response = await fetch(url);
                if (!response.ok) continue;
                const bytes = new Uint8Array(await response.arrayBuffer());
                if (bytes.byteLength > 512 * 1024) continue;
                await uploadWorkspaceFile(workspace, {
                    path: file.path,
                    contentBase64: Buffer.from(bytes).toString("base64"),
                    contentType: response.headers.get("content-type") ?? undefined,
                });
                changed = true;
            }
            await ctx.runMutation(internal.workspaceFiles.removeForMigrationInternal, {
                authId: user.id,
                fileId: file._id,
            });
        }

        return changed ? await listWorkspaceFiles(workspace) : current;
    },
});

/** Lists files from the S3 namespace mounted by the selected runtime workspace. */
export const list = action({
    args: { projectId: v.id("projects"), workspaceId: v.string() },
    returns: v.array(fileEntry),
    handler: async (ctx, args) => {
        const workspace = await resolveWorkspace(ctx, args);

        return await listWorkspaceFiles(workspace);
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

        return await uploadWorkspaceFile(workspace, {
            path: args.path,
            contentBase64: args.contentBase64,
            contentType: args.contentType,
        });
    },
});

/** Deletes a file or folder prefix from the mounted S3 workspace. */
export const remove = action({
    args: { projectId: v.id("projects"), workspaceId: v.string(), path: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
        const workspace = await resolveWorkspace(ctx, args);
        await deleteWorkspacePath(workspace, args.path);

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
        await renameWorkspacePath(workspace, args.path, args.newPath);

        return null;
    },
});

/** Returns a short-lived S3 download URL for a mounted workspace file. */
export const getDownloadUrl = action({
    args: { projectId: v.id("projects"), workspaceId: v.string(), path: v.string() },
    returns: v.string(),
    handler: async (ctx, args) => {
        const workspace = await resolveWorkspace(ctx, args);
        return await workspaceFileDownloadUrl(workspace, args.path);
    },
});

async function resolveWorkspace(
    ctx: ActionCtx,
    args: { projectId: Id<"projects">; workspaceId: string },
): Promise<RuntimeWorkspace> {
    const user = await requireActionUser(ctx);
    const workspace: RuntimeWorkspace | null = await ctx.runQuery(internal.workspaceFiles.resolveRuntimeWorkspaceInternal, {
        authId: user.id,
        projectId: args.projectId,
        workspaceId: args.workspaceId,
    });
    if (!workspace) throw new Error("Workspace not found");

    return workspace;
}

async function listWorkspaceFiles(workspace: RuntimeWorkspace): Promise<Array<{
    path: string;
    name: string;
    isFolder: boolean;
    sizeBytes?: number;
    updatedAt?: string;
}>> {
    const prefix = workspacePrefix(workspace);
    const objects = await listS3Prefix(filesystemBucketName(), `${prefix}/`);
    const entries = new Map<string, {
        path: string;
        name: string;
        isFolder: boolean;
        sizeBytes?: number;
        updatedAt?: string;
    }>();

    for (const object of objects) {
        const path = object.key.slice(prefix.length + 1).replace(/\/$/, "");
        if (!path) continue;
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index += 1) {
            const folderPath = parts.slice(0, index).join("/");
            entries.set(folderPath, {
                path: folderPath,
                name: parts[index - 1]!,
                isFolder: true,
            });
        }
        const isFolder = object.key.endsWith("/");
        entries.set(path, {
            path: path,
            name: parts[parts.length - 1]!,
            isFolder: isFolder,
            ...(isFolder || object.size === undefined ? {} : { sizeBytes: object.size }),
            ...(object.lastModified ? { updatedAt: object.lastModified } : {}),
        });
    }

    return [...entries.values()];
}

async function uploadWorkspaceFile(
    workspace: RuntimeWorkspace,
    input: { path: unknown; contentBase64: unknown; contentType?: unknown },
): Promise<{
    path: string;
    name: string;
    isFolder: boolean;
    sizeBytes?: number;
}> {
    const path = normalizeFilePath(input.path);
    if (typeof input.contentBase64 !== "string") throw new Error("contentBase64 is required");
    const content = Buffer.from(input.contentBase64, "base64");
    if (content.byteLength > MAX_FILE_BYTES) throw new Error("Dashboard workspace uploads must not exceed 512 KiB");
    const key = `${workspacePrefix(workspace)}/${path}`;
    await ensureS3DirectoryMarkers(filesystemBucketName(), key);
    await writeS3Object(filesystemBucketName(), key, content, {
        ...(typeof input.contentType === "string" && input.contentType ? { contentType: input.contentType } : {}),
    });

    return {
        path: path,
        name: path.split("/").at(-1)!,
        isFolder: false,
        sizeBytes: content.byteLength,
    };
}

async function workspaceFileDownloadUrl(workspace: RuntimeWorkspace, rawPath: unknown): Promise<string> {
    const path = normalizeFilePath(rawPath);
    const key = `${workspacePrefix(workspace)}/${path}`;
    if (!await s3ObjectExists(filesystemBucketName(), key)) throw new Error("Workspace file not found");

    return await getS3ObjectUrl(filesystemBucketName(), key);
}

async function deleteWorkspacePath(workspace: RuntimeWorkspace, rawPath: unknown): Promise<number> {
    const path = normalizeFilePath(rawPath);
    const key = `${workspacePrefix(workspace)}/${path}`;
    const descendants = await deleteS3Prefix(filesystemBucketName(), `${key}/`);
    if (await s3ObjectExists(filesystemBucketName(), key)) {
        await deleteS3Object(filesystemBucketName(), key);

        return descendants + 1;
    }

    return descendants;
}

async function renameWorkspacePath(
    workspace: RuntimeWorkspace,
    rawPath: unknown,
    rawNewPath: unknown,
): Promise<number> {
    const path = normalizeFilePath(rawPath);
    const newPath = normalizeFilePath(rawNewPath);
    if (newPath === path || newPath.startsWith(`${path}/`)) throw new Error("Invalid destination path");
    const prefix = workspacePrefix(workspace);
    const sourceKey = `${prefix}/${path}`;
    const destinationKey = `${prefix}/${newPath}`;
    const exact = await s3ObjectExists(filesystemBucketName(), sourceKey);
    const descendants = await listS3Prefix(filesystemBucketName(), `${sourceKey}/`);
    if (!exact && descendants.length === 0) throw new Error("Workspace path not found");

    if (exact) {
        await ensureS3DirectoryMarkers(filesystemBucketName(), destinationKey);
        await copyS3Object(filesystemBucketName(), sourceKey, filesystemBucketName(), destinationKey);
    }
    for (const object of descendants) {
        const target = `${destinationKey}${object.key.slice(sourceKey.length)}`;
        await ensureS3DirectoryMarkers(filesystemBucketName(), target);
        await copyS3Object(filesystemBucketName(), object.key, filesystemBucketName(), target);
    }
    await Promise.all(descendants.map((object) => deleteS3Object(filesystemBucketName(), object.key)));
    if (exact) await deleteS3Object(filesystemBucketName(), sourceKey);

    return descendants.length + (exact ? 1 : 0);
}

function workspacePrefix(workspace: RuntimeWorkspace): string {
    return normalizeFilesystemNamespace(`${workspace.accountId}:${workspace.workspaceId}`);
}

function normalizeFilesystemNamespace(value: string): string {
    return `${FILESYSTEM_NAMESPACE_PREFIX}${hashScopedValue("filesystem-namespace", value)}`;
}

function hashScopedValue(scope: string, value: string): string {
    return createHash("sha256")
        .update(scope)
        .update("\0")
        .update(value)
        .digest("hex")
        .slice(0, HASH_HEX_LENGTH);
}

function normalizeFilePath(value: unknown): string {
    if (typeof value !== "string") throw new Error("path is required");
    const path = value.trim().replace(/^\/+|\/+$/g, "");
    const parts = path.split("/");
    if (!path || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
        throw new Error("Invalid workspace path");
    }

    return parts.join("/");
}

function filesystemBucketName(): string {
    const bucket = process.env.FILESYSTEM_BUCKET_NAME;
    if (!bucket) throw new Error("FILESYSTEM_BUCKET_NAME is required to manage workspace files");

    return bucket;
}
