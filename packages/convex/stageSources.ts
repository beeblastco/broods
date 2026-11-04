import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { authKit } from "./auth";
import { getOwnedStage } from "./model/ownership/stage";
import { STAGE_SOURCE_ORIGINS } from "./model/stageSource";

// Revert needs the one before; the rest is history nobody reads.
const KEPT_REVISIONS = 20;

const originValidator = v.union(
  ...STAGE_SOURCE_ORIGINS.map((origin) => v.literal(origin)),
);

const sourceValidator = v.object({
  revision: v.number(),
  hash: v.string(),
  fileCount: v.number(),
  bytes: v.number(),
  manifestHash: v.optional(v.string()),
  origin: originValidator,
  commitSha: v.optional(v.string()),
  createdAt: v.number(),
  url: v.union(v.string(), v.null()),
});

type StageSourceSummary = Infer<typeof sourceValidator>;

/** The stage's newest source revision, with a URL its `{ files }` JSON downloads from. */
export const latest = query({
  args: { stageId: v.id("stages") },
  returns: v.union(sourceValidator, v.null()),
  handler: async (ctx, { stageId }): Promise<StageSourceSummary | null> => {
    const user = await authKit.getAuthUser(ctx);
    if (!user) throw new Error("User not found or not authenticated");
    if (!(await getOwnedStage(ctx, user.id, stageId))) return null;
    const row = await latestRow(ctx, stageId);

    return row ? await summary(ctx, row) : null;
  },
});

export const latestHash = internalQuery({
  args: { stageId: v.id("stages") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { stageId }): Promise<string | null> =>
    (await latestRow(ctx, stageId))?.hash ?? null,
});

/** The stage's manifest hash when a sync finished at or after `since`, else null. */
export const syncedSince = internalQuery({
  args: { stageId: v.id("stages"), since: v.number() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { stageId, since }): Promise<string | null> => {
    const sync = await ctx.db
      .query("stageSyncs")
      .withIndex("by_stageId", (q) => q.eq("stageId", stageId))
      .unique();

    return sync?.manifestHash && (sync.syncedAt ?? 0) >= since
      ? sync.manifestHash
      : null;
  },
});

/**
 * Records a sync: the manifest hash it read back, and the source it came from when one rode it.
 * A source equal to the newest revision only moves that revision's hashes; `storageId` is then
 * dropped. Answers the revision the stage's source now is.
 */
export const recordSync = internalMutation({
  args: {
    stageId: v.id("stages"),
    manifestHash: v.string(),
    source: v.optional(
      v.object({
        hash: v.string(),
        storageId: v.optional(v.id("_storage")),
        fileCount: v.number(),
        bytes: v.number(),
        origin: originValidator,
        commitSha: v.optional(v.string()),
      }),
    ),
  },
  returns: v.union(v.number(), v.null()),
  handler: async (
    ctx,
    { stageId, manifestHash, source },
  ): Promise<number | null> => {
    const now = Date.now();
    const sync = await ctx.db
      .query("stageSyncs")
      .withIndex("by_stageId", (q) => q.eq("stageId", stageId))
      .unique();
    if (sync)
      await ctx.db.patch(sync._id, {
        manifestHash: manifestHash,
        syncedAt: now,
      });
    const newest = await latestRow(ctx, stageId);
    if (!source) return newest?.revision ?? null;
    if (newest?.hash === source.hash) {
      if (source.storageId) await ctx.storage.delete(source.storageId);
      await ctx.db.patch(newest._id, {
        manifestHash: manifestHash,
        ...(source.commitSha ? { commitSha: source.commitSha } : {}),
      });

      return newest.revision;
    }
    if (!source.storageId) return newest?.revision ?? null;
    const revision = (newest?.revision ?? 0) + 1;
    await ctx.db.insert("stageSources", {
      stageId: stageId,
      revision: revision,
      hash: source.hash,
      storageId: source.storageId,
      fileCount: source.fileCount,
      bytes: source.bytes,
      manifestHash: manifestHash,
      origin: source.origin,
      ...(source.commitSha ? { commitSha: source.commitSha } : {}),
      createdAt: now,
    });
    await pruneRevisions(ctx, stageId, revision - KEPT_REVISIONS);

    return revision;
  },
});

/** Every stored revision of a stage and its files go with the stage. */
export async function deleteStageSources(
  ctx: MutationCtx,
  stageId: Id<"stages">,
): Promise<void> {
  await pruneRevisions(ctx, stageId, Number.POSITIVE_INFINITY);
}

async function latestRow(
  ctx: QueryCtx,
  stageId: Id<"stages">,
): Promise<Doc<"stageSources"> | null> {
  return await ctx.db
    .query("stageSources")
    .withIndex("by_stageId_and_revision", (q) => q.eq("stageId", stageId))
    .order("desc")
    .first();
}

async function pruneRevisions(
  ctx: MutationCtx,
  stageId: Id<"stages">,
  belowOrAt: number,
): Promise<void> {
  const stale = await ctx.db
    .query("stageSources")
    .withIndex("by_stageId_and_revision", (q) =>
      q.eq("stageId", stageId).lte("revision", belowOrAt),
    )
    .take(100);
  for (const row of stale) {
    await ctx.storage.delete(row.storageId);
    await ctx.db.delete(row._id);
  }
}

async function summary(
  ctx: QueryCtx,
  row: Doc<"stageSources">,
): Promise<StageSourceSummary> {
  return {
    revision: row.revision,
    hash: row.hash,
    fileCount: row.fileCount,
    bytes: row.bytes,
    ...(row.manifestHash ? { manifestHash: row.manifestHash } : {}),
    origin: row.origin,
    ...(row.commitSha ? { commitSha: row.commitSha } : {}),
    createdAt: row.createdAt,
    url: await ctx.storage.getUrl(row.storageId),
  };
}
