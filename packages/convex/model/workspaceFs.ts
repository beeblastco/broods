// Buckets, namespaces and limits match core's workdir mount, own buckets included.
// Node runtime only: import from `"use node"` actions alone.

import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { assumeScopedS3Credentials, type S3Access } from "./aws";
import {
  copyS3Object,
  deleteS3Object,
  deleteS3Prefix,
  ensureS3DirectoryMarkers,
  getS3ObjectUrl,
  listS3Prefix,
  readS3Bytes,
  s3ObjectExists,
  s3ObjectSize,
  writeS3Object,
} from "./s3";
import {
  MAX_WORKSPACE_FILE_BYTES,
  normalizeFilePath,
  normalizeWorkspacePrefix,
  workspaceNamespace,
  workspaceStorageOwnAuth,
  type WorkspaceStorageConfig,
} from "./workspaceRules";
import { ClientError } from "./clientError";

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  isFolder: boolean;
  sizeBytes?: number;
  updatedAt?: string;
}

export interface WorkspaceFsRef {
  accountId: string;
  workspaceId: string;
  storage?: WorkspaceStorageConfig;
  r2Credentials?: S3Access["credentials"];
  externalId?: string;
}

interface WorkspaceFsTarget {
  bucket: string;
  prefix: string;
  access?: S3Access;
}

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

export function filesystemBucketName(): string {
  const bucket = process.env.FILESYSTEM_BUCKET_NAME;
  if (!bucket)
    throw new Error(
      "Workspace filesystem requires FILESYSTEM_BUCKET_NAME in the Convex deployment environment",
    );

  return bucket;
}

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

export async function purgeWorkspaceFilesystem(
  ref: WorkspaceFsRef,
): Promise<number> {
  const target = await resolveTarget(ref);
  // An own bucket with no prefix is the whole bucket: never recursive-delete it.
  if (!target.prefix) {
    throw new Error(
      "Refusing to purge a workspace bucket without a key prefix",
    );
  }

  return await deleteS3Prefix(target.bucket, target.prefix, target.access);
}

// Read here, not through a presigned URL, so the bucket needs no CORS rule for the dashboard.
export async function readWorkspaceFile(
  ref: WorkspaceFsRef,
  rawPath: unknown,
): Promise<string> {
  const path = normalizeFilePath(rawPath);
  const target = await resolveTarget(ref);
  const key = `${target.prefix}${path}`;
  // Sized first, so a multi-gigabyte file is refused without pulling it into memory.
  const size = await s3ObjectSize(target.bucket, key, target.access);
  if (size === null) throw new ClientError("Workspace file not found");
  if (size > MAX_WORKSPACE_FILE_BYTES)
    throw new ClientError("Workspace files over 512 KiB cannot be previewed");

  return new TextDecoder().decode(
    await readS3Bytes(target.bucket, key, target.access),
  );
}

export async function renameWorkspacePath(
  ref: WorkspaceFsRef,
  rawPath: unknown,
  rawNewPath: unknown,
): Promise<number> {
  const path = normalizeFilePath(rawPath);
  const newPath = normalizeFilePath(rawNewPath);
  if (newPath === path || newPath.startsWith(`${path}/`))
    throw new ClientError("Invalid destination path");
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
    throw new ClientError("Workspace path not found");

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

export async function uploadWorkspaceFile(
  ref: WorkspaceFsRef,
  input: { path: unknown; contentBase64: unknown; contentType?: unknown },
): Promise<WorkspaceFileEntry> {
  const path = normalizeFilePath(input.path);
  if (typeof input.contentBase64 !== "string")
    throw new ClientError("contentBase64 is required");
  const content = Buffer.from(input.contentBase64, "base64");
  if (content.byteLength > MAX_WORKSPACE_FILE_BYTES)
    throw new ClientError("Workspace uploads must not exceed 512 KiB");
  const target = await resolveTarget(ref);
  const key = `${target.prefix}${path}`;
  await ensureS3DirectoryMarkers(target.bucket, key, target.access);
  await writeS3Object(
    target.bucket,
    key,
    content,
    typeof input.contentType === "string" && input.contentType
      ? { contentType: input.contentType }
      : {},
    target.access,
  );

  return {
    path: path,
    name: path.split("/").at(-1)!,
    isFolder: false,
    sizeBytes: content.byteLength,
  };
}

// Every action calls this before an op: only a ctx can mint R2 keys or read the external id.
export async function withStorageAccess<Ref extends WorkspaceFsRef>(
  ctx: ActionCtx,
  ref: Ref,
): Promise<Ref> {
  if (ref.storage?.auth?.type === "assumeRole") {
    return {
      ...ref,
      externalId: await ctx.runMutation(
        internal.account.storageTrust.externalId,
        { accountId: ref.accountId },
      ),
    };
  }
  if (ref.storage?.auth?.type !== "r2") return ref;
  const credentials = await ctx.runMutation(
    internal.workspace.configs.r2Credentials,
    {
      accountId: ref.accountId,
      workspaceId: ref.workspaceId,
      prefix: normalizeWorkspacePrefix(ref.storage.prefix),
    },
  );

  return {
    ...ref,
    r2Credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  };
}

export async function workspaceFileDownloadUrl(
  ref: WorkspaceFsRef,
  rawPath: unknown,
): Promise<string> {
  const path = normalizeFilePath(rawPath);
  const target = await resolveTarget(ref);
  const key = `${target.prefix}${path}`;
  if (!(await s3ObjectExists(target.bucket, key, target.access)))
    throw new ClientError("Workspace file not found");

  return await getS3ObjectUrl(target.bucket, key, {}, target.access);
}

// Mirrors core's resolveS3ReadTarget, without the per-conversation isolation suffix.
async function resolveTarget(ref: WorkspaceFsRef): Promise<WorkspaceFsTarget> {
  const storage = ref.storage;
  if (!storage?.bucket) {
    const namespace = await workspaceNamespace(ref.accountId, ref.workspaceId);

    return { bucket: filesystemBucketName(), prefix: `${namespace}/` };
  }
  const auth = workspaceStorageOwnAuth(storage);
  if (!auth) throw new Error("Workspace storage has no credentials of its own");
  const prefix = normalizeWorkspacePrefix(storage.prefix);
  let credentials = ref.r2Credentials;
  if (auth.type === "assumeRole") {
    if (!ref.externalId)
      throw new Error("Workspace storage external id was not attached");
    credentials = await assumeScopedS3Credentials({
      roleArn: auth.roleArn,
      bucket: storage.bucket,
      prefix: prefix,
      externalId: ref.externalId,
    });
  }
  if (!credentials)
    throw new Error("Workspace storage credentials were not minted");
  const region = auth.type === "r2" ? "auto" : storage.region;

  return {
    bucket: storage.bucket,
    prefix: prefix,
    access: {
      credentials: credentials,
      ...(region ? { region: region } : {}),
      ...(storage.endpoint ? { endpoint: storage.endpoint } : {}),
    },
  };
}
