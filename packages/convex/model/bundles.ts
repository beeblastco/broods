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

/** Stores a code hook bundle in S3 and returns its object key. */
export async function putHookBundle(
  ctx: ActionCtx,
  options: { accountId: Id<"accounts">; sha256: string; bundle: string },
): Promise<string> {
  const storageId = await courier(ctx, options.bundle);
  try {
    return await ctx.runAction(internal.aws.bundles.putHookBundle, {
      accountId: options.accountId,
      sha256: options.sha256,
      storageId: storageId,
    });
  } finally {
    await ctx.storage.delete(storageId);
  }
}

/** Stores a hosted MCP server bundle in S3 and returns its object key. */
export async function putMcpBundle(
  ctx: ActionCtx,
  options: { accountId: Id<"accounts">; sha256: string; bundle: string },
): Promise<string> {
  const storageId = await courier(ctx, options.bundle);
  try {
    return await ctx.runAction(internal.aws.bundles.putMcpBundle, {
      accountId: options.accountId,
      sha256: options.sha256,
      storageId: storageId,
    });
  } finally {
    await ctx.storage.delete(storageId);
  }
}

/**
 * Content-addressed store for a hosted MCP server's bundle: when the sha256
 * matches the existing row, its stored key is reused; a connection-only input
 * (no bundle) stores nothing.
 */
export async function storeMcpBundle(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  input: Pick<McpInput, "bundle" | "sha256">,
  existing: Pick<Doc<"mcp">, "sha256" | "bundleStorageKey"> | null,
): Promise<string | undefined> {
  if (input.bundle === undefined || input.sha256 === undefined) {
    return undefined;
  }
  if (existing?.sha256 === input.sha256 && existing.bundleStorageKey) {
    return existing.bundleStorageKey;
  }

  return await putMcpBundle(ctx, {
    accountId: accountId,
    sha256: input.sha256,
    bundle: input.bundle,
  });
}

async function courier(
  ctx: ActionCtx,
  bundle: string,
): Promise<Id<"_storage">> {
  return await ctx.storage.store(
    new Blob([bundle], { type: BUNDLE_CONTENT_TYPE }),
  );
}
