/**
 * Small Bun-native S3 wrapper.
 * Keep bucket helpers here so runtime code does not import the AWS S3 SDK.
 */

import { logError, logInfo } from "./log.ts";

export interface S3ObjectInfo {
  key: string;
  size?: number;
  lastModified?: string;
}

function client(bucket: string): Bun.S3Client {
  return new Bun.S3Client({
    bucket,
    region: process.env.AWS_REGION,
  });
}

export async function readS3Text(bucket: string, key: string): Promise<string> {
  return client(bucket).file(key).text();
}

export async function readS3Bytes(bucket: string, key: string): Promise<Uint8Array> {
  return client(bucket).file(key).bytes();
}

export async function writeS3Object(
  bucket: string,
  key: string,
  body: string | Uint8Array,
  options: { contentType?: string } = {},
): Promise<number> {
  const size = typeof body === "string" ? body.length : body.byteLength;
  logInfo("s3.write start", { bucket, key, contentType: options.contentType, size });
  try {
    const result = await client(bucket).file(key).write(body, options.contentType ? { type: options.contentType } : undefined);
    logInfo("s3.write success", { bucket, key, result });
    return result;
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

export async function s3ObjectExists(bucket: string, key: string): Promise<boolean> {
  return client(bucket).file(key).exists();
}

export async function listS3Prefix(bucket: string, prefix: string): Promise<S3ObjectInfo[]> {
  const objects: S3ObjectInfo[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await client(bucket).list({
      prefix: prefix,
      continuationToken: continuationToken,
      maxKeys: 1000,
    });

    for (const item of result.contents ?? []) {
      objects.push({
        key: item.key,
        ...(item.size !== undefined ? { size: item.size } : {}),
        ...(item.lastModified !== undefined ? { lastModified: item.lastModified } : {}),
      });
    }

    continuationToken = result.nextContinuationToken;
  } while (continuationToken);

  return objects;
}

export async function deleteS3Object(bucket: string, key: string): Promise<void> {
  await client(bucket).file(key).delete();
}

export async function deleteS3Prefix(bucket: string, prefix: string): Promise<number> {
  const objects = await listS3Prefix(bucket, prefix);
  await Promise.all(objects.map((object) => deleteS3Object(bucket, object.key)));
  return objects.length;
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
