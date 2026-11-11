import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { authKit } from "../auth";
import {
  activePolicies,
  assertGrantsWithinReach,
  memberAccess,
  requireDashboardPermission,
} from "../model/access";
import { actorsOf, actorValidator } from "../model/actor";
import {
  appendAuditEvent,
  auditDetailsJson,
  dashboardAuditActor,
} from "../model/auditEvents";
import { ClientError } from "../model/clientError";
import { releaseSeat } from "../model/orgBilling";
import {
  type getOrgMembership,
  orgRoleMeets,
  requireOrgMember,
  userByAuthId,
} from "../model/ownership/org";

export const roleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
);

const memberRow = v.object({
  membershipId: v.id("orgMembers"),
  userId: v.id("users"),
  role: roleValidator,
  roleId: v.optional(v.id("orgRoles")),
  roleName: v.optional(v.string()),
  invitedBy: v.optional(actorValidator),
  createdAt: v.number(),
  email: v.string(),
  name: v.string(),
  avatarUrl: v.optional(v.string()),
  isOwner: v.boolean(),
});

export const list = query({
  args: { orgId: v.id("orgs") },
  returns: v.array(memberRow),
  handler: async (ctx, args) => {
    const { orgId } = args;

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

export const updateRole = mutation({
  args: {
    membershipId: v.id("orgMembers"),
    role: roleValidator,
    roleId: v.optional(v.id("orgRoles")),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { membershipId } = args;
    const role = args.roleId ? "member" : args.role;

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
    await assertWithinReach(
      ctx,
      membership.orgId,
      caller,
      membership.role,
      membership.roleId,
    );

    const targetUser = await ctx.db.get(membership.userId);
    const org = await ctx.db.get(membership.orgId);
    if (
      targetUser &&
      org &&
      targetUser.authId === org.ownerAuthId &&
      role !== "owner"
    ) {
      throw new ClientError(
        "Cannot change the role of the org owner",
        "forbidden",
      );
    }

    await ctx.db.patch(membershipId, { role: role, roleId: args.roleId });
    await recordMemberAudit(ctx, caller, targetUser?.email, "role-changed", {
      orgId: membership.orgId,
      id: membershipId,
      role: role,
      roleId: args.roleId,
    });

    return null;
  },
});

export const remove = mutation({
  args: { membershipId: v.id("orgMembers") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { membershipId } = args;

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
    await assertWithinReach(
      ctx,
      membership.orgId,
      caller,
      membership.role,
      membership.roleId,
    );

    const targetUser = await ctx.db.get(membership.userId);
    const org = await ctx.db.get(membership.orgId);
    if (targetUser && org && targetUser.authId === org.ownerAuthId) {
      throw new ClientError("Cannot remove the org owner", "forbidden");
    }

    await ctx.db.delete(membershipId);
    await releaseSeat(ctx, membership.orgId);
    await recordMemberAudit(ctx, caller, targetUser?.email, "removed", {
      orgId: membership.orgId,
      id: membershipId,
      role: membership.role,
      roleId: membership.roleId,
    });

    return null;
  },
});

export const leave = mutation({
  args: { orgId: v.id("orgs") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const caller = await signedInUser(ctx);
    const membership = await requireOrgMember(ctx, args.orgId, caller._id);
    const org = await ctx.db.get(args.orgId);
    if (org?.ownerAuthId === caller.authId) {
      throw new ClientError(
        "The owner cannot leave. Delete the organization in Danger Zone instead.",
        "forbidden",
      );
    }

    await ctx.db.delete(membership._id);
    await releaseSeat(ctx, args.orgId);
    await recordMemberAudit(ctx, caller, caller.email, "left", {
      orgId: args.orgId,
      id: membership._id,
      role: membership.role,
      roleId: membership.roleId,
    });

    return null;
  },
});

// A caller grants and touches no more than they hold, or `members:write` would be a way up.
export async function assertWithinReach(
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
  await assertGrantsWithinReach(
    ctx,
    orgId,
    caller,
    await activePolicies(ctx, role.policyIds),
  );
}

// Owner memberships can delete the org: without this an admin could promote themselves.
export function assertCanTouchOwnerRole(
  caller: Doc<"orgMembers">,
  role: Doc<"orgMembers">["role"] | undefined,
): void {
  if (role === "owner" && caller.role !== "owner") {
    throw new ClientError(
      "Only an owner can grant, change or remove the owner role",
      "forbidden",
    );
  }
}

// The ledger is the org account's: an org with no account yet records nothing.
export async function recordMemberAudit(
  ctx: MutationCtx,
  caller: Doc<"users">,
  targetEmail: string | undefined,
  action: string,
  membership: {
    orgId: Id<"orgs">;
    id: Id<"orgMembers"> | Id<"orgInvitations">;
    role: Doc<"orgMembers">["role"];
    roleId?: Id<"orgRoles">;
  },
): Promise<void> {
  const account = await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", membership.orgId))
    .unique();
  if (!account) return;

  await appendAuditEvent(ctx.db, {
    accountId: account._id,
    actor: dashboardAuditActor({
      id: caller.authId,
      email: caller.email,
      name: caller.name,
    }),
    action: action,
    resource: {
      kind: "member",
      id: membership.id,
      name: targetEmail,
    },
    summary: `Member ${action.replace("-", " ")}`,
    detailsJson: auditDetailsJson({
      role: membership.role,
      roleId: membership.roleId,
    }),
  });
}

export async function signedInUser(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users">> {
  const authUser = await authKit.getAuthUser(ctx);
  if (!authUser) {
    throw new Error("User not found or not authenticated");
  }
  const user = await userByAuthId(ctx, authUser.id);
  if (!user) {
    throw new Error("User row not found");
  }

  return user;
}
