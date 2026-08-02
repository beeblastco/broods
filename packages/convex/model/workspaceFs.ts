/**
 * S3-backed workspace filesystem operations for the Convex config plane
 * (epic #85 phase 9). Shared by the dashboard actions (workspaceFilesPublic)
 * and the public config HTTP surface (awsWorkspaceFiles). Buckets, namespaces
 * and limits match core's workdir mount exactly — including a workspace that
 * brings its own bucket. Node-runtime only — import exclusively from
 * `"use node"` actions.
 */

import { assumeScopedS3Credentials, type S3Access } from "./aws";
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
import {
  workspaceNamespace,
  type WorkspaceStorageConfig,
} from "./workspaceRules";

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
 * A workspace to operate on. `storage` is the workspace's own `config.storage`;
 * omitting it means the managed bucket, exactly like core's default.
 */
export interface WorkspaceFsRef {
  accountId: string;
  workspaceId: string;
  storage?: WorkspaceStorageConfig;
}

/**
 * Where a workspace's files actually live: bucket, key prefix (trailing slash,
 * possibly empty) and the access needed to reach them.
 */
interface WorkspaceFsTarget {
  bucket: string;
  prefix: string;
  access?: S3Access;
}

/**
 * List files and folders under a workspace's S3 namespace.
 * @param ref the workspace to read
 * @returns files plus synthesized parent folders
 */
export async function listWorkspaceFiles(
  ref: WorkspaceFsRef,
): Promise<WorkspaceFileEntry[]> {
  const target = await resolveTarget(ref);
  const objects = await listS3Prefix(
    target.bucket,
    target.prefix,
    target.access,
  );
  const entries = new Map<string, WorkspaceFileEntry>();

  for (const object of objects) {
    const path = object.key.slice(target.prefix.length).replace(/\/$/, "");
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
      ...(isFolder || object.size === undefined
        ? {}
        : { sizeBytes: object.size }),
      ...(object.lastModified ? { updatedAt: object.lastModified } : {}),
    });
  }

  return [...entries.values()];
}

/**
 * Upload or replace one file in a workspace's S3 namespace.
 * @param ref the workspace to write to
 * @param input file path, base64 contents, and optional content type
 * @returns the stored file entry
 * @throws when the path is invalid or the file exceeds the size limit
 */
export async function uploadWorkspaceFile(
  ref: WorkspaceFsRef,
  input: { path: unknown; contentBase64: unknown; contentType?: unknown },
): Promise<WorkspaceFileEntry> {
  const path = normalizeFilePath(input.path);
  if (typeof input.contentBase64 !== "string")
    throw new Error("contentBase64 is required");
  const content = Buffer.from(input.contentBase64, "base64");
  if (content.byteLength > MAX_WORKSPACE_FILE_BYTES)
    throw new Error("Workspace uploads must not exceed 512 KiB");
  const target = await resolveTarget(ref);
  const key = `${target.prefix}${path}`;
  await ensureS3DirectoryMarkers(target.bucket, key, target.access);
  await writeS3Object(
    target.bucket,
    key,
    content,
    {
      ...(typeof input.contentType === "string" && input.contentType
        ? { contentType: input.contentType }
        : {}),
    },
    target.access,
  );

  return {
    path: path,
    name: path.split("/").at(-1)!,
    isFolder: false,
    sizeBytes: content.byteLength,
  };
}

/**
 * Presign a short-lived download URL for one workspace file.
 * @param ref the workspace to read
 * @param rawPath the file path
 * @returns a presigned S3 GET URL
 * @throws when the file does not exist
 */
export async function workspaceFileDownloadUrl(
  ref: WorkspaceFsRef,
  rawPath: unknown,
): Promise<string> {
  const path = normalizeFilePath(rawPath);
  const target = await resolveTarget(ref);
  const key = `${target.prefix}${path}`;
  if (!(await s3ObjectExists(target.bucket, key, target.access)))
    throw new Error("Workspace file not found");

  return await getS3ObjectUrl(target.bucket, key, {}, target.access);
}

/**
 * Delete a file or folder prefix from a workspace's S3 namespace.
 * @param ref the workspace to write to
 * @param rawPath the file or folder path
 * @returns the number of objects deleted
 */
export async function deleteWorkspacePath(
  ref: WorkspaceFsRef,
  rawPath: unknown,
): Promise<number> {
  const path = normalizeFilePath(rawPath);
  const target = await resolveTarget(ref);
  const key = `${target.prefix}${path}`;
  const descendants = await deleteS3Prefix(
    target.bucket,
    `${key}/`,
    target.access,
  );
  if (await s3ObjectExists(target.bucket, key, target.access)) {
    await deleteS3Object(target.bucket, key, target.access);

    return descendants + 1;
  }

  return descendants;
}

/**
 * Delete every object under a workspace's S3 namespace.
 * @param ref the workspace to purge
 * @returns the number of objects deleted
 */
