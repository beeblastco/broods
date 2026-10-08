import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

export type OrgRole = "owner" | "admin" | "member";

const ROLE_RANK: Record<OrgRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

export function orgRoleMeets(role: OrgRole, requiredRole?: OrgRole): boolean {
  return !requiredRole || ROLE_RANK[role] >= ROLE_RANK[requiredRole];
}

/** The user row behind an auth id, or null before the WorkOS webhook has synced it. */
export async function userByAuthId(
  ctx: QueryCtx | MutationCtx,
  authId: string,
): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("by_authId", (q) => q.eq("authId", authId))
    .unique();
}

/** The org behind an account; null for a service account bound to no org. */
export function orgIdOf(
  ctx: QueryCtx | MutationCtx,
  account: Doc<"accounts">,
): Id<"orgs"> | null {
  return ctx.db.normalizeId("orgs", account.orgId);
}

export async function getOrgMembership(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"orgs">,
  userId: Id<"users">,
): Promise<Doc<"orgMembers"> | null> {
  const membership = await ctx.db
    .query("orgMembers")
    .withIndex("by_orgId_and_userId", (q) =>
      q.eq("orgId", orgId).eq("userId", userId),
    )
    .unique();

  return membership ?? null;
}

/**
 * Returns the user's explicitly-chosen active org when set and still valid,
 * otherwise the oldest membership. Oldest, not newest, because any org admin
 * can add a user without consent, and that membership is always newer than the
 * user's own. Null if the user belongs to none.
 */
export async function getActiveOrgForUser(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Doc<"orgs"> | null> {
  const memberships = await ctx.db
    .query("orgMembers")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  if (memberships.length === 0) return null;

  const user = await ctx.db.get(userId);
  if (user?.activeOrgId) {
    const stillMember = memberships.some((m) => m.orgId === user.activeOrgId);
    if (stillMember) {
      const org = await ctx.db.get(user.activeOrgId);
      if (org) return org;
    }
  }

  const oldest = memberships.sort((a, b) => a.createdAt - b.createdAt)[0];
  const org = await ctx.db.get(oldest.orgId);

  return org ?? null;
}

export async function requireOrgMember(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"orgs">,
  userId: Id<"users">,
  requiredRole?: OrgRole,
): Promise<Doc<"orgMembers">> {
  const membership = await getOrgMembership(ctx, orgId, userId);
  if (!membership) {
    throw new Error("Not a member of this org");
  }
  if (!orgRoleMeets(membership.role, requiredRole)) {
    throw new Error(
      `Role ${requiredRole} required; caller has ${membership.role}`,
    );
  }

  return membership;
}
