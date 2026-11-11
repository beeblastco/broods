import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { authKit } from "../auth";
import { requireDashboardPermission } from "../model/access";
import { actorsOf, actorValidator } from "../model/actor";
import { ClientError } from "../model/clientError";
import { assertFreeSeat, releaseSeat } from "../model/orgBilling";
import {
  getOrgMembership,
  requireOrgMember,
  syncInvited,
  userByAuthId,
} from "../model/ownership/org";
import {
  assertCanTouchOwnerRole,
  assertWithinReach,
  recordMemberAudit,
  roleValidator,
} from "./members";

const invitationRow = v.object({
  invitationId: v.id("orgInvitations"),
  email: v.string(),
  role: roleValidator,
  roleName: v.optional(v.string()),
  invitedBy: v.optional(actorValidator),
  createdAt: v.number(),
  hasAccount: v.boolean(),
});

const myInvitationRow = v.object({
  invitationId: v.id("orgInvitations"),
  orgId: v.id("orgs"),
  orgName: v.string(),
  role: roleValidator,
  roleName: v.optional(v.string()),
  invitedBy: v.optional(actorValidator),
});

// Reserves the developer seat now, while the payer is at the keyboard; accepting never pays.
export const create = mutation({
  args: {
    orgId: v.id("orgs"),
    email: v.string(),
    role: v.optional(roleValidator),
    roleId: v.optional(v.id("orgRoles")),
  },
  returns: v.id("orgInvitations"),
  handler: async (ctx, args): Promise<Id<"orgInvitations">> => {
    const { orgId } = args;
    const role = args.roleId ? "member" : (args.role ?? "member");
    const caller = await signedInUser(ctx);

    const callerMembership = await requireOrgMember(ctx, orgId, caller._id);
    await requireDashboardPermission(ctx, orgId, caller, "members:write");
    assertCanTouchOwnerRole(callerMembership, role);
    await assertWithinReach(ctx, orgId, caller, role, args.roleId);

    const email = args.email.trim().toLowerCase();
    if (!email) {
      throw new ClientError("Email is required");
    }
    const target = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (target && (await getOrgMembership(ctx, orgId, target._id))) {
      throw new ClientError("User is already a member of this org", "conflict");
    }
    const pending = await ctx.db
      .query("orgInvitations")
      .withIndex("by_orgId_and_email", (q) =>
        q.eq("orgId", orgId).eq("email", email),
      )
      .first();
    if (pending) {
      throw new ClientError("That email already has an invitation", "conflict");
    }
    const org = await ctx.db.get(orgId);
    if (!org) {
      throw new ClientError("Org not found", "not_found");
    }
    await assertFreeSeat(ctx, org, target?._id ?? email);

    const invitationId = await ctx.db.insert("orgInvitations", {
      orgId: orgId,
      email: email,
      userId: target?._id,
      role: role,
      roleId: args.roleId,
      invitedBy: caller._id,
      createdAt: Date.now(),
    });
    await syncInvited(ctx, target?._id);
    await recordMemberAudit(ctx, caller, target, "invited", {
      orgId: orgId,
      id: invitationId,
      role: role,
      roleId: args.roleId,
    });

    return invitationId;
  },
});

export const list = query({
  args: { orgId: v.id("orgs") },
  returns: v.array(invitationRow),
  handler: async (ctx, args) => {
    const caller = await signedInUser(ctx);
    await requireOrgMember(ctx, args.orgId, caller._id);
    await requireDashboardPermission(ctx, args.orgId, caller, "members:write");

    const invitations = await ctx.db
      .query("orgInvitations")
      .withIndex("by_orgId_and_email", (q) => q.eq("orgId", args.orgId))
      .collect();
    const [inviters, roleNames] = await Promise.all([
      actorsOf(
        ctx,
        invitations.map((invitation) => invitation.invitedBy),
      ),
      customRoleNames(ctx, invitations),
    ]);

    return invitations
      .map((invitation) => ({
        invitationId: invitation._id,
        email: invitation.email,
        role: invitation.role,
        roleName: invitation.roleId && roleNames.get(invitation.roleId),
        invitedBy: inviters.get(invitation.invitedBy),
        createdAt: invitation.createdAt,
        hasAccount: invitation.userId !== undefined,
      }))
      .sort((left, right) => left.createdAt - right.createdAt);
  },
});

