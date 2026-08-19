/**
 * Stage ownership lookups for auth-gated read/write contexts.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { getOwnedProject } from "./project";

export async function getOwnedStage(
  ctx: QueryCtx | MutationCtx,
  authId: string,
  stageId: Id<"stages">,
): Promise<Doc<"stages"> | null> {
  const stage = await ctx.db.get(stageId);
  if (!stage) return null;

  const project = await getOwnedProject(ctx, authId, stage.projectId);
  if (!project) return null;

  return stage;
}
