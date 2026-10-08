/**
 * Org membership management: list members, add by email, change role, remove.
 * Reads gated on caller being a member; writes gated on admin role.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { authKit } from "../auth";
import { getOrgMembership, requireOrgMember } from "../model/ownership/org";

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
  invitedBy: v.optional(
    v.object({ name: v.string(), avatarUrl: v.optional(v.string()) }),
  ),
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

    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
      .unique();
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

    const rows = await Promise.all(
      memberships.map(async (m) => {
        const u = await ctx.db.get(m.userId);
        const customRole = m.roleId ? await ctx.db.get(m.roleId) : null;
        const inviter = m.invitedBy ? await ctx.db.get(m.invitedBy) : null;

        return {
          membershipId: m._id,
          userId: m.userId,
          role: m.role,
          roleId: customRole?._id,
          roleName: customRole?.name,
          invitedBy: inviter
            ? { name: inviter.name, avatarUrl: inviter.avatarUrl }
            : undefined,
          createdAt: m.createdAt,
          email: u?.email ?? "(unknown)",
          name: u?.name ?? "(unknown)",
          avatarUrl: u?.avatarUrl,
          isOwner: u?.authId === org.ownerAuthId,
        };
      }),
    );

    return rows.sort((a, b) => {
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;

      return a.createdAt - b.createdAt;
    });
  },
});

/**
 * Adds an existing user to the org by email. Admin only. Errors if the email
 * does not match a synced user row or the user is already a member.
 */
export const add = mutation({
  args: {
    orgId: v.id("orgs"),
    email: v.string(),
    role: v.optional(roleValidator),
  },
  returns: v.id("orgMembers"),
  handler: async (ctx, args): Promise<Id<"orgMembers">> => {
    const { orgId, email, role } = args;

    // Check authenticated user
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) {
      throw new Error("User not found or not authenticated");
    }

    const caller = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
      .unique();
    if (!caller) {
      throw new Error("User row not found");
    }

    const callerMembership = await requireOrgMember(
      ctx,
      orgId,
      caller._id,
      "admin",
    );
    assertCanTouchOwnerRole(callerMembership, role);

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
      role: role ?? "member",
      invitedBy: caller._id,
      createdAt: Date.now(),
    });

    return membershipId;
  },
});

/** Updates a member's role. Admin only. Cannot demote the org owner. */
export const updateRole = mutation({
  args: {
    membershipId: v.id("orgMembers"),
    role: roleValidator,
    /** A custom role on the member tier; null or absent clears it. */
    roleId: v.optional(v.union(v.id("orgRoles"), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { membershipId, role } = args;
    const customRoleId = args.roleId ?? undefined;

    // Check authenticated user
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) {
      throw new Error("User not found or not authenticated");
    }

    const caller = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
      .unique();
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
      "admin",
    );
    assertCanTouchOwnerRole(callerMembership, membership.role);
    assertCanTouchOwnerRole(callerMembership, role);

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

    if (customRoleId) {
      const customRole = await ctx.db.get(customRoleId);
      if (!customRole || customRole.orgId !== membership.orgId) {
        throw new Error("Role not found");
      }
    }
    await ctx.db.patch(membershipId, {
      role: customRoleId ? "member" : role,
      roleId: customRoleId,
    });

    return null;
  },
});

/** Removes a member from the org. Admin only. Cannot remove the org owner. */
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

    const caller = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
      .unique();
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
      "admin",
    );
    assertCanTouchOwnerRole(callerMembership, membership.role);

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
function assertCanTouchOwnerRole(
  caller: Doc<"orgMembers">,
  role: Doc<"orgMembers">["role"] | undefined,
): void {
  if (role === "owner" && caller.role !== "owner") {
    throw new Error("Only an owner can grant, change or remove the owner role");
  }
}
