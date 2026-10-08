import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { defaultStage } from "../defaultStage";
import type { OrgRole } from "./org";
import { getProjectForRole } from "./project";

export async function getOwnedStage(
  ctx: QueryCtx | MutationCtx,
  authId: string,
  stageId: Id<"stages">,
  requiredRole?: OrgRole,
): Promise<Doc<"stages"> | null> {
  const stage = await ctx.db.get(stageId);
  if (!stage) return null;

  const project = await getProjectForRole(
    ctx,
    authId,
    stage.projectId,
    requiredRole,
  );
  if (!project) return null;

  return stage;
}

/**
 * A stage of `projectId` the caller can read: `stageId` when given, else the
 * project's default stage. Null on any miss, so a reactive subscriber holding
 * a just-deleted project or stage gets an empty answer instead of a throw.
 */
export async function getProjectStage(
  ctx: QueryCtx | MutationCtx,
  authId: string,
  projectId: Id<"projects">,
  stageId: Id<"stages"> | undefined,
): Promise<Doc<"stages"> | null> {
  if (stageId) {
    const stage = await getOwnedStage(ctx, authId, stageId);

    return stage?.projectId === projectId ? stage : null;
  }
  if (!(await getProjectForRole(ctx, authId, projectId))) return null;
  const stages = await ctx.db
    .query("stages")
    .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
    .collect();

  return defaultStage(stages) ?? null;
}
