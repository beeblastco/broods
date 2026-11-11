// Every dashboard page subscribes to these, and Convex loads a file's whole import graph per
// call: import only the schema, the sign-in and the ownership checks here.
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { authKit } from "./auth";
import { getActiveCaller } from "./model/activeCaller";
import { byDefaultThenName } from "./model/defaultStage";
import {
  getActiveOrgForUser,
  userByAuthId,
  type OrgRole,
} from "./model/ownership/org";
import { getProjectForRole } from "./model/ownership/project";
import {
  orgMembersFields,
  orgsFields,
  projectsFields,
  stagesFields,
} from "./schema";

export const orgDoc = v.object({
  ...orgsFields,
  _id: v.id("orgs"),
  _creationTime: v.number(),
});

const orgRoleValidator = orgMembersFields.role;

const projectDoc = v.object({
  ...projectsFields,
  _id: v.id("projects"),
  _creationTime: v.number(),
});

const stageDoc = v.object({
  ...stagesFields,
  _id: v.id("stages"),
  _creationTime: v.number(),
});

type Ctx = QueryCtx | MutationCtx;

// The role only shapes what the dashboard shows; every mutation checks it again.
export const activeAccount = query({
  args: {
    requiredRole: v.optional(orgRoleValidator),
  },
  returns: v.union(
    v.object({
      accountId: v.id("accounts"),
      status: v.union(v.literal("active"), v.literal("disabled")),
      role: orgRoleValidator,
    }),
    v.null(),
  ),
  handler: async (
    ctx,
    { requiredRole },
  ): Promise<{
    accountId: Id<"accounts">;
    status: "active" | "disabled";
    role: OrgRole;
  } | null> => {
    const active = await getActiveCaller(ctx, requiredRole);
    if (!active) return null;

    return {
      accountId: active.account._id,
      status: active.account.status,
      role: active.role,
    };
  },
});

export const activeOrg = query({
  args: {},
  returns: v.union(orgDoc, v.null()),
  handler: async (ctx): Promise<Doc<"orgs"> | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) {
      return null;
    }

    const user = await userByAuthId(ctx, authUser.id);
    if (!user) {
      return null;
    }

    const org = await getActiveOrgForUser(ctx, user._id);

    return org ?? null;
  },
});

export const orgs = query({
  args: {},
  returns: v.array(orgDoc),
  handler: async (ctx): Promise<Doc<"orgs">[]> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) {
      return [];
    }

    const user = await userByAuthId(ctx, authUser.id);
    if (!user) {
      return [];
    }

    const memberships = await ctx.db
      .query("orgMembers")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();

    const orgs = await Promise.all(
      memberships.map((membership) => ctx.db.get(membership.orgId)),
    );

    return orgs.filter((org): org is NonNullable<typeof org> => org !== null);
  },
});

export const projectById = query({
  args: { projectId: v.id("projects") },
  returns: v.union(v.null(), projectDoc),
  handler: async (ctx, { projectId }): Promise<Doc<"projects"> | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    return getProjectForRole(ctx, authUser.id, projectId);
  },
});

// Soft auth: during the first-login WorkOS webhook gap the dashboard must get [], not a throw.
export const projects = query({
  args: {},
  returns: v.array(projectDoc),
  handler: async (ctx): Promise<Doc<"projects">[]> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) return [];

    return listProjects(ctx, await getCallerActiveOrgId(ctx, authUser.id));
  },
});

export const stages = query({
  args: { projectId: v.id("projects") },
  returns: v.array(stageDoc),
  handler: async (ctx, { projectId }): Promise<Doc<"stages">[]> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    return listStagesForProject(ctx, authUser.id, projectId);
  },
});

export async function getCallerActiveOrgId(
  ctx: Ctx,
  authId: string,
): Promise<Id<"orgs"> | null> {
  const user = await userByAuthId(ctx, authId);
  if (!user) return null;

  const org = await getActiveOrgForUser(ctx, user._id);

  return org?._id ?? null;
}

export async function listProjects(
  ctx: Ctx,
  orgId: Id<"orgs"> | null,
): Promise<Doc<"projects">[]> {
  if (orgId === null) return [];

  const orgProjects = await ctx.db
    .query("projects")
    .withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId))
    .collect();

  return orgProjects.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Split from `stages` for tests: convex-test cannot run AuthKit.
export async function listStagesForProject(
  ctx: Ctx,
  authId: string,
  projectId: Id<"projects">,
): Promise<Doc<"stages">[]> {
  // Empty, not a throw: a just-deleted project must not crash reactive subscribers.
  const project = await getProjectForRole(ctx, authId, projectId);
  if (!project) return [];

  const stages = await ctx.db
    .query("stages")
    .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
    .collect();

  return stages.sort(byDefaultThenName);
}
