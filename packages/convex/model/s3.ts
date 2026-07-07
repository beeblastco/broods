/**
 * S3 primitives for the Convex config plane (epic #85 phase 9). A faithful port
 * of apps/core `src/shared/s3.ts` so objects written here are byte- and
 * metadata-compatible with what core's FUSE mount and skill loader read.
 * Uses the assumed-role client from model/aws.ts. Node-runtime only — import
 * exclusively from `"use node"` actions.
 */

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client } from "./aws";

/**
 * A single S3 object's listing metadata.
 */
export interface S3ObjectInfo {
  key: string;
  size?: number;
  lastModified?: string;
  etag?: string;
}

// Match core's posix metadata exactly: the workdir FUSE mount reads these to
// present owner/group/permissions to the sandbox guest (uid 993 / gid 990).
const SANDBOX_UID = "993";
const SANDBOX_GID = "990";

/**
 * Build the posix ownership/permission metadata core stamps on every object.
 * @param kind whether the key is a directory marker or a file
 * @param executable whether a file should be world-executable
 * @returns the S3 user-metadata map
 */
function posixMetadata(kind: "file" | "directory", executable = false): Record<string, string> {
  const now = `${Date.now()}000000ns`;

  return {
    "file-owner": SANDBOX_UID,
    "file-group": SANDBOX_GID,
    "file-permissions": kind === "directory" ? "0040777" : executable ? "0100777" : "0100666",
    "file-atime": now,
    "file-mtime": now,
  };
}

/**
 * Write an object with core-compatible posix metadata.
 * @param bucket target bucket
 * @param key object key
 * @param body string or bytes to store
 * @param options content type and executable flag
 * @returns the byte size written
 */
export async function writeS3Object(
  bucket: string,
  key: string,
  body: string | Uint8Array,
  options: { contentType?: string; executable?: boolean } = {},
): Promise<number> {
  const size = typeof body === "string" ? body.length : body.byteLength;
  const client = await s3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ...(options.contentType ? { ContentType: options.contentType } : {}),
      Metadata: posixMetadata(key.endsWith("/") ? "directory" : "file", options.executable === true),
    }),
  );

  return size;
}

/**
 * Copy an object while replacing metadata with core-compatible posix metadata.
 * @param sourceBucket source bucket
 * @param sourceKey source object key
 * @param destinationBucket destination bucket
 * @param destinationKey destination object key
 * @param options content type and executable flag
 */
export async function copyS3Object(
  sourceBucket: string,
  sourceKey: string,
  destinationBucket: string,
  destinationKey: string,
  options: { contentType?: string; executable?: boolean } = {},
): Promise<void> {
  const client = await s3Client();
  await client.send(
    new CopyObjectCommand({
      Bucket: destinationBucket,
      Key: destinationKey,
      CopySource: `${sourceBucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, "/")}`,
      MetadataDirective: "REPLACE",
      Metadata: posixMetadata(destinationKey.endsWith("/") ? "directory" : "file", options.executable === true),
      ...(options.contentType ? { ContentType: options.contentType } : {}),
    }),
  );
}

/**
 * Ensure S3 directory marker objects exist for every parent directory of a key.
 * @param bucket target bucket
 * @param key file key whose parent directories should exist
 */
export async function ensureS3DirectoryMarkers(bucket: string, key: string): Promise<void> {
  const parts = key.split("/").filter(Boolean);
  parts.pop();

  let prefix = "";
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    await writeS3Object(bucket, `${prefix}/`, "", {
      contentType: "application/x-directory",
    });
  }
}

/**
 * Read an object's raw bytes.
 * @param bucket source bucket
 * @param key object key
 * @returns the object body as bytes
 * @throws when the object has no body
 */
export async function readS3Bytes(bucket: string, key: string): Promise<Uint8Array> {
  const client = await s3Client();
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) {
    throw new Error(`S3 object has no body: ${key}`);
  }

  return result.Body.transformToByteArray();
}

/**
 * Read an object as UTF-8 text.
 * @param bucket source bucket
 * @param key object key
 * @returns the object body decoded as text
 */
export async function readS3Text(bucket: string, key: string): Promise<string> {
  const client = await s3Client();
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) {
    throw new Error(`S3 object has no body: ${key}`);
  }

  return result.Body.transformToString();
}

/**
 * Presign a time-limited GET URL for an object.
 * @param bucket source bucket
 * @param key object key
 * @param options expiry in seconds (default 300)
 * @returns a presigned download URL
 */
export async function getS3ObjectUrl(
  bucket: string,
  key: string,
  options: { expiresInSeconds?: number } = {},
): Promise<string> {
  const client = await s3Client();

  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: options.expiresInSeconds ?? 300,
  });
}

/**
 * Check whether an object exists.
 * @param bucket source bucket
 * @param key object key
 * @returns true when the object exists
 * @throws on non-404 S3 errors
 */
export async function s3ObjectExists(bucket: string, key: string): Promise<boolean> {
  const client = await s3Client();
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

    return true;
  } catch (err) {
    if (isMissingS3Error(err)) {
      return false;
    }
    throw err;
  }
}

/**
 * List every object under a prefix, following pagination.
 * @param bucket source bucket
 * @param prefix key prefix
 * @returns the objects found
 */
export async function listS3Prefix(bucket: string, prefix: string): Promise<S3ObjectInfo[]> {
  const client = await s3Client();
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
        ...(item.LastModified !== undefined ? { lastModified: item.LastModified.toISOString() } : {}),
        ...(item.ETag !== undefined ? { etag: item.ETag.replace(/^"|"$/g, "") } : {}),
      });
    }

    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  return objects;
}

/**
 * Delete a single object.
 * @param bucket target bucket
 * @param key object key
 */
export async function deleteS3Object(bucket: string, key: string): Promise<void> {
  const client = await s3Client();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Delete every object under a prefix.
 * @param bucket target bucket
 * @param prefix key prefix
 * @returns the number of objects deleted
 */
export async function deleteS3Prefix(bucket: string, prefix: string): Promise<number> {
  const objects = await listS3Prefix(bucket, prefix);
  await Promise.all(objects.map((object) => deleteS3Object(bucket, object.key)));

  return objects.length;
}

/**
 * Recognize S3 "not found" errors across SDK and status-code shapes.
 * @param error the thrown value
 * @returns true when the error denotes a missing object
 */
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
