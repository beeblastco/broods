/**
 * Org membership lookups and role enforcement.
 */

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

export type OrgRole = "owner" | "admin" | "member";

const ROLE_RANK: Record<OrgRole, number> = {
    owner: 3,
    admin: 2,
    member: 1,
};

export async function getOrgMembership(
    ctx: QueryCtx | MutationCtx,
    orgId: Id<"orgs">,
    userId: Id<"users">,
) {
    const membership = await ctx.db
        .query("orgMembers")
        .withIndex("by_orgId_and_userId", (q) =>
            q.eq("orgId", orgId).eq("userId", userId),
        )
        .unique();

    return membership ?? null;
}

/**
 * Most recently created org for the user, or null when they belong to none.
 */
export async function getActiveOrgForUser(
    ctx: QueryCtx | MutationCtx,
    userId: Id<"users">,
) {
    const memberships = await ctx.db
        .query("orgMembers")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect();
    if (memberships.length === 0) return null;

    const newest = memberships.sort((a, b) => b.createdAt - a.createdAt)[0];
    const org = await ctx.db.get(newest.orgId);

    return org ?? null;
}

export async function requireOrgMember(
    ctx: QueryCtx | MutationCtx,
    orgId: Id<"orgs">,
    userId: Id<"users">,
    requiredRole?: OrgRole,
) {
    const membership = await getOrgMembership(ctx, orgId, userId);
    if (!membership) {
        throw new Error("Not a member of this org");
    }
    if (requiredRole && ROLE_RANK[membership.role] < ROLE_RANK[requiredRole]) {
        throw new Error(`Role ${requiredRole} required; caller has ${membership.role}`);
    }

    return membership;
}
