import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { getOwnedProject } from "./project";

/**
 * Loads an environment only when it belongs to the authenticated user and project.
 * @param ctx Convex read or write context
 * @param authId WorkOS user id for the caller
 * @param environmentId Environment document id
 * @returns Environment document or null when missing or unauthorized
 */
export async function getOwnedEnvironment(
    ctx: QueryCtx | MutationCtx,
    authId: string,
    environmentId: Id<"environments">,
) {
    const environment = await ctx.db.get(environmentId);
    if (!environment || environment.authId !== authId) {
        return null;
    }

    const project = await getOwnedProject(ctx, authId, environment.projectId);
    if (!project) {
        return null;
    }

    return environment;
}
