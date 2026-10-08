/**
 * Org membership management: list members, add by email, change role, remove.
 * Reads gated on caller being a member; writes on `members:write`, which
 * owners and admins hold by tier and a custom role may grant.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { authKit } from "../auth";
import {
  activePolicies,
  dashboardPermissions,
  memberAccess,
  requireDashboardPermission,
} from "../model/access";
import { actorsOf, actorValidator } from "../model/actor";
import { ClientError } from "../model/clientError";
import {
  getOrgMembership,
  orgRoleMeets,
  requireOrgMember,
  userByAuthId,
} from "../model/ownership/org";

const roleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
);

const memberRow = v.object({
  membershipId: v.id("orgMembers"),
  userId: v.id("users"),
  role: roleValidator,
  roleId: v.optional(v.id("orgRoles")),
  /** The custom role's name, when the member holds one. */
  roleName: v.optional(v.string()),
  invitedBy: v.optional(actorValidator),
  createdAt: v.number(),
  email: v.string(),
  name: v.string(),
  avatarUrl: v.optional(v.string()),
  isOwner: v.boolean(),
});

/** Lists every member of an org with their user profile, caller must be a member. */
export const list = query({
  args: { orgId: v.id("orgs") },
  returns: v.array(memberRow),
  handler: async (ctx, args) => {
    const { orgId } = args;

    // Check authenticated user
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) {
      throw new Error("User not found or not authenticated");
    }

    const user = await userByAuthId(ctx, authUser.id);
    if (!user) {
      return [];
    }

    await requireOrgMember(ctx, orgId, user._id);

    const org = await ctx.db.get(orgId);
    if (!org) return [];

    const memberships = (
      await ctx.db
        .query("orgMembers")
        .withIndex("by_orgId_and_userId", (q) => q.eq("orgId", orgId))
        .collect()
    ).sort((left, right) => left.createdAt - right.createdAt);
    const [users, roles, inviters] = await Promise.all([
      Promise.all(memberships.map((m) => ctx.db.get(m.userId))),
      ctx.db
        .query("orgRoles")
        .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
        .collect(),
      actorsOf(
        ctx,
        memberships.map((m) => m.invitedBy),
      ),
    ]);

    const rows = memberships.map((m, index) => {
      const u = users[index];
      const customRole = roles.find((role) => role._id === m.roleId);

      return {
        membershipId: m._id,
        userId: m.userId,
        role: m.role,
        roleId: customRole?._id,
        roleName: customRole?.name,
        invitedBy: m.invitedBy ? inviters.get(m.invitedBy) : undefined,
        createdAt: m.createdAt,
        email: u?.email ?? "(unknown)",
        name: u?.name ?? "(unknown)",
        avatarUrl: u?.avatarUrl,
        isOwner: u?.authId === org.ownerAuthId,
      };
    });

    return rows.sort((a, b) => {
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;

      return a.createdAt - b.createdAt;
    });
  },
});

/**
 * Adds an existing user to the org by email, on a tier or with a custom
 * role. Errors if the email does not match a synced user row or the user is
 * already a member.
 */
export const add = mutation({
  args: {
    orgId: v.id("orgs"),
    email: v.string(),
    role: v.optional(roleValidator),
    /** A custom role, which puts the member on the member tier. */
    roleId: v.optional(v.id("orgRoles")),
  },
  returns: v.id("orgMembers"),
  handler: async (ctx, args): Promise<Id<"orgMembers">> => {
    const { orgId, email } = args;
    const role = args.roleId ? "member" : (args.role ?? "member");

    // Check authenticated user
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) {
      throw new Error("User not found or not authenticated");
    }

    const caller = await userByAuthId(ctx, authUser.id);
    if (!caller) {
      throw new Error("User row not found");
    }

    const callerMembership = await requireOrgMember(ctx, orgId, caller._id);
    await requireDashboardPermission(ctx, orgId, caller, "members:write");
    assertCanTouchOwnerRole(callerMembership, role);
    await assertWithinReach(ctx, orgId, caller, role, args.roleId);

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      throw new Error("Email is required");
    }

    const target = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", normalizedEmail))
      .unique();
    if (!target) {
      throw new Error(
        "No user with that email. They must sign in once before being added.",
      );
    }

    const existing = await getOrgMembership(ctx, orgId, target._id);
    if (existing) {
      throw new Error("User is already a member of this org");
    }

    const membershipId = await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: target._id,
      role: role,
      roleId: args.roleId,
      invitedBy: caller._id,
      createdAt: Date.now(),
    });

    return membershipId;
  },
});

