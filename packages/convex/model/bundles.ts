/**
 * Bundle bytes reach S3 through Convex file storage instead of riding along as
 * an action argument. A "use node" action caps arguments at 5 MiB — that is
 * Lambda's invoke-payload quota showing through — which would cap an uploaded
 * bundle well below what the runtime can actually execute. The stored blob
 * is only a courier: whoever stores it deletes it, pass or fail.
 */

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { McpInput } from "./mcp";

const BUNDLE_CONTENT_TYPE = "application/javascript";

type PutBundleAction = typeof internal.aws.bundles.putHookBundle;

/** Stores a code hook bundle in S3 and returns its object key. */
export async function putHookBundle(
  ctx: ActionCtx,
  options: { accountId: Id<"accounts">; sha256: string; bundle: string },
): Promise<string> {
  return await putBundle(ctx, internal.aws.bundles.putHookBundle, options);
}

/**
 * Content-addressed store for a hosted MCP server's bundle: when the sha256
 * matches the existing row, its stored key is reused; a connection-only input
 * (no bundle) stores nothing. Large bundles arrive pre-uploaded to Convex
 * storage as `bundleStorageId` (#190); the S3 writer verifies their declared
 * sha256 against the bytes, and the courier blob is deleted either way.
 */
export async function storeMcpBundle(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  input: Pick<McpInput, "bundle" | "bundleStorageId" | "sha256">,
  existing: Pick<Doc<"mcp">, "sha256" | "bundleStorageKey"> | null,
): Promise<string | undefined> {
  if (
    (input.bundle === undefined && input.bundleStorageId === undefined) ||
    input.sha256 === undefined
  ) {
    return undefined;
  }
  if (existing?.sha256 === input.sha256 && existing.bundleStorageKey) {
    if (input.bundleStorageId !== undefined) {
      await ctx.storage.delete(input.bundleStorageId as Id<"_storage">);
    }

    return existing.bundleStorageKey;
  }
  if (input.bundleStorageId !== undefined) {
    const storageId = input.bundleStorageId as Id<"_storage">;
    try {
      return await ctx.runAction(internal.aws.bundles.putMcpBundle, {
        accountId: accountId,
        sha256: input.sha256,
        storageId: storageId,
      });
    } finally {
      await ctx.storage.delete(storageId);
    }
  }

  return await putBundle(ctx, internal.aws.bundles.putMcpBundle, {
    accountId: accountId,
    sha256: input.sha256,
    bundle: input.bundle!,
  });
}

// Couriers the bytes through Convex storage, runs the S3 writer action, and
// always deletes the blob — pass or fail.
async function putBundle(
  ctx: ActionCtx,
  action: PutBundleAction,
  options: { accountId: Id<"accounts">; sha256: string; bundle: string },
): Promise<string> {
  const storageId = await ctx.storage.store(
    new Blob([options.bundle], { type: BUNDLE_CONTENT_TYPE }),
  );
  try {
    return await ctx.runAction(action, {
      accountId: options.accountId,
      sha256: options.sha256,
      storageId: storageId,
    });
  } finally {
    await ctx.storage.delete(storageId);
  }
}
