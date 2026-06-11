/**
 * Account tool upload orchestration.
 * Account API handlers call here to pair S3 bundle storage with metadata CRUD.
 */

import { requireEnv } from "../_shared/env.ts";
import { writeS3Object } from "../_shared/s3.ts";
import {
  accountToolBundleStorageKey,
  getStorage,
  normalizeAccountToolUpload,
  toPublicAccountTool,
  type PublicAccountToolRecord,
  type UpdateAccountToolInput,
} from "../_shared/storage/index.ts";

function toolBundlesBucketName(): string {
  return requireEnv("TOOL_BUNDLES_BUCKET_NAME");
}

export async function createAccountTool(accountId: string, input: unknown): Promise<PublicAccountToolRecord> {
  const upload = normalizeAccountToolUpload(input, { requireBundle: true });
  const bundleStorageKey = accountToolBundleStorageKey(accountId, upload.sha256!);
  await writeS3Object(toolBundlesBucketName(), bundleStorageKey, upload.bundle!, {
    contentType: "application/javascript",
  });
  const record = await getStorage().accountTools.create(accountId, {
    name: upload.name!,
    description: upload.description!,
    inputSchema: upload.inputSchema!,
    bundleStorageKey,
    sha256: upload.sha256!,
    ...(upload.defaultConfig !== undefined ? { defaultConfig: upload.defaultConfig } : {}),
  });
  return toPublicAccountTool(record);
}

export async function updateAccountTool(accountId: string, toolId: string, input: unknown): Promise<PublicAccountToolRecord | null> {
  const upload = normalizeAccountToolUpload(input, { requireBundle: false });
  const patch: UpdateAccountToolInput = {};

  if (upload.name !== undefined) patch.name = upload.name;
  if (upload.description !== undefined) patch.description = upload.description;
  if (upload.inputSchema !== undefined) patch.inputSchema = upload.inputSchema;
  if (upload.defaultConfig !== undefined) patch.defaultConfig = upload.defaultConfig;
  if (upload.bundle !== undefined) {
    const bundleStorageKey = accountToolBundleStorageKey(accountId, upload.sha256!);
    await writeS3Object(toolBundlesBucketName(), bundleStorageKey, upload.bundle, {
      contentType: "application/javascript",
    });
    patch.bundleStorageKey = bundleStorageKey;
    patch.sha256 = upload.sha256;
  }

  const record = await getStorage().accountTools.update(accountId, toolId, patch);
  return record ? toPublicAccountTool(record) : null;
}
