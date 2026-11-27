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
import { assertFreeSeat, dropInvitations } from "../model/orgBilling";
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
  signedInUser,
} from "./members";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    const { caller } = await signedInUser(ctx);
    await assertCanInvite(ctx, caller, {
      orgId: orgId,
      role: role,
      roleId: args.roleId,
    });

    const email = args.email.trim().toLowerCase();
    if (!EMAIL_SHAPE.test(email)) {
      throw new ClientError("Enter an email address like name@example.com");
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
    await recordMemberAudit(ctx, caller, email, "invited", {
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
    const { caller } = await signedInUser(ctx);
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

// Returns the refusal instead of throwing it, so dropping a stale invitation commits.
export const accept = mutation({
  args: { invitationId: v.id("orgInvitations") },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args): Promise<string | null> => {
    const { caller, invitation, email } = await ownInvitation(
      ctx,
      args.invitationId,
    );
    if (email !== invitation.email) {
      throw new ClientError(
        "Sent to an address you no longer sign in with. Ask an admin to revoke it.",
        "forbidden",
      );
    }
    const inviter = await ctx.db.get(invitation.invitedBy);
    const stillGranted =
      inviter &&
      (await assertCanInvite(ctx, inviter, invitation).then(
        () => true,
        (error: unknown) => {
          if (error instanceof ClientError) return false;
          throw error;
        },
      ));
    if (!stillGranted) {
      await dropInvitation(ctx, caller, invitation, "invitation-invalid");

      return "This invitation is no longer valid.";
    }
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
    await recordMemberAudit(ctx, caller, caller.email, "joined", {
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
    const { caller } = await signedInUser(ctx);
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation) {
      throw new ClientError("Invitation not found", "not_found");
    }
    await assertCanInvite(ctx, caller, invitation);
    await dropInvitation(ctx, caller, invitation, "invitation-revoked");

    return null;
  },
});

// Checked again at accept: an invitation never outlives its inviter's power to grant it.
async function assertCanInvite(
  ctx: MutationCtx,
  inviter: Doc<"users">,
  invitation: Pick<Doc<"orgInvitations">, "orgId" | "role" | "roleId">,
): Promise<void> {
  const { orgId, role, roleId } = invitation;
  const membership = await requireOrgMember(ctx, orgId, inviter._id);
  await requireDashboardPermission(ctx, orgId, inviter, "members:write");
  assertCanTouchOwnerRole(membership, role);
  await assertWithinReach(ctx, orgId, inviter, role, roleId);
}

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
  await dropInvitations(ctx, [invitation]);
  await recordMemberAudit(ctx, caller, invitation.email, action, {
    orgId: invitation.orgId,
    id: invitation._id,
    role: invitation.role,
    roleId: invitation.roleId,
  });
}

// Only the invited person answers, with a verified email; `email` is the one they sign in with.
async function ownInvitation(
  ctx: MutationCtx,
  invitationId: Id<"orgInvitations">,
): Promise<{
  caller: Doc<"users">;
  invitation: Doc<"orgInvitations">;
  email: string;
}> {
  const { caller, authUser } = await signedInUser(ctx);
  const invitation = await ctx.db.get(invitationId);
  if (!invitation || invitation.userId !== caller._id) {
    throw new ClientError("Invitation not found", "not_found");
  }
  if (!authUser.emailVerified) {
    throw new ClientError(
      "Verify your email address, then answer this invitation.",
      "forbidden",
    );
  }

  return {
    caller: caller,
    invitation: invitation,
    email: authUser.email.toLowerCase(),
  };
}