export async function purgeWorkspaceFilesystem(
  ref: WorkspaceFsRef,
): Promise<number> {
  const target = await resolveTarget(ref);
  // A bring-your-own bucket with no prefix resolves to the whole bucket, and this
  // is a recursive delete. Refuse rather than trust every future caller to check.
  if (!target.prefix) {
    throw new Error(
      "Refusing to purge a workspace bucket without a key prefix",
    );
  }

  return await deleteS3Prefix(target.bucket, target.prefix, target.access);
}

/**
 * Rename a file or folder prefix inside a workspace's S3 namespace.
 * @param ref the workspace to write to
 * @param rawPath the source path
 * @param rawNewPath the destination path
 * @returns the number of objects moved
 * @throws when the source is missing or the destination is inside the source
 */
export async function renameWorkspacePath(
  ref: WorkspaceFsRef,
  rawPath: unknown,
  rawNewPath: unknown,
): Promise<number> {
  const path = normalizeFilePath(rawPath);
  const newPath = normalizeFilePath(rawNewPath);
  if (newPath === path || newPath.startsWith(`${path}/`))
    throw new Error("Invalid destination path");
  const target = await resolveTarget(ref);
  const sourceKey = `${target.prefix}${path}`;
  const destinationKey = `${target.prefix}${newPath}`;
  const exact = await s3ObjectExists(target.bucket, sourceKey, target.access);
  const descendants = await listS3Prefix(
    target.bucket,
    `${sourceKey}/`,
    target.access,
  );
  if (!exact && descendants.length === 0)
    throw new Error("Workspace path not found");

  if (exact) {
    await ensureS3DirectoryMarkers(
      target.bucket,
      destinationKey,
      target.access,
    );
    await copyS3Object(
      target.bucket,
      sourceKey,
      target.bucket,
      destinationKey,
      {},
      target.access,
    );
  }
  for (const object of descendants) {
    const moved = `${destinationKey}${object.key.slice(sourceKey.length)}`;
    await ensureS3DirectoryMarkers(target.bucket, moved, target.access);
    await copyS3Object(
      target.bucket,
      object.key,
      target.bucket,
      moved,
      {},
      target.access,
    );
  }
  await Promise.all(
    descendants.map((object) =>
      deleteS3Object(target.bucket, object.key, target.access),
    ),
  );
  if (exact) await deleteS3Object(target.bucket, sourceKey, target.access);

  return descendants.length + (exact ? 1 : 0);
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
  if (
    !path ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  )
    throw new Error("Invalid workspace file path");

  return path;
}

/**
 * Read the filesystem bucket name from the Convex deployment environment.
 * @returns the bucket name
 * @throws when the variable is unset
 */
export function filesystemBucketName(): string {
  const bucket = process.env.FILESYSTEM_BUCKET_NAME;
  if (!bucket)
    throw new Error(
      "Workspace filesystem requires FILESYSTEM_BUCKET_NAME in the Convex deployment environment",
    );

  return bucket;
}

/**
 * Resolve where a workspace's files live, mirroring core's
 * `resolveS3MountIdentity` / `resolveS3ReadTarget`: the managed bucket is
 * partitioned by hashed namespace and read on the config plane's own role, while
 * a bring-your-own bucket uses its own prefix and a scoped session on its role.
 * The runtime per-conversation isolation suffix is deliberately not applied — the
 * dashboard shows the workspace's base namespace, as it always has.
 * @param ref the workspace to resolve
 * @returns the bucket, key prefix and access to reach it
 */
async function resolveTarget(ref: WorkspaceFsRef): Promise<WorkspaceFsTarget> {
  const storage = ref.storage;
  if (!storage?.bucket) {
    const namespace = await workspaceNamespace(ref.accountId, ref.workspaceId);

    return { bucket: filesystemBucketName(), prefix: `${namespace}/` };
  }
  const prefix = normalizePrefix(storage.prefix);
  const roleArn =
    storage.auth?.type === "assumeRole" ? storage.auth.roleArn : undefined;
  const credentials = roleArn
    ? await assumeScopedS3Credentials({
        roleArn: roleArn,
        bucket: storage.bucket,
        prefix: prefix,
        ...(storage.auth?.type === "assumeRole" && storage.auth.externalId
          ? { externalId: storage.auth.externalId }
          : {}),
      })
    : undefined;

  return {
    bucket: storage.bucket,
    prefix: prefix,
    access: {
      ...(credentials ? { credentials: credentials } : {}),
      ...(storage.region ? { region: storage.region } : {}),
      ...(storage.endpoint ? { endpoint: storage.endpoint } : {}),
    },
  };
}

function normalizePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "").replace(/^\/+/, "").replace(/\/+$/, "");

  return trimmed.length > 0 ? `${trimmed}/` : "";
}
