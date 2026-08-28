/**
 * Bundle bytes reach S3 through Convex file storage instead of riding along as
 * an action argument. A "use node" action caps arguments at 5 MiB — that is
 * Lambda's invoke-payload quota showing through — which would cap an uploaded
 * tool bundle well below what the runtime can actually execute. The stored blob
 * is only a courier: whoever stores it deletes it, pass or fail.
 */

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

const BUNDLE_CONTENT_TYPE = "application/javascript";

/** Stores a tool bundle in S3 and returns its object key. */
export async function putToolBundle(
  ctx: ActionCtx,
  options: { accountId: Id<"accounts">; sha256: string; bundle: string },
): Promise<string> {
  const storageId = await courier(ctx, options.bundle);
  try {
    return await ctx.runAction(internal.aws.bundles.putToolBundle, {
      accountId: options.accountId,
      sha256: options.sha256,
      storageId: storageId,
    });
  } finally {
    await ctx.storage.delete(storageId);
  }
}

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

async function courier(
  ctx: ActionCtx,
  bundle: string,
): Promise<Id<"_storage">> {
  return await ctx.storage.store(
    new Blob([bundle], { type: BUNDLE_CONTENT_TYPE }),
  );
}
