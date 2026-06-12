/**
 * Project ownership lookups for auth-gated read/write contexts.
 */

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { getOrgMembership, orgRoleMeets, type OrgRole } from "./org";

export async function getOwnedProject(
    ctx: QueryCtx | MutationCtx,
    authId: string,
    projectId: Id<"projects">,
) {
    return getProjectForRole(ctx, authId, projectId);
}

export async function getProjectForRole(
    ctx: QueryCtx | MutationCtx,
    authId: string,
    projectId: Id<"projects">,
    requiredRole?: OrgRole,
) {
    const project = await ctx.db.get(projectId);
    if (!project) return null;
    if (project.authId === authId) return project;
    if (!project.orgId) return null;

    const user = await ctx.db
        .query("users")
        .withIndex("by_authId", (q) => q.eq("authId", authId))
        .unique();
    if (!user) return null;

    const membership = await getOrgMembership(ctx, project.orgId, user._id);
    if (!membership) return null;
    if (!orgRoleMeets(membership.role, requiredRole)) return null;

    return project;
}
