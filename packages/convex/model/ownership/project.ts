import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

/**
 * Loads a project only when it belongs to the authenticated user.
 * @param ctx Convex read or write context
 * @param authId WorkOS user id for the caller
 * @param projectId Project document id
 * @returns Project document or null when missing or unauthorized
 */
export async function getOwnedProject(
    ctx: QueryCtx | MutationCtx,
    authId: string,
    projectId: Id<"projects">,
) {
    const project = await ctx.db.get(projectId);
    if (!project || project.authId !== authId) {
        return null;
    }

    return project;
}
