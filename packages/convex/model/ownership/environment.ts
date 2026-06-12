/**
 * Environment ownership lookups for auth-gated read/write contexts.
 */

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { getOwnedProject } from "./project";

export async function getOwnedEnvironment(
    ctx: QueryCtx | MutationCtx,
    authId: string,
    environmentId: Id<"environments">,
) {
    const environment = await ctx.db.get(environmentId);
    if (!environment) return null;

    const project = await getOwnedProject(ctx, authId, environment.projectId);
    if (!project) return null;

    return environment;
}
