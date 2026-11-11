import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { stageSourceHash, type StageSource } from "./stageSource";
import type { StageSourceOrigin } from "./stageSourceOrigins";

/** Records a sync's manifest hash, storing its source only when the content moved. */
export async function storeStageSync(
  ctx: ActionCtx,
  stageId: Id<"stages">,
  manifestHash: string,
  source: StageSource | undefined,
  origin: StageSourceOrigin,
): Promise<number | null> {
  if (!source)
    return await ctx.runMutation(internal.stageSources.recordSync, {
      stageId: stageId,
      manifestHash: manifestHash,
    });
  const hash = await stageSourceHash(source.files);
  const body = JSON.stringify({ files: source.files });
  const unchanged =
    (await ctx.runQuery(internal.stageSources.latestHash, {
      stageId: stageId,
    })) === hash;

  return await ctx.runMutation(internal.stageSources.recordSync, {
    stageId: stageId,
    manifestHash: manifestHash,
    source: {
      hash: hash,
      ...(unchanged
        ? {}
        : {
            storageId: await ctx.storage.store(
              new Blob([body], { type: "application/json" }),
            ),
          }),
      fileCount: source.files.length,
      bytes: new TextEncoder().encode(body).length,
      origin: origin,
      ...(source.commitSha ? { commitSha: source.commitSha } : {}),
    },
  });
}
