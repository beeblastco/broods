/**
 * Filesystem namespace helpers for harness-processing.
 * Keep collision-resistant namespace derivation and legacy migration here.
 */

import {
  CopyObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

const s3 = new S3Client({ region: process.env.AWS_REGION });
const FILESYSTEM_NAMESPACE_PREFIX = "fs-v2-";
const HASH_HEX_LENGTH = 40;
export const INTERNAL_EVENT_ID_PREFIX = "conversation-lease:";

export function normalizeFilesystemNamespace(conversationKey: string): string {
  return `${FILESYSTEM_NAMESPACE_PREFIX}${hashScopedValue("filesystem-namespace", conversationKey)}`;
}

export function legacyFilesystemNamespace(conversationKey: string): string {
  return conversationKey
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "default";
}

export function filesystemNamespaceCandidates(conversationKey: string): string[] {
  return Array.from(new Set([
    normalizeFilesystemNamespace(conversationKey),
    legacyFilesystemNamespace(conversationKey),
  ]));
}

export function conversationLeaseKey(conversationKey: string): string {
  return `${INTERNAL_EVENT_ID_PREFIX}v2:${hashScopedValue("conversation-lease", conversationKey)}`;
}

export async function resolveFilesystemNamespace(
  conversationKey: string,
  bucketName: string,
): Promise<string> {
  const currentNamespace = normalizeFilesystemNamespace(conversationKey);
  const legacyNamespace = legacyFilesystemNamespace(conversationKey);

  if (currentNamespace === legacyNamespace) {
    return currentNamespace;
  }

  if (await namespaceExists(currentNamespace, bucketName)) {
    return currentNamespace;
  }

  if (!(await namespaceExists(legacyNamespace, bucketName))) {
    return currentNamespace;
  }

  await migrateNamespace(legacyNamespace, currentNamespace, bucketName);
  return currentNamespace;
}

async function namespaceExists(namespace: string, bucketName: string): Promise<boolean> {
  const response = await s3.send(new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: `${namespace}/`,
    MaxKeys: 1,
  }));

  return (response.Contents ?? []).length > 0;
}

async function migrateNamespace(
  legacyNamespace: string,
  currentNamespace: string,
  bucketName: string,
): Promise<void> {
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `${legacyNamespace}/`,
      ContinuationToken: continuationToken,
    }));

    for (const item of response.Contents ?? []) {
      if (!item.Key) {
        continue;
      }

      const migratedKey = item.Key.replace(`${legacyNamespace}/`, `${currentNamespace}/`);
      await s3.send(new CopyObjectCommand({
        Bucket: bucketName,
        CopySource: toCopySource(bucketName, item.Key),
        Key: migratedKey,
      }));
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
}

function hashScopedValue(scope: string, value: string): string {
  return createHash("sha256")
    .update(scope)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, HASH_HEX_LENGTH);
}

function toCopySource(bucketName: string, key: string): string {
  return `${bucketName}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}
