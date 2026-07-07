/**
 * S3-backed workspace filesystem operations for the Convex config plane
 * (epic #85 phase 9). Shared by the dashboard actions (workspaceFilesPublic)
 * and the public config HTTP surface (awsWorkspaceFiles). Namespaces and
 * limits match core's workdir mount exactly. Node-runtime only — import
 * exclusively from `"use node"` actions.
 */

import {
    copyS3Object,
    deleteS3Object,
    deleteS3Prefix,
    ensureS3DirectoryMarkers,
    getS3ObjectUrl,
    listS3Prefix,
    s3ObjectExists,
    writeS3Object,
} from "./s3";
import { workspaceNamespace } from "./workspaceRules";

export const MAX_WORKSPACE_FILE_BYTES = 512 * 1024;

/**
 * One listed workspace file or synthesized folder entry.
 */
export interface WorkspaceFileEntry {
    path: string;
    name: string;
    isFolder: boolean;
    sizeBytes?: number;
    updatedAt?: string;
}

/**
 * List files and folders under a workspace's S3 namespace.
 * @param accountId account owning the workspace
 * @param workspaceId the workspace config id
 * @returns files plus synthesized parent folders
 */
export async function listWorkspaceFiles(accountId: string, workspaceId: string): Promise<WorkspaceFileEntry[]> {
    const prefix = await workspacePrefix(accountId, workspaceId);
    const objects = await listS3Prefix(filesystemBucketName(), `${prefix}/`);
    const entries = new Map<string, WorkspaceFileEntry>();

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

/**
 * Upload or replace one file in a workspace's S3 namespace.
 * @param accountId account owning the workspace
 * @param workspaceId the workspace config id
 * @param input file path, base64 contents, and optional content type
 * @returns the stored file entry
 * @throws when the path is invalid or the file exceeds the size limit
 */
export async function uploadWorkspaceFile(
    accountId: string,
    workspaceId: string,
    input: { path: unknown; contentBase64: unknown; contentType?: unknown },
): Promise<WorkspaceFileEntry> {
    const path = normalizeFilePath(input.path);
    if (typeof input.contentBase64 !== "string") throw new Error("contentBase64 is required");
    const content = Buffer.from(input.contentBase64, "base64");
    if (content.byteLength > MAX_WORKSPACE_FILE_BYTES) throw new Error("Workspace uploads must not exceed 512 KiB");
    const key = `${await workspacePrefix(accountId, workspaceId)}/${path}`;
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

/**
 * Presign a short-lived download URL for one workspace file.
 * @param accountId account owning the workspace
 * @param workspaceId the workspace config id
 * @param rawPath the file path
 * @returns a presigned S3 GET URL
 * @throws when the file does not exist
 */
export async function workspaceFileDownloadUrl(accountId: string, workspaceId: string, rawPath: unknown): Promise<string> {
    const path = normalizeFilePath(rawPath);
    const key = `${await workspacePrefix(accountId, workspaceId)}/${path}`;
    if (!await s3ObjectExists(filesystemBucketName(), key)) throw new Error("Workspace file not found");

    return await getS3ObjectUrl(filesystemBucketName(), key);
}

/**
 * Delete a file or folder prefix from a workspace's S3 namespace.
 * @param accountId account owning the workspace
 * @param workspaceId the workspace config id
 * @param rawPath the file or folder path
 * @returns the number of objects deleted
 */
export async function deleteWorkspacePath(accountId: string, workspaceId: string, rawPath: unknown): Promise<number> {
    const path = normalizeFilePath(rawPath);
    const key = `${await workspacePrefix(accountId, workspaceId)}/${path}`;
    const descendants = await deleteS3Prefix(filesystemBucketName(), `${key}/`);
    if (await s3ObjectExists(filesystemBucketName(), key)) {
        await deleteS3Object(filesystemBucketName(), key);

        return descendants + 1;
    }

    return descendants;
}

/**
 * Delete every object under a workspace's managed S3 namespace.
 * @param accountId account owning the workspace
 * @param workspaceId workspace config id
 * @returns the number of objects deleted
 */
export async function purgeWorkspaceFilesystem(accountId: string, workspaceId: string): Promise<number> {
    return await deleteS3Prefix(filesystemBucketName(), await workspacePrefix(accountId, workspaceId));
}

/**
 * Rename a file or folder prefix inside a workspace's S3 namespace.
 * @param accountId account owning the workspace
 * @param workspaceId the workspace config id
 * @param rawPath the source path
 * @param rawNewPath the destination path
 * @returns the number of objects moved
 * @throws when the source is missing or the destination is inside the source
 */
export async function renameWorkspacePath(
    accountId: string,
    workspaceId: string,
    rawPath: unknown,
    rawNewPath: unknown,
): Promise<number> {
    const path = normalizeFilePath(rawPath);
    const newPath = normalizeFilePath(rawNewPath);
    if (newPath === path || newPath.startsWith(`${path}/`)) throw new Error("Invalid destination path");
    const prefix = await workspacePrefix(accountId, workspaceId);
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

/**
 * Derive the hashed S3 namespace prefix for a workspace, matching core.
 * The derivation lives in workspaceRules (any-runtime) so configHttp can
 * compute reservation-key namespaces without pulling in this module's S3 deps.
 * @param accountId account owning the workspace
 * @param workspaceId the workspace config id
 * @returns the `fs-…` namespace prefix
 */
async function workspacePrefix(accountId: string, workspaceId: string): Promise<string> {
    return await workspaceNamespace(accountId, workspaceId);
}

/**
 * Validate and normalize a workspace-relative file path.
 * @param value candidate path
 * @returns the normalized path
 * @throws when the path is empty or contains traversal segments
 */
export function normalizeFilePath(value: unknown): string {
    if (typeof value !== "string") throw new Error("path is required");
    const path = value.trim().replace(/^\/+|\/+$/g, "");
    const parts = path.split("/");
    if (!path || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
        throw new Error("Invalid workspace path");
    }

    return parts.join("/");
}

/**
 * Read the filesystem bucket name from the Convex deployment environment.
 * @returns the bucket name
 * @throws when FILESYSTEM_BUCKET_NAME is not configured
 */
export function filesystemBucketName(): string {
    const bucket = process.env.FILESYSTEM_BUCKET_NAME;
    if (!bucket) throw new Error("FILESYSTEM_BUCKET_NAME is required to manage workspace files");

    return bucket;
}
