import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
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
import { STAGE_SOURCE_LIMITS, STAGE_SOURCE_ORIGINS } from "./model/stageSource";

// Revert needs the one before; the rest is history nobody reads.

const originValidator = v.union(
  ...STAGE_SOURCE_ORIGINS.map((origin) => v.literal(origin)),
);

export const verificationValidator = v.object({
  phase: v.union(
    v.literal("verifying"),
    v.literal("deployed"),
    v.literal("failed"),
  ),
  error: v.optional(v.string()),
  runUrl: v.optional(v.string()),
});

const sourceValidator = v.object({
  revision: v.number(),
  hash: v.string(),
  fileCount: v.number(),
  bytes: v.number(),
  manifestHash: v.optional(v.string()),
  origin: originValidator,
  commitSha: v.optional(v.string()),
  verification: v.optional(verificationValidator),
  createdAt: v.number(),
  url: v.union(v.string(), v.null()),
});

const driftValidator = v.object({
  outOfSync: v.boolean(),
  reason: v.optional(v.string()),
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

/**
 * One state for the change bar: the stage no longer runs its newest source, so Sync redeploys
 * the right one. Quiet while an Apply waits for CI, which settles it either way.
 */
export const drift = query({
  args: { stageId: v.id("stages") },
  returns: driftValidator,
  handler: async (ctx, { stageId }): Promise<Infer<typeof driftValidator>> => {
    const user = await authKit.getAuthUser(ctx);
    if (!user) throw new Error("User not found or not authenticated");
    const stage = await getOwnedStage(ctx, user.id, stageId);
    const newest = stage ? await latestRow(ctx, stageId) : null;
    if (!stage || !newest || newest.verification?.phase === "verifying")
      return { outOfSync: false };
    const sync = await ctx.db
      .query("stageSyncs")
      .withIndex("by_stageId", (q) => q.eq("stageId", stageId))
      .unique();
    if (sync?.manifestHash && newest.manifestHash !== sync.manifestHash)
      return {
        outOfSync: true,
        reason:
          "The stage was deployed from somewhere else since its last stored source.",
      };
    const branch = await stageBranch(ctx, stage);
    const run = branch
      ? await ctx.db
          .query("githubDeploys")
          .withIndex("by_projectId_and_branch", (q) =>
            q.eq("projectId", stage.projectId).eq("branch", branch),
          )
          .unique()
      : null;
    if (run?.status === "completed" && run.sha !== newest.commitSha)
      return {
        outOfSync: true,
        reason:
          run.conclusion === "success"
            ? `${branch} has commits the stored source does not.`
            : `The last deploy from ${branch} failed.`,
      };

    return { outOfSync: false };
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
        origin: source.origin,
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
    await pruneRevisions(
      ctx,
      stageId,
      revision - STAGE_SOURCE_LIMITS.revisions,
    );

    return revision;
  },
});

export const setVerification = internalMutation({
  args: {
    stageId: v.id("stages"),
    revision: v.number(),
    verification: verificationValidator,
    commitSha: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { stageId, revision, verification, commitSha },
  ): Promise<null> => {
    const row = await ctx.db
      .query("stageSources")
      .withIndex("by_stageId_and_revision", (q) =>
        q.eq("stageId", stageId).eq("revision", revision),
      )
      .unique();
    if (row)
      await ctx.db.patch(row._id, {
        verification: verification,
        ...(commitSha ? { commitSha: commitSha } : {}),
      });

    return null;
  },
});

/**
 * A finished CI run on a linked branch. An Apply waiting on its sha is done when CI succeeded and
 * left the stage on the hash Apply synced; a push nobody applied is snapshotted as the source.
 */
export const verifyRun = internalMutation({
  args: {
    repoId: v.number(),
    branch: v.string(),
    sha: v.string(),
    conclusion: v.optional(v.string()),
    url: v.string(),
    startedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, run): Promise<null> => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_repoId", (q) => q.eq("repo.repoId", run.repoId))
      .collect();
    for (const project of projects) {
      const stages = await ctx.db
        .query("stages")
        .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
        .collect();
      for (const stage of stages) {
        if ((await stageBranch(ctx, stage)) !== run.branch) continue;
        await settleRun(ctx, stage._id, run);
      }
    }

    return null;
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
    ...(row.verification ? { verification: row.verification } : {}),
    createdAt: row.createdAt,
    url: await ctx.storage.getUrl(row.storageId),
  };
}

async function settleRun(
  ctx: MutationCtx,
  stageId: Id<"stages">,
  run: { sha: string; conclusion?: string; url: string; startedAt: number },
): Promise<void> {
  const recent = await ctx.db
    .query("stageSources")
    .withIndex("by_stageId_and_revision", (q) => q.eq("stageId", stageId))
    .order("desc")
    .take(STAGE_SOURCE_LIMITS.revisions);
  const rows = recent.filter((row) => row.commitSha === run.sha);
  // A rerun that succeeds after a failure settles it again.
  const applied = rows.find(
    (row) =>
      row.verification?.phase === "verifying" ||
      (row.verification?.phase === "failed" && run.conclusion === "success"),
  );
  if (rows.length === 0) {
    // A late event for a run older than the newest source never snapshots over it.
    const newer = run.startedAt > (recent[0]?.createdAt ?? 0);
    if (run.conclusion === "success" && newer)
      await ctx.scheduler.runAfter(0, internal.agentDock.snapshotRepo, {
        stageId: stageId,
        sha: run.sha,
        since: run.startedAt,
      });
    return;
  }
  if (!applied) return;
  const sync = await ctx.db
    .query("stageSyncs")
    .withIndex("by_stageId", (q) => q.eq("stageId", stageId))
    .unique();
  const error =
    run.conclusion !== "success"
      ? `CI ${run.conclusion ?? "did not finish"}.`
      : (sync?.syncedAt ?? 0) < run.startedAt
        ? "CI finished without syncing the stage."
        : sync?.manifestHash !== applied.manifestHash
          ? "CI deployed a different manifest than Apply synced."
          : undefined;
  // CI's own deploy of the commit may store a newer row; the dashboard reads the newest.
  for (const row of rows.filter((entry) => entry.revision >= applied.revision))
    await ctx.db.patch(row._id, {
      verification: {
        phase: error ? "failed" : "deployed",
        runUrl: run.url,
        ...(error ? { error: error } : {}),
      },
    });
}

// The branch a stage deploys from, the rule `agentDock.linkedBranch` applies.
async function stageBranch(
  ctx: QueryCtx,
  stage: Doc<"stages">,
): Promise<string | undefined> {
  const repo = (await ctx.db.get(stage.projectId))?.repo;

  return stage.kind === "production"
    ? repo?.productionBranch
    : repo?.developmentBranch;
}
