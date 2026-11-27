import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalQuery, mutation } from "../_generated/server";
import { authKit } from "../auth";
import { orgDoc } from "../dashboardReads";
import { purgeOrg } from "../model/cascade";
import { uniqueOrgSlug } from "../lib/slug";
import { ClientError } from "../model/clientError";
import { hasDashboardPermission } from "../model/access";
import { assertCanCreateOrg } from "../model/orgBilling";
import {
  getActiveOrgForUser,
  requireOrgMember,
  userByAuthId,
} from "../model/ownership/org";

export const orgBootstrapValidator = v.object({
  orgId: v.id("orgs"),
  needsProvision: v.boolean(),
});

export type OrgBootstrap = Infer<typeof orgBootstrapValidator>;

export const create = mutation({
  args: {
    name: v.string(),
  },
  returns: v.id("orgs"),
  handler: async (ctx, args): Promise<Id<"orgs">> => {
    const { name } = args;

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

    return await insertOwnedOrg(ctx, user, name);
  },
});

export const userIdByAuthId = internalQuery({
  args: { authId: v.string() },
  returns: v.union(v.id("users"), v.null()),
  handler: async (ctx, args): Promise<Id<"users"> | null> => {
    const user = await userByAuthId(ctx, args.authId);

    return user ? user._id : null;
  },
});

export const getByIdForKeyWriter = internalQuery({
  args: { orgId: v.id("orgs") },
  returns: v.union(orgDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"orgs"> | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) {
      return null;
    }
    const user = await userByAuthId(ctx, authUser.id);
    if (!user) {
      return null;
    }
    if (!(await hasDashboardPermission(ctx, args.orgId, user, "keys:write"))) {
      return null;
    }

    return await ctx.db.get(args.orgId);
  },
});

export const getOrCreate = mutation({
  args: {},
  returns: orgBootstrapValidator,
  handler: async (ctx): Promise<OrgBootstrap> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) {
      throw new Error("User not found or not authenticated");
    }

    return await getOrCreateActiveOrg(ctx, authUser.id);
  },
});

export const remove = mutation({
  args: { orgId: v.id("orgs") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { orgId } = args;

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

    await purgeOrg(ctx, orgId);

    return null;
  },
});

export const setActive = mutation({
  args: { orgId: v.id("orgs") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { orgId } = args;

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

// The plan comes from Stripe, never from here.
export const update = mutation({
  args: {
    orgId: v.id("orgs"),
    name: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { orgId, name } = args;

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

    if (name !== undefined) await ctx.db.patch(orgId, { name: name });

    return null;
  },
});

export async function getOrCreateActiveOrg(
  ctx: MutationCtx,
  authId: string,
): Promise<OrgBootstrap> {
  const user = await userByAuthId(ctx, authId);
  if (!user) {
    throw new ClientError(
      "Your account is still being set up. Try again in a moment.",
    );
  }

  const existing = await getActiveOrgForUser(ctx, user._id);
  const orgId =
    existing?._id ??
    (await insertOwnedOrg(
      ctx,
      user,
      user.name?.trim() ? `${user.name.trim()}'s Workspace` : "My Workspace",
    ));
  const account = await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .unique();

  return { orgId: orgId, needsProvision: account === null };
}

export async function insertOwnedOrg(
  ctx: MutationCtx,
  user: Doc<"users">,
  name: string,
): Promise<Id<"orgs">> {
  const plan = await assertCanCreateOrg(ctx, user.authId);
  const now = Date.now();
  const orgId = await ctx.db.insert("orgs", {
    name: name,
    slug: await uniqueOrgSlug(ctx, name),
    ownerAuthId: user.authId,
    plan: plan,
    createdAt: now,
  });
  await ctx.db.insert("orgMembers", {
    orgId: orgId,
    userId: user._id,
    role: "owner",
    createdAt: now,
  });
  await ctx.db.patch(user._id, { activeOrgId: orgId });

  return orgId;
}
