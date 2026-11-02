// Node runtime only ("use node" actions). Metadata must match core's src/shared/s3.ts.

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, type S3Access } from "./aws";

// The workdir FUSE mount presents these to the sandbox guest as file owner and group.
const SANDBOX_GID = "990";
const SANDBOX_UID = "993";
const RETRYABLE_DELETE_CODES = new Set([
  "InternalError",
  "ServiceUnavailable",
  "SlowDown",
]);
const DELETE_ATTEMPTS = 3;

export interface S3ObjectInfo {
  key: string;
  size?: number;
  lastModified?: string;
  etag?: string;
}

export async function copyS3Object(
  sourceBucket: string,
  sourceKey: string,
  destinationBucket: string,
  destinationKey: string,
  options: { contentType?: string; executable?: boolean } = {},
  access?: S3Access,
): Promise<void> {
  const client = await s3Client(access);
  await client.send(
    new CopyObjectCommand({
      Bucket: destinationBucket,
      Key: destinationKey,
      CopySource: `${sourceBucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, "/")}`,
      MetadataDirective: "REPLACE",
      Metadata: posixMetadata(
        destinationKey.endsWith("/") ? "directory" : "file",
        options.executable === true,
      ),
      ...(options.contentType ? { ContentType: options.contentType } : {}),
    }),
  );
}

export async function deleteS3Object(
  bucket: string,
  key: string,
  access?: S3Access,
): Promise<void> {
  const client = await s3Client(access);
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function deleteS3Prefix(
  bucket: string,
  prefix: string,
  access?: S3Access,
): Promise<number> {
  const client = await s3Client(access);
  let deleted = 0;
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );
    let keys = (page.Contents ?? []).flatMap((item) =>
      item.Key ? [item.Key] : [],
    );
    const pageSize = keys.length;
    for (let attempt = 1; keys.length > 0; attempt += 1) {
      if (attempt > 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
      const { Errors: errors = [] } = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true },
        }),
      );
      const [first] = errors;
      if (
        first &&
        (attempt === DELETE_ATTEMPTS ||
          errors.some(
            (error) =>
              !error.Key || !RETRYABLE_DELETE_CODES.has(error.Code ?? ""),
          ))
      ) {
        throw new Error(
          `S3 could not delete ${errors.length} of ${pageSize} objects under ${prefix} in ${bucket}, first ${first.Key}: ${first.Code} ${first.Message ?? ""}`.trim(),
        );
      }
      keys = errors.flatMap((error) => (error.Key ? [error.Key] : []));
    }
    deleted += pageSize;
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);

  return deleted;
}

export async function ensureS3DirectoryMarkers(
  bucket: string,
  key: string,
  access?: S3Access,
): Promise<void> {
  const parts = key.split("/").filter(Boolean);
  parts.pop();

  let prefix = "";
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    await writeS3Object(
      bucket,
      `${prefix}/`,
      "",
      { contentType: "application/x-directory" },
      access,
    );
  }
}

export async function getS3ObjectUrl(
  bucket: string,
  key: string,
  options: { expiresInSeconds?: number } = {},
  access?: S3Access,
): Promise<string> {
  const client = await s3Client(access);

  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    {
      expiresIn: options.expiresInSeconds ?? 300,
    },
  );
}

export function isMissingS3Error(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    name?: string;
    code?: string;
    Code?: string;
    status?: number;
    $metadata?: { httpStatusCode?: number };
  };

  return (
    candidate.name === "NoSuchKey" ||
    candidate.name === "NotFound" ||
    (candidate.name === "S3Error" && candidate.status === 404) ||
    candidate.code === "NoSuchKey" ||
    candidate.Code === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

export async function listS3Prefix(
  bucket: string,
  prefix: string,
  access?: S3Access,
): Promise<S3ObjectInfo[]> {
  const client = await s3Client(access);
  const objects: S3ObjectInfo[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );

    for (const item of result.Contents ?? []) {
      if (!item.Key) {
        continue;
      }
      objects.push({
        key: item.Key,
        ...(item.Size !== undefined ? { size: item.Size } : {}),
        ...(item.LastModified !== undefined
          ? { lastModified: item.LastModified.toISOString() }
          : {}),
        ...(item.ETag !== undefined
          ? { etag: item.ETag.replace(/^"|"$/g, "") }
          : {}),
      });
    }

    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  return objects;
}

export async function readS3Bytes(
  bucket: string,
  key: string,
  access?: S3Access,
): Promise<Uint8Array> {
  const client = await s3Client(access);
  const result = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!result.Body) {
    throw new Error(`S3 object has no body: ${key}`);
  }

  return result.Body.transformToByteArray();
}

export async function readS3Text(bucket: string, key: string): Promise<string> {
  return new TextDecoder().decode(await readS3Bytes(bucket, key));
}

export async function s3ObjectExists(
  bucket: string,
  key: string,
  access?: S3Access,
): Promise<boolean> {
  return (await s3ObjectSize(bucket, key, access)) !== null;
}

export async function s3ObjectSize(
  bucket: string,
  key: string,
  access?: S3Access,
): Promise<number | null> {
  const client = await s3Client(access);
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );

    return head.ContentLength ?? 0;
  } catch (err) {
    if (isMissingS3Error(err)) {
      return null;
    }
    throw err;
  }
}

export async function writeS3Object(
  bucket: string,
  key: string,
  body: string | Uint8Array,
  options: { contentType?: string; executable?: boolean } = {},
  access?: S3Access,
): Promise<number> {
  const size = typeof body === "string" ? body.length : body.byteLength;
  const client = await s3Client(access);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ...(options.contentType ? { ContentType: options.contentType } : {}),
      Metadata: posixMetadata(
        key.endsWith("/") ? "directory" : "file",
        options.executable === true,
      ),
    }),
  );

  return size;
}

function posixMetadata(
  kind: "file" | "directory",
  executable = false,
): Record<string, string> {
  const now = `${Date.now()}000000ns`;

  return {
    "file-owner": SANDBOX_UID,
    "file-group": SANDBOX_GID,
    "file-permissions":
      kind === "directory" ? "0040777" : executable ? "0100777" : "0100666",
    "file-atime": now,
    "file-mtime": now,
  };
}
