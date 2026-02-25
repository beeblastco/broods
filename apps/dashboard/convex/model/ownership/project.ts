/**
 * Project ownership verification helper.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

/**
 * Verify project ownership and return the project record.
 * @param ctx Query or mutation context
 * @param projectId Project document ID
 * @param authId User's authentication ID
 * @returns Project document
 * @throws Error if project not found or user doesn't own it
 */
export async function verifyProjectOwnership(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
  authId: string,
): Promise<Doc<"projects">> {
  const project = await ctx.db.get(projectId);
  if (!project) {
    throw new Error("Project not found");
  }
  if (project.authId !== authId) {
    throw new Error("Access denied");
  }

  return project;
}
