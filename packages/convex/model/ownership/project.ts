/**
 * Project ownership lookups for auth-gated read/write contexts.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { getOrgMembership, orgRoleMeets, type OrgRole } from "./org";

export async function getProjectForRole(
  ctx: QueryCtx | MutationCtx,
  authId: string,
  projectId: Id<"projects">,
  requiredRole?: OrgRole,
): Promise<Doc<"projects"> | null> {
  const project = await ctx.db.get(projectId);
  if (!project) return null;
  // The org owner and the membership rows are the sole authority, so a
  // removed or demoted project creator loses access the moment their role
  // changes.
  const org = await ctx.db.get(project.orgId);
  if (!org) return null;
  if (org.ownerAuthId === authId) return project;

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
