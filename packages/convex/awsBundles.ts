"use node";

/**
 * Node-runtime S3 bundle writers for Convex config-plane resources.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { accountHookBundleStorageKey } from "./model/accountHooks";
import { accountToolBundleStorageKey } from "./model/accountTools";
import { writeS3Object } from "./model/s3";

/**
 * Store a custom tool bundle in the account tool bundles bucket.
 * @param accountId account id owning the tool
 * @param sha256 hex sha256 of the already-normalized bundle contents
 * @param bundle JavaScript module source to store
 * @returns the S3 object key written
 */
export const putToolBundle = internalAction({
  args: {
    accountId: v.id("accounts"),
    sha256: v.string(),
    bundle: v.string(),
  },
  returns: v.string(),
  handler: async (_ctx, args) => {
    const bucket = process.env.TOOL_BUNDLES_BUCKET_NAME;
    if (!bucket) {
      throw new Error(
        "TOOL_BUNDLES_BUCKET_NAME is required to write tool bundles",
      );
    }

    const key = accountToolBundleStorageKey(args.accountId, args.sha256);
    await writeS3Object(bucket, key, args.bundle, {
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
 * @param bundle JavaScript module source to store
 * @returns the S3 object key written
 */
export const putHookBundle = internalAction({
  args: {
    accountId: v.id("accounts"),
    sha256: v.string(),
    bundle: v.string(),
  },
  returns: v.string(),
  handler: async (_ctx, args) => {
    const bucket = process.env.TOOL_BUNDLES_BUCKET_NAME;
    if (!bucket) {
      throw new Error(
        "TOOL_BUNDLES_BUCKET_NAME is required to write hook bundles",
      );
    }

    const key = accountHookBundleStorageKey(args.accountId, args.sha256);
    await writeS3Object(bucket, key, args.bundle, {
      contentType: "application/javascript",
      executable: false,
    });

    return key;
  },
});
