/**
 * Project ownership lookups for auth-gated read/write contexts.
 */

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

export async function getOwnedProject(
    ctx: QueryCtx | MutationCtx,
    authId: string,
    projectId: Id<"projects">,
) {
    const project = await ctx.db.get(projectId);
    if (!project || project.authId !== authId) return null;
    return project;
}
