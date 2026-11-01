"use node";

// Bundles arrive by storage id, never as an argument: see model/bundles.ts.

import { createHash } from "node:crypto";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { accountHookBundleStorageKey } from "../model/accountHooks";
import { isWorkersSafeBundle } from "../model/isolateSafety";
import {
  MAX_INLINE_BUNDLE_BYTES,
  MAX_MCP_BUNDLE_BYTES,
  mcpBundleStorageKey,
} from "../model/mcp";
import { writeS3Object } from "../model/s3";
import { ClientError } from "../model/clientError";

export const putHookBundle = internalAction({
  args: {
    accountId: v.id("accounts"),
    sha256: v.string(),
    storageId: v.id("_storage"),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> =>
    await writeBundleObject(
      args,
      accountHookBundleStorageKey,
      await bundleBytes(ctx, args.storageId),
    ),
});

// A client may upload directly, so the declared sha256 and size cap are checked here.
export const putMcpBundle = internalAction({
  args: {
    accountId: v.id("accounts"),
    sha256: v.string(),
    storageId: v.id("_storage"),
  },
  returns: v.object({ key: v.string(), workersCompatible: v.boolean() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ key: string; workersCompatible: boolean }> => {
    const bytes = await bundleBytes(ctx, args.storageId);
    if (bytes.byteLength > MAX_MCP_BUNDLE_BYTES) {
      throw new ClientError(
        `bundle must be at most ${MAX_MCP_BUNDLE_BYTES} bytes (got ${bytes.byteLength})`,
      );
    }
    const actualSha = createHash("sha256").update(bytes).digest("hex");
    if (actualSha !== args.sha256) {
      throw new ClientError(
        "bundle sha256 does not match the uploaded bytes; re-upload and retry",
      );
    }

    return {
      key: await writeBundleObject(args, mcpBundleStorageKey, bytes),
      workersCompatible:
        bytes.byteLength <= MAX_INLINE_BUNDLE_BYTES &&
        isWorkersSafeBundle(bytes.toString("utf8")),
    };
  },
});

async function bundleBytes(
  ctx: { storage: { get: (id: string) => Promise<Blob | null> } },
  storageId: string,
): Promise<Buffer> {
  const blob = await ctx.storage.get(storageId);
  if (!blob) throw new ClientError("bundle is missing from Convex storage");

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