/** Puts a member on a tier, or on a custom role (the member tier). Cannot demote the org owner. */
export const updateRole = mutation({
  args: {
    membershipId: v.id("orgMembers"),
    role: roleValidator,
    /** A custom role, which puts the member on the member tier; absent clears it. */
    roleId: v.optional(v.id("orgRoles")),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { membershipId } = args;
    const role = args.roleId ? "member" : args.role;

    // Check authenticated user
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) {
      throw new Error("User not found or not authenticated");
    }

    const caller = await userByAuthId(ctx, authUser.id);
    if (!caller) {
      throw new Error("User row not found");
    }

    const membership = await ctx.db.get(membershipId);
    if (!membership) {
      throw new Error("Membership not found");
    }

    const callerMembership = await requireOrgMember(
      ctx,
      membership.orgId,
      caller._id,
    );
    await requireDashboardPermission(
      ctx,
      membership.orgId,
      caller,
      "members:write",
    );
    assertCanTouchOwnerRole(callerMembership, membership.role);
    assertCanTouchOwnerRole(callerMembership, role);
    await assertWithinReach(ctx, membership.orgId, caller, role, args.roleId);
    await assertWithinReach(ctx, membership.orgId, caller, membership.role);

    const targetUser = await ctx.db.get(membership.userId);
    const org = await ctx.db.get(membership.orgId);
    if (
      targetUser &&
      org &&
      targetUser.authId === org.ownerAuthId &&
      role !== "owner"
    ) {
      throw new Error("Cannot change the role of the org owner");
    }

    await ctx.db.patch(membershipId, { role: role, roleId: args.roleId });

    return null;
  },
});

/** Removes a member from the org. Cannot remove the org owner. */
export const remove = mutation({
  args: { membershipId: v.id("orgMembers") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { membershipId } = args;

    // Check authenticated user
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) {
      throw new Error("User not found or not authenticated");
    }

    const caller = await userByAuthId(ctx, authUser.id);
    if (!caller) {
      throw new Error("User row not found");
    }

    const membership = await ctx.db.get(membershipId);
    if (!membership) {
      throw new Error("Membership not found");
    }

    const callerMembership = await requireOrgMember(
      ctx,
      membership.orgId,
      caller._id,
    );
    await requireDashboardPermission(
      ctx,
      membership.orgId,
      caller,
      "members:write",
    );
    assertCanTouchOwnerRole(callerMembership, membership.role);
    await assertWithinReach(ctx, membership.orgId, caller, membership.role);

    const targetUser = await ctx.db.get(membership.userId);
    const org = await ctx.db.get(membership.orgId);
    if (targetUser && org && targetUser.authId === org.ownerAuthId) {
      throw new Error("Cannot remove the org owner");
    }

    await ctx.db.delete(membershipId);

    return null;
  },
});

/**
 * Owner memberships can delete the org, so only an owner may grant one, or
 * change or remove one. Without this an admin could promote themselves.
 */
/**
 * A caller grants and touches no more than they hold: the admin tier only
 * from the admin tier, a custom role only when every permission it grants
 * is one the caller has. Otherwise `members:write` would be a way up.
 */
async function assertWithinReach(
  ctx: Parameters<typeof getOrgMembership>[0],
  orgId: Id<"orgs">,
  caller: Doc<"users">,
  tier: Doc<"orgMembers">["role"],
  roleId?: Id<"orgRoles">,
): Promise<void> {
  const access = await memberAccess(ctx, orgId, caller);
  if (!access || !orgRoleMeets(access.tier, tier)) {
    throw new ClientError(
      `Only an ${tier} can grant or change the ${tier} tier`,
    );
  }
  if (!roleId) return;
  const role = await ctx.db.get(roleId);
  if (!role || role.orgId !== orgId) {
    throw new ClientError("Role not found");
  }
  const held = dashboardPermissions(access);
  const beyond = dashboardPermissions({
    tier: "member",
    policies: await activePolicies(ctx, role.policyIds),
  }).filter((permission) => !held.includes(permission));
  if (beyond.length > 0) {
    throw new ClientError(
      `That role grants ${beyond.join(", ")}, which you do not hold`,
    );
  }
}

function assertCanTouchOwnerRole(
  caller: Doc<"orgMembers">,
  role: Doc<"orgMembers">["role"] | undefined,
): void {
  if (role === "owner" && caller.role !== "owner") {
    throw new Error("Only an owner can grant, change or remove the owner role");
  }
}
