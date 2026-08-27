"use node";

/**
 * Node-runtime S3 bundle writers for Convex config-plane resources. Bundles
 * arrive by storage id, never as an argument — see model/bundles.ts for why.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { accountHookBundleStorageKey } from "../model/accountHooks";
import { accountToolBundleStorageKey } from "../model/accountTools";
import { getS3ObjectUrl, writeS3Object } from "../model/s3";

/**
 * Store a custom tool bundle in the account tool bundles bucket.
 * @param accountId account id owning the tool
 * @param sha256 hex sha256 of the already-normalized bundle contents
 * @param storageId Convex storage id holding the JavaScript module source
 * @returns the S3 object key written
 */
export const putToolBundle = internalAction({
  args: {
    accountId: v.id("accounts"),
    sha256: v.string(),
    storageId: v.id("_storage"),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const bucket = process.env.TOOL_BUNDLES_BUCKET_NAME;
    if (!bucket) {
      throw new Error(
        "TOOL_BUNDLES_BUCKET_NAME is required to write tool bundles",
      );
    }

    const key = accountToolBundleStorageKey(args.accountId, args.sha256);
    await writeS3Object(bucket, key, await bundleSource(ctx, args.storageId), {
      contentType: "application/javascript",
      executable: false,
    });

    return key;
  },
});

/**
 * Store a code hook bundle in the account tool bundles bucket.
 * @param accountId account id owning the hook
 * @param sha256 hex sha256 of the already-normalized bundle contents
 * @param storageId Convex storage id holding the JavaScript module source
 * @returns the S3 object key written
 */
export const putHookBundle = internalAction({
  args: {
    accountId: v.id("accounts"),
    sha256: v.string(),
    storageId: v.id("_storage"),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const bucket = process.env.TOOL_BUNDLES_BUCKET_NAME;
    if (!bucket) {
      throw new Error(
        "TOOL_BUNDLES_BUCKET_NAME is required to write hook bundles",
      );
    }

    const key = accountHookBundleStorageKey(args.accountId, args.sha256);
    await writeS3Object(bucket, key, await bundleSource(ctx, args.storageId), {
      contentType: "application/javascript",
      executable: false,
    });

    return key;
  },
});

/**
 * Presign a download for a stored tool bundle.
 * @param bundleStorageKey S3 object key held on the tool row
 * @returns a presigned GET URL
 */
export const toolBundleUrl = internalAction({
  args: {
    bundleStorageKey: v.string(),
  },
  returns: v.string(),
  handler: async (_ctx, args) => {
    const bucket = process.env.TOOL_BUNDLES_BUCKET_NAME;
    if (!bucket) {
      throw new Error(
        "TOOL_BUNDLES_BUCKET_NAME is required to read tool bundles",
      );
    }

    return await getS3ObjectUrl(bucket, args.bundleStorageKey);
  },
});

async function bundleSource(
  ctx: { storage: { get: (id: string) => Promise<Blob | null> } },
  storageId: string,
): Promise<string> {
  const blob = await ctx.storage.get(storageId);
  if (!blob) throw new Error("bundle is missing from Convex storage");

  return await blob.text();
}
