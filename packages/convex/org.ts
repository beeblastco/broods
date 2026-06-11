/**
 * Public org (workspace) queries and mutations. Each authenticated user can
 * own multiple orgs; membership is tracked in the `orgMembers` join table.
 */
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { slugifyName } from "./lib/slug";
import {
    getActiveOrgForUser,
    getOrgMembership,
    requireOrgMember,
} from "./model/ownership/org";
import { orgsFields } from "./schema";

const orgDoc = v.object({
    ...orgsFields,
    _id: v.id("orgs"),
    _creationTime: v.number(),
});

async function uniqueOrgSlug(
    ctx: MutationCtx,
    baseName: string,
): Promise<string> {
    const baseSlug = slugifyName(baseName);
    let suffix = 0;
    while (true) {
        const candidate = suffix === 0 ? baseSlug : `${baseSlug}-${suffix}`;
        const existing = await ctx.db
            .query("orgs")
            .withIndex("by_slug", (q) => q.eq("slug", candidate))
            .first();
        if (!existing) {
            return candidate;
        }
        suffix += 1;
    }
}

/**
 * Returns the active org's filthy-panty account id + status for the caller, or
 * null when the user has no active org or it has not been provisioned yet.
 */
export const getActiveAccount = query({
    args: {},
    returns: v.union(
        v.object({
            accountId: v.id("accounts"),
            status: v.union(v.literal("active"), v.literal("disabled")),
        }),
        v.null(),
    ),
    handler: async (ctx) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            return null;
        }

        const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
            .unique();
        if (!user) return null;

        const org = await getActiveOrgForUser(ctx, user._id);
        if (!org) return null;

        const account = await ctx.db
            .query("accounts")
            .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
            .unique();
        if (!account) return null;

        return { accountId: account._id, status: account.status };
    },
});

/**
 * Returns the caller's active (most recently joined) org, or null when they
 * have not yet created or joined one.
 */
export const getActive = query({
    args: {},
    returns: v.union(orgDoc, v.null()),
    handler: async (ctx) => {
        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            return null;
        }

        const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
            .unique();
        if (!user) {
            return null;
        }

        const org = await getActiveOrgForUser(ctx, user._id);

        return org ?? null;
    },
});

/** Returns one org by id when the caller is a member. */
export const getById = query({
    args: { orgId: v.id("orgs") },
    returns: v.union(orgDoc, v.null()),
    handler: async (ctx, args) => {
        const { orgId } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            return null;
        }

        const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
            .unique();
        if (!user) {
            return null;
        }

        const membership = await getOrgMembership(ctx, orgId, user._id);
        if (!membership) {
            return null;
        }

        const org = await ctx.db.get(orgId);

        return org ?? null;
    },
});

/** Lists every org the caller is a member of. */
export const list = query({
    args: {},
    returns: v.array(orgDoc),
    handler: async (ctx) => {
        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            return [];
        }

        const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
            .unique();
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

/**
 * Returns the caller's active org id, creating a default "My Workspace" org
 * with an owner membership if the user does not yet belong to any. The
 * filthy-panty `accounts` row is still provisioned on-demand by `orgLifecycle:provision`.
 */
export const getOrCreate = mutation({
    args: {},
    returns: v.id("orgs"),
    handler: async (ctx) => {
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
            throw new Error("User row not found; webhook sync pending");
        }

        const existing = await getActiveOrgForUser(ctx, user._id);
        if (existing) {
            return existing._id;
        }

        const baseName = user.name?.trim() ? `${user.name.trim()}'s Workspace` : "My Workspace";
        const slug = await uniqueOrgSlug(ctx, baseName);
        const now = Date.now();
        const orgId = await ctx.db.insert("orgs", {
            name: baseName,
            slug: slug,
            ownerAuthId: authUser.id,
            plan: "free",
            createdAt: now,
        });

        await ctx.db.insert("orgMembers", {
            orgId: orgId,
            userId: user._id,
            role: "owner",
            createdAt: now,
        });

        return orgId;
    },
});

/**
 * Creates an org owned by the caller and inserts an owner membership row. The
 * matching backend `accounts` row is provisioned by `orgLifecycle:provision`.
 */
export const create = mutation({
    args: {
        name: v.string(),
        plan: v.optional(
            v.union(
                v.literal("free"),
                v.literal("pro"),
                v.literal("enterprise"),
            ),
        ),
    },
    returns: v.id("orgs"),
    handler: async (ctx, args) => {
        const { name, plan } = args;

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
            throw new Error("User row not found; webhook sync pending");
        }

        const slug = await uniqueOrgSlug(ctx, name);
        const now = Date.now();
        const orgId = await ctx.db.insert("orgs", {
            name: name,
            slug: slug,
            ownerAuthId: authUser.id,
            plan: plan ?? "free",
            createdAt: now,
        });

        await ctx.db.insert("orgMembers", {
            orgId: orgId,
            userId: user._id,
            role: "owner",
            createdAt: now,
        });

        return orgId;
    },
});

/**
 * Sets the caller's active org. The user must be a member; the choice is
 * persisted on the users row so future sessions remember it.
 */
export const setActive = mutation({
    args: { orgId: v.id("orgs") },
    returns: v.null(),
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
            throw new Error("User row not found");
        }

        await requireOrgMember(ctx, orgId, user._id);

        await ctx.db.patch(user._id, { activeOrgId: orgId });

        return null;
    },
});

/** Renames an org or updates its plan. Owner/admin only. */
export const update = mutation({
    args: {
        orgId: v.id("orgs"),
        name: v.optional(v.string()),
        plan: v.optional(
            v.union(
                v.literal("free"),
                v.literal("pro"),
                v.literal("enterprise"),
            ),
        ),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { orgId, name, plan } = args;

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
            throw new Error("User row not found");
        }

        await requireOrgMember(ctx, orgId, user._id, "admin");

        await ctx.db.patch(orgId, {
            ...(name !== undefined ? { name: name } : {}),
            ...(plan !== undefined ? { plan: plan } : {}),
        });

        return null;
    },
});

/**
 * Removes an org, its memberships, and its backend `accounts` row plus
 * everything that cascades from it. Owner only.
 */
export const remove = mutation({
    args: { orgId: v.id("orgs") },
    returns: v.null(),
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
            throw new Error("User row not found");
        }

        await requireOrgMember(ctx, orgId, user._id, "owner");

        const account = await ctx.db
            .query("accounts")
            .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
            .unique();
        if (account) {
            // Cascade-delete using the same logic as backend/accounts:remove.
            for (const table of [
                "agents",
                "sandboxConfigs",
                "workspaceConfigs",
                "conversations",
                "messages",
                "skills",
                "asyncResults",
            ] as const) {
                const rows = await ctx.db
                    .query(table)
                    .withIndex("by_accountId", (q) =>
                        q.eq("accountId", account._id),
                    )
                    .collect();
                for (const row of rows) {
                    await ctx.db.delete(row._id);
                }
            }
            await ctx.db.delete(account._id);
        }

        const memberships = await ctx.db
            .query("orgMembers")
            .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
            .collect();
        for (const membership of memberships) {
            await ctx.db.delete(membership._id);
        }

        await ctx.db.delete(orgId);

        return null;
    },
});
