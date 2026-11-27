import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { authKit } from "../auth";
import {
  getActiveOrgForUser,
  getOrgMembership,
  orgRoleMeets,
  userByAuthId,
  type OrgRole,
} from "./ownership/org";

export interface ActiveAccount {
  account: Doc<"accounts">;
  role: OrgRole;
  user: Doc<"users">;
}

export async function getActiveAccountForUser(
  ctx: QueryCtx,
  requiredRole?: OrgRole,
): Promise<Doc<"accounts"> | null> {
  const active = await getActiveCaller(ctx, requiredRole);

  return active ? active.account : null;
}

export async function getActiveCaller(
  ctx: QueryCtx,
  requiredRole?: OrgRole,
): Promise<ActiveAccount | null> {
  const authUser = await authKit.getAuthUser(ctx);
  if (!authUser) return null;
  const active = await resolveActiveAccount(ctx, authUser.id);
  if (!active || !orgRoleMeets(active.role, requiredRole)) return null;

  return active;
}

export async function resolveActiveAccount(
  ctx: QueryCtx,
  authId: string,
): Promise<ActiveAccount | null> {
  const user = await userByAuthId(ctx, authId);
  if (!user) return null;

  const org = await getActiveOrgForUser(ctx, user._id);
  if (!org) return null;
  const membership = await getOrgMembership(ctx, org._id, user._id);
  const role: OrgRole | undefined =
    org.ownerAuthId === authId ? "owner" : membership?.role;
  if (!role) return null;

  const account = await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
    .unique();
  if (!account) return null;

  return { account: account, role: role, user: user };
}
