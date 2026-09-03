/**
 * Upload URL quota: one `uploadGrants` row per minted storage upload URL, and
 * the count of unexpired rows per account is the cap.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export const OPEN_UPLOADS_PER_HOUR = 20;
export const UPLOAD_GRANT_WINDOW_MS = 60 * 60 * 1000;
const EXPIRED_GRANT_PRUNE_BATCH = 50;

export type UploadKind = Doc<"uploadGrants">["kind"];

/** Either a fresh upload URL or the time the oldest open grant expires. */
export type UploadGrant = { uploadUrl: string } | { retryAt: number };

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
