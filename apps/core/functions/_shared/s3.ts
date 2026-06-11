/**
 * Small Bun-native S3 wrapper.
 * Keep bucket helpers here so runtime code does not import the AWS S3 SDK.
 */

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client as AwsS3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { logError, logInfo } from "./log.ts";

export interface S3ObjectInfo {
  key: string;
  size?: number;
  lastModified?: string;
  etag?: string;
}

const SANDBOX_UID = "993";
const SANDBOX_GID = "990";

function awsClient(): AwsS3Client {
  return new AwsS3Client({
    region: process.env.AWS_REGION,
  });
}

export async function readS3Text(bucket: string, key: string): Promise<string> {
  const body = await readS3Body(bucket, key);
  return body.transformToString();
}

export async function getS3ObjectUrl(
  bucket: string,
  key: string,
  options: { expiresInSeconds?: number } = {},
): Promise<string> {
  return getSignedUrl(
    awsClient(),
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: options.expiresInSeconds ?? 300 },
  );
}

export async function readS3Bytes(bucket: string, key: string): Promise<Uint8Array> {
  const body = await readS3Body(bucket, key);
  return body.transformToByteArray();
}

export async function writeS3Object(
  bucket: string,
  key: string,
  body: string | Uint8Array,
  options: { contentType?: string; executable?: boolean } = {},
): Promise<number> {
  const size = typeof body === "string" ? body.length : body.byteLength;
  logInfo("s3.write start", { bucket, key, contentType: options.contentType, size });
  try {
    await putS3Object(bucket, key, body, {
      contentType: options.contentType,
      metadata: posixMetadata(key.endsWith("/") ? "directory" : "file", options.executable === true),
    });
    logInfo("s3.write success", { bucket, key, result: size });
    return size;
  } catch (err) {
    logError("s3.write failed", {
      bucket,
      key,
      error: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : typeof err,
      errorStack: err instanceof Error ? err.stack : undefined,
      errorCause: err instanceof Error && err.cause ? String(err.cause) : undefined,
    });
    throw err;
  }
}

export async function copyS3Object(
  sourceBucket: string,
  sourceKey: string,
  destinationBucket: string,
  destinationKey: string,
  options: { contentType?: string; executable?: boolean } = {},
): Promise<void> {
  logInfo("s3.copy start", { sourceBucket, sourceKey, destinationBucket, destinationKey });
  try {
    await awsClient().send(new CopyObjectCommand({
      Bucket: destinationBucket,
      Key: destinationKey,
      CopySource: `${sourceBucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, "/")}`,
      MetadataDirective: "REPLACE",
      Metadata: posixMetadata(destinationKey.endsWith("/") ? "directory" : "file", options.executable === true),
      ...(options.contentType ? { ContentType: options.contentType } : {}),
    }));
    logInfo("s3.copy success", { sourceBucket, sourceKey, destinationBucket, destinationKey });
  } catch (err) {
    logError("s3.copy failed", {
      sourceBucket,
      sourceKey,
      destinationBucket,
      destinationKey,
      error: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : typeof err,
      errorStack: err instanceof Error ? err.stack : undefined,
      errorCause: err instanceof Error && err.cause ? String(err.cause) : undefined,
    });
    throw err;
  }
}

export async function ensureS3DirectoryMarkers(bucket: string, key: string): Promise<void> {
  const parts = key.split("/").filter(Boolean);
  parts.pop();

  let prefix = "";
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    await putS3Object(bucket, `${prefix}/`, "", {
      contentType: "application/x-directory",
      metadata: posixMetadata("directory"),
    });
  }
}

export async function s3ObjectExists(bucket: string, key: string): Promise<boolean> {
  logInfo("s3.exists start", { bucket, key });
  try {
    await awsClient().send(new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    }));
    logInfo("s3.exists result", { bucket, key, exists: true });
    return true;
  } catch (err) {
    if (isMissingS3Error(err)) {
      logInfo("s3.exists result", { bucket, key, exists: false });
      return false;
    }

    const details: Record<string, unknown> = {
      bucket,
      key,
      error: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : typeof err,
      errorStack: err instanceof Error ? err.stack : undefined,
      errorCause: err instanceof Error && err.cause ? String(err.cause) : undefined,
    };
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      const metadata = e.$metadata as Record<string, unknown> | undefined;
      details.statusCode = e.statusCode ?? e.status ?? metadata?.httpStatusCode;
      details.errorCode = e.code ?? e.Code;
      details.errorRequestId = e.requestId ?? metadata?.requestId;
      details.errorKeys = Object.keys(e);
    }
    logError("s3.exists failed", details);
    throw err;
  }
}

export async function listS3Prefix(bucket: string, prefix: string): Promise<S3ObjectInfo[]> {
  logInfo("s3.list start", { bucket, prefix });
  const objects: S3ObjectInfo[] = [];
  let continuationToken: string | undefined;

  try {
    do {
      const result = await awsClient().send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }));

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

    logInfo("s3.list success", { bucket, prefix, count: objects.length });
  } catch (err) {
    logError("s3.list failed", {
      bucket,
      prefix,
      error: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : typeof err,
      errorStack: err instanceof Error ? err.stack : undefined,
      errorCause: err instanceof Error && err.cause ? String(err.cause) : undefined,
    });
    throw err;
  }

  return objects;
}

export async function deleteS3Object(bucket: string, key: string): Promise<void> {
  await awsClient().send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
}

export async function deleteS3Prefix(bucket: string, prefix: string): Promise<number> {
  const objects = await listS3Prefix(bucket, prefix);
  await Promise.all(objects.map((object) => deleteS3Object(bucket, object.key)));
  return objects.length;
}

async function readS3Body(bucket: string, key: string) {
  const result = await awsClient().send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));

  if (!result.Body) {
    throw new Error(`S3 object has no body: ${key}`);
  }

  return result.Body;
}

async function putS3Object(
  bucket: string,
  key: string,
  body: string | Uint8Array,
  options: { contentType?: string; metadata?: Record<string, string> } = {},
): Promise<void> {
  await awsClient().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ...(options.contentType ? { ContentType: options.contentType } : {}),
    ...(options.metadata ? { Metadata: options.metadata } : {}),
  }));
}

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

  return candidate.name === "NoSuchKey" ||
    candidate.name === "NotFound" ||
    candidate.name === "S3Error" && candidate.status === 404 ||
    candidate.code === "NoSuchKey" ||
    candidate.Code === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404;
}
