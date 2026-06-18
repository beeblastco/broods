/**
 * S3-backed workspace file operations for the account-management API.
 * These keys share the exact namespace mounted by runtime sandboxes.
 */

import { requireEnv } from "../_shared/env.ts";
import {
  copyS3Object,
  deleteS3Object,
  deleteS3Prefix,
  ensureS3DirectoryMarkers,
  getS3ObjectUrl,
  listS3Prefix,
  s3ObjectExists,
  writeS3Object,
} from "../_shared/s3.ts";
import { workspaceNamespacePrefix } from "../_shared/sandbox.ts";
import { workspaceNamespace } from "../_shared/workspaces.ts";

// Dashboard uploads cross a Convex action as base64. Keep the encoded request
// comfortably below Convex's 1 MB value limit.
const MAX_FILE_BYTES = 512 * 1024;

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  isFolder: boolean;
  sizeBytes?: number;
  updatedAt?: string;
}

export async function listWorkspaceFiles(accountId: string, workspaceId: string): Promise<WorkspaceFileEntry[]> {
  const prefix = workspacePrefix(accountId, workspaceId);
  const objects = await listS3Prefix(bucketName(), `${prefix}/`);
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
      name: parts.at(-1)!,
      isFolder: isFolder,
      ...(isFolder || object.size === undefined ? {} : { sizeBytes: object.size }),
      ...(object.lastModified ? { updatedAt: object.lastModified } : {}),
    });
  }

  return [...entries.values()];
}

export async function uploadWorkspaceFile(
  accountId: string,
  workspaceId: string,
  input: { path: unknown; contentBase64: unknown; contentType?: unknown },
): Promise<WorkspaceFileEntry> {
  const path = normalizeFilePath(input.path);
  if (typeof input.contentBase64 !== "string") throw new Error("contentBase64 is required");
  const content = Buffer.from(input.contentBase64, "base64");
  if (content.byteLength > MAX_FILE_BYTES) throw new Error("Dashboard workspace uploads must not exceed 512 KiB");
  const key = `${workspacePrefix(accountId, workspaceId)}/${path}`;
  await ensureS3DirectoryMarkers(bucketName(), key);
  await writeS3Object(bucketName(), key, content, {
    ...(typeof input.contentType === "string" && input.contentType ? { contentType: input.contentType } : {}),
  });

  return {
    path: path,
    name: path.split("/").at(-1)!,
    isFolder: false,
    sizeBytes: content.byteLength,
  };
}

export async function workspaceFileDownloadUrl(accountId: string, workspaceId: string, rawPath: unknown): Promise<string> {
  const path = normalizeFilePath(rawPath);
  const key = `${workspacePrefix(accountId, workspaceId)}/${path}`;
  if (!await s3ObjectExists(bucketName(), key)) throw new Error("Workspace file not found");
  return getS3ObjectUrl(bucketName(), key);
}

export async function deleteWorkspacePath(accountId: string, workspaceId: string, rawPath: unknown): Promise<number> {
  const path = normalizeFilePath(rawPath);
  const key = `${workspacePrefix(accountId, workspaceId)}/${path}`;
  const descendants = await deleteS3Prefix(bucketName(), `${key}/`);
  if (await s3ObjectExists(bucketName(), key)) {
    await deleteS3Object(bucketName(), key);
    return descendants + 1;
  }
  return descendants;
}

export async function renameWorkspacePath(
  accountId: string,
  workspaceId: string,
  rawPath: unknown,
  rawNewPath: unknown,
): Promise<number> {
  const path = normalizeFilePath(rawPath);
  const newPath = normalizeFilePath(rawNewPath);
  if (newPath === path || newPath.startsWith(`${path}/`)) throw new Error("Invalid destination path");
  const prefix = workspacePrefix(accountId, workspaceId);
  const sourceKey = `${prefix}/${path}`;
  const destinationKey = `${prefix}/${newPath}`;
  const exact = await s3ObjectExists(bucketName(), sourceKey);
  const descendants = await listS3Prefix(bucketName(), `${sourceKey}/`);
  if (!exact && descendants.length === 0) throw new Error("Workspace path not found");

  if (exact) {
    await ensureS3DirectoryMarkers(bucketName(), destinationKey);
    await copyS3Object(bucketName(), sourceKey, bucketName(), destinationKey);
  }
  for (const object of descendants) {
    const target = `${destinationKey}${object.key.slice(sourceKey.length)}`;
    await ensureS3DirectoryMarkers(bucketName(), target);
    await copyS3Object(bucketName(), object.key, bucketName(), target);
  }
  await Promise.all(descendants.map((object) => deleteS3Object(bucketName(), object.key)));
  if (exact) await deleteS3Object(bucketName(), sourceKey);
  return descendants.length + (exact ? 1 : 0);
}

function workspacePrefix(accountId: string, workspaceId: string): string {
  return workspaceNamespacePrefix(workspaceNamespace(accountId, workspaceId));
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

function bucketName(): string {
  return requireEnv("FILESYSTEM_BUCKET_NAME");
}
