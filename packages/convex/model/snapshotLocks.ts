/**
 * The per-image lock behind the snapshot stage lock. A plain helper so the
 * snapshot registry and the account cascade share it without an import cycle.
 */

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Records which account and stage took an image, once: the first capture owns
 * it. The account cascade calls it too, for every row it deletes.
 */
export async function lockImage(
  ctx: MutationCtx,
  image: Omit<Doc<"sandboxSnapshotImages">, "_id" | "_creationTime">,
): Promise<void> {
  const locked = await ctx.db
    .query("sandboxSnapshotImages")
    .withIndex("by_externalImageId", (q) =>
      q.eq("externalImageId", image.externalImageId),
    )
    .first();
  if (locked) return;
  await ctx.db.insert("sandboxSnapshotImages", {
    externalImageId: image.externalImageId,
    accountId: image.accountId,
    ...(image.scope ? { scope: image.scope } : {}),
    baseImage: image.baseImage,
  });
}
