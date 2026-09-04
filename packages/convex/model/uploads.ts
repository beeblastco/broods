/**
 * Upload URL quota: one `uploadGrants` row per minted storage upload URL, and
 * the count of unexpired rows per account is the cap.
 */

import type { SystemDataModel } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export const OPEN_UPLOADS_PER_HOUR = 20;
export const UPLOAD_GRANT_WINDOW_MS = 60 * 60 * 1000;
const EXPIRED_GRANT_PRUNE_BATCH = 50;

export type UploadKind = Doc<"uploadGrants">["kind"];

type StoredBlob = SystemDataModel["_storage"]["document"];

/** Either a fresh upload URL or the time the oldest open grant expires. */
export type UploadGrant = { uploadUrl: string } | { retryAt: number };

/**
 * The blob behind a fresh upload: it must exist and be nobody's file yet.
 * Storage ids are visible to every reader of a workspace, so a caller-supplied
 * id is only trusted when no row already owns it.
 */
export async function claimUploadedBlob(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
): Promise<StoredBlob> {
  const blob = await ctx.db.system.get(storageId);
  if (!blob) throw new Error("Uploaded file was not found in storage.");
  const owner = await ctx.db
    .query("workspaceFiles")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    .first();
  if (owner) throw new Error("Uploaded file is already registered.");

  return blob;
}

/** Prune a batch of expired grants, then mint unless the account is at the cap. */
export async function grantUpload(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  kind: UploadKind,
): Promise<UploadGrant> {
  const now = Date.now();
  const stale = await ctx.db
    .query("uploadGrants")
    .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
    .take(EXPIRED_GRANT_PRUNE_BATCH);
  for (const row of stale) await ctx.db.delete(row._id);

  const open = await ctx.db
    .query("uploadGrants")
    .withIndex("by_accountId_and_expiresAt", (q) =>
      q.eq("accountId", accountId).gte("expiresAt", now),
    )
    .take(OPEN_UPLOADS_PER_HOUR);
  const oldest = open[0];
  if (oldest && open.length >= OPEN_UPLOADS_PER_HOUR) {
    return { retryAt: oldest.expiresAt };
  }

  await ctx.db.insert("uploadGrants", {
    accountId: accountId,
    kind: kind,
    createdAt: now,
    expiresAt: now + UPLOAD_GRANT_WINDOW_MS,
  });

  return { uploadUrl: await ctx.storage.generateUploadUrl() };
}

export function uploadQuotaMessage(retryAt: number): string {
  return `upload quota: ${OPEN_UPLOADS_PER_HOUR} uploads per hour; retry after ${new Date(retryAt).toISOString()}`;
}
