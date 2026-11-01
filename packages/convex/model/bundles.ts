// Bundles reach S3 through file storage: a "use node" action caps its args at 5 MiB.
// The stored blob is only a courier; whoever stores it deletes it, pass or fail.

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { McpInput } from "./mcp";

const BUNDLE_CONTENT_TYPE = "application/javascript";

type PutBundleAction = typeof internal.aws.bundles.putHookBundle;

export interface StoredMcpBundle {
  bundleStorageKey: string;
  sha256: string;
  workersCompatible?: boolean;
}

export async function putHookBundle(
  ctx: ActionCtx,
  options: { accountId: Id<"accounts">; sha256: string; bundle: string },
): Promise<string> {
  return await putBundle(ctx, internal.aws.bundles.putHookBundle, options);
}

export async function storeMcpBundle(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  input: Pick<McpInput, "bundle" | "bundleStorageId" | "sha256">,
  existing: Pick<
    Doc<"mcp">,
    "sha256" | "bundleStorageKey" | "workersCompatible"
  > | null,
): Promise<StoredMcpBundle | undefined> {
  if (
    (input.bundle === undefined && input.bundleStorageId === undefined) ||
    input.sha256 === undefined
  ) {
    return undefined;
  }
  // A row stored before placement existed has no flag; storing its bundle again scans it.
  if (
    existing?.sha256 === input.sha256 &&
    existing.bundleStorageKey &&
    existing.workersCompatible !== undefined
  ) {
    if (input.bundleStorageId !== undefined) {
      await ctx.storage.delete(input.bundleStorageId as Id<"_storage">);
    }

    return {
      bundleStorageKey: existing.bundleStorageKey,
      sha256: input.sha256,
      workersCompatible: existing.workersCompatible,
    };
  }
  const storageId =
    input.bundleStorageId !== undefined
      ? (input.bundleStorageId as Id<"_storage">)
      : await ctx.storage.store(
          new Blob([input.bundle!], { type: BUNDLE_CONTENT_TYPE }),
        );
  try {
    const stored = await ctx.runAction(internal.aws.bundles.putMcpBundle, {
      accountId: accountId,
      sha256: input.sha256,
      storageId: storageId,
    });

    return {
      bundleStorageKey: stored.key,
      sha256: input.sha256,
      workersCompatible: stored.workersCompatible,
    };
  } finally {
    await ctx.storage.delete(storageId);
  }
}

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
