"use node";

/**
 * Node-runtime S3 bundle writers for Convex config-plane resources. Bundles
 * arrive by storage id, never as an argument — see model/bundles.ts for why.
 * The MCP writer also verifies client-uploaded bundles (sha256 and size cap)
 * here, where the bytes are read anyway.
 */

import { createHash } from "node:crypto";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { accountHookBundleStorageKey } from "../model/accountHooks";
import { MAX_MCP_BUNDLE_BYTES, mcpBundleStorageKey } from "../model/mcp";
import { writeS3Object } from "../model/s3";

/**
 * Store a code hook bundle in the account bundles bucket.
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
  handler: async (ctx, args) =>
    await writeBundleObject(
      args,
      accountHookBundleStorageKey,
      await bundleBytes(ctx, args.storageId),
    ),
});

/**
 * Store a hosted MCP server bundle under the account-mcp/ prefix (#331 phase
 * 2). The bundle may be a direct client upload (#190), so the declared sha256
 * and the size cap are verified against the raw bytes first — failing here
 * turns a corrupt upload into an upload error instead of a broken server.
 */
export const putMcpBundle = internalAction({
  args: {
    accountId: v.id("accounts"),
    sha256: v.string(),
    storageId: v.id("_storage"),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const bytes = await bundleBytes(ctx, args.storageId);
    if (bytes.byteLength > MAX_MCP_BUNDLE_BYTES) {
      throw new Error(
        `bundle must be at most ${MAX_MCP_BUNDLE_BYTES} bytes (got ${bytes.byteLength})`,
      );
    }
    const actualSha = createHash("sha256").update(bytes).digest("hex");
    if (actualSha !== args.sha256) {
      throw new Error(
        "bundle sha256 does not match the uploaded bytes; re-upload and retry",
      );
    }

    return await writeBundleObject(args, mcpBundleStorageKey, bytes);
  },
});

async function bundleBytes(
  ctx: { storage: { get: (id: string) => Promise<Blob | null> } },
  storageId: string,
): Promise<Buffer> {
  const blob = await ctx.storage.get(storageId);
  if (!blob) throw new Error("bundle is missing from Convex storage");

  return Buffer.from(await blob.arrayBuffer());
}

async function writeBundleObject(
  args: { accountId: string; sha256: string },
  keyFor: (accountId: string, sha256: string) => string,
  source: Buffer,
): Promise<string> {
  const bucket = process.env.TOOL_BUNDLES_BUCKET_NAME;
  if (!bucket) {
    throw new Error("TOOL_BUNDLES_BUCKET_NAME is required to write bundles");
  }

  const key = keyFor(args.accountId, args.sha256);
  await writeS3Object(bucket, key, source, {
    contentType: "application/javascript",
    executable: false,
  });

  return key;
}
