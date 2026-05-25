/**
 * Org membership management: list members, add by email, change role, remove.
 * Reads gated on caller being a member; writes gated on admin role.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { getOrgMembership, requireOrgMember } from "./model/ownership/org";

const roleValidator = v.union(
    v.literal("owner"),
    v.literal("admin"),
    v.literal("member"),
);

const memberRow = v.object({
    membershipId: v.id("orgMembers"),
    userId: v.id("users"),
    role: roleValidator,
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

        const memberships = await ctx.db
            .query("orgMembers")
            .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
            .collect();

        const rows = await Promise.all(
            memberships.map(async (m) => {
                const u = await ctx.db.get(m.userId);

                return {
                    membershipId: m._id,
                    userId: m.userId,
                    role: m.role,
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
    handler: async (ctx, args) => {
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

        await requireOrgMember(ctx, orgId, caller._id, "admin");

        const normalizedEmail = email.trim().toLowerCase();
        if (!normalizedEmail) {
            throw new Error("Email is required");
        }

        const target = await ctx.db
            .query("users")
            .filter((q) => q.eq(q.field("email"), normalizedEmail))
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
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { membershipId, role } = args;

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

        await requireOrgMember(ctx, membership.orgId, caller._id, "admin");

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

        await ctx.db.patch(membershipId, { role: role });

        return null;
    },
});

/** Removes a member from the org. Admin only. Cannot remove the org owner. */
export const remove = mutation({
    args: { membershipId: v.id("orgMembers") },
    returns: v.null(),
    handler: async (ctx, args) => {
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

        await requireOrgMember(ctx, membership.orgId, caller._id, "admin");

        const targetUser = await ctx.db.get(membership.userId);
        const org = await ctx.db.get(membership.orgId);
        if (targetUser && org && targetUser.authId === org.ownerAuthId) {
            throw new Error("Cannot remove the org owner");
        }

        await ctx.db.delete(membershipId);

        return null;
    },
});