export const listMine = query({
  args: {},
  returns: v.array(myInvitationRow),
  handler: async (ctx) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) return [];
    const user = await userByAuthId(ctx, authUser.id);
    if (!user) return [];

    const invitations = await ctx.db
      .query("orgInvitations")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();
    const [orgs, inviters, roleNames] = await Promise.all([
      Promise.all(
        invitations.map((invitation) => ctx.db.get(invitation.orgId)),
      ),
      actorsOf(
        ctx,
        invitations.map((invitation) => invitation.invitedBy),
      ),
      customRoleNames(ctx, invitations),
    ]);

    return invitations.flatMap((invitation, index) => {
      const org = orgs[index];

      return org
        ? [
            {
              invitationId: invitation._id,
              orgId: org._id,
              orgName: org.name,
              role: invitation.role,
              roleName: invitation.roleId && roleNames.get(invitation.roleId),
              invitedBy: inviters.get(invitation.invitedBy),
            },
          ]
        : [];
    });
  },
});

export const accept = mutation({
  args: { invitationId: v.id("orgInvitations") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { caller, invitation } = await ownInvitation(ctx, args.invitationId);
    await ctx.db.delete(invitation._id);
    await syncInvited(ctx, caller._id);
    if (await getOrgMembership(ctx, invitation.orgId, caller._id)) return null;

    const membershipId = await ctx.db.insert("orgMembers", {
      orgId: invitation.orgId,
      userId: caller._id,
      role: invitation.role,
      roleId: invitation.roleId,
      invitedBy: invitation.invitedBy,
      createdAt: Date.now(),
    });
    await recordMemberAudit(ctx, caller, caller, "joined", {
      orgId: invitation.orgId,
      id: membershipId,
      role: invitation.role,
      roleId: invitation.roleId,
    });

    return null;
  },
});

export const decline = mutation({
  args: { invitationId: v.id("orgInvitations") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { caller, invitation } = await ownInvitation(ctx, args.invitationId);
    await dropInvitation(ctx, caller, invitation, "invitation-declined");

    return null;
  },
});

export const revoke = mutation({
  args: { invitationId: v.id("orgInvitations") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const caller = await signedInUser(ctx);
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation) {
      throw new ClientError("Invitation not found", "not_found");
    }
    const callerMembership = await requireOrgMember(
      ctx,
      invitation.orgId,
      caller._id,
    );
    await requireDashboardPermission(
      ctx,
      invitation.orgId,
      caller,
      "members:write",
    );
    assertCanTouchOwnerRole(callerMembership, invitation.role);
    await assertWithinReach(
      ctx,
      invitation.orgId,
      caller,
      invitation.role,
      invitation.roleId,
    );
    await dropInvitation(ctx, caller, invitation, "invitation-revoked");

    return null;
  },
});

async function customRoleNames(
  ctx: QueryCtx | MutationCtx,
  invitations: Array<Doc<"orgInvitations">>,
): Promise<Map<Id<"orgRoles">, string>> {
  const ids = [
    ...new Set(invitations.flatMap((invitation) => invitation.roleId ?? [])),
  ];
  const roles = await Promise.all(ids.map((id) => ctx.db.get(id)));

  return new Map(
    roles.flatMap((role) => (role ? [[role._id, role.name] as const] : [])),
  );
}

async function dropInvitation(
  ctx: MutationCtx,
  caller: Doc<"users">,
  invitation: Doc<"orgInvitations">,
  action: string,
): Promise<void> {
  await ctx.db.delete(invitation._id);
  await syncInvited(ctx, invitation.userId);
  await releaseSeat(ctx, invitation.orgId);
  await recordMemberAudit(
    ctx,
    caller,
    invitation.userId ? await ctx.db.get(invitation.userId) : null,
    action,
    {
      orgId: invitation.orgId,
      id: invitation._id,
      role: invitation.role,
      roleId: invitation.roleId,
    },
  );
}

// Only the invited person answers: an email invitation is theirs once sign-in bound it to them.
async function ownInvitation(
  ctx: MutationCtx,
  invitationId: Id<"orgInvitations">,
): Promise<{ caller: Doc<"users">; invitation: Doc<"orgInvitations"> }> {
  const caller = await signedInUser(ctx);
  const invitation = await ctx.db.get(invitationId);
  if (!invitation || invitation.userId !== caller._id) {
    throw new ClientError("Invitation not found", "not_found");
  }

  return { caller: caller, invitation: invitation };
}

async function signedInUser(
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
