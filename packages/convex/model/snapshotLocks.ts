import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

// The first capture owns an image for good; the account cascade locks every row it deletes.
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
