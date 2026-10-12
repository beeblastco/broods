/**
 * Who pays for an org and how many people it may hold. Each org has its own
 * Stripe subscription, one seat per member (owner included), billed to the
 * org owner; a free org has the owner's seat only. An owner keeps at most
 * `FREE_ORGS_PER_OWNER` free orgs, so new orgs never multiply the free
 * allowance. Both rules hold only on the managed service (`isManagedService`).
 * `orgs.plan` follows the org's own subscription and is what core enforces;
 * `users.plan` only says whether the user pays for any org.
 */

import type Stripe from "stripe";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ClientError } from "./clientError";
import { isManagedService } from "./planLimits";

/** Free orgs one owner may hold. Paid orgs do not count. */
export const FREE_ORGS_PER_OWNER = 1;

/** Seats a free org has: the owner's. */
const FREE_ORG_SEATS = 1;

// A subscription in one of these statuses is over: it no longer blocks a new
// checkout and is not the one billing shows.
const ENDED_STATUSES: ReadonlyArray<Stripe.Subscription.Status> = [
  "canceled",
  "incomplete_expired",
];

// Statuses that grant the paid plan.
const PAID_STATUSES: ReadonlyArray<Stripe.Subscription.Status> = [
  "active",
  "trialing",
];

/** Whether a subscription status means it is over. */
export function isEnded(status: string): boolean {
  return ENDED_STATUSES.some((ended) => ended === status);
}

/** Whether a subscription status grants the paid plan. */
export function isPaid(status: string): boolean {
  return PAID_STATUSES.some((paid) => paid === status);
}

/** How many members an org has, owner included. */
export async function orgMemberCount(
  ctx: QueryCtx,
  orgId: Id<"orgs">,
): Promise<number> {
  const members = await ctx.db
    .query("orgMembers")
    .withIndex("by_orgId_and_userId", (q) => q.eq("orgId", orgId))
    .collect();

  return members.length;
}

/**
 * Refuse to add a member to an org whose seats are all taken. The owner buys
 * the seat first (`stripe:addSeat`), so the invite lands only once it is paid.
 */
export async function assertFreeSeat(
  ctx: QueryCtx,
  org: Doc<"orgs">,
): Promise<void> {
  if (!isManagedService()) return;
  const subs = await ctx.runQuery(
    components.stripe.public.listSubscriptionsByOrgId,
    { orgId: org._id },
  );
  const paid = subs.find((sub) => isPaid(sub.status));
  const seats = paid ? (paid.quantity ?? FREE_ORG_SEATS) : FREE_ORG_SEATS;
  if ((await orgMemberCount(ctx, org._id)) < seats) return;

  throw new ClientError(
    paid
      ? `Every seat in ${org.name} is taken. The owner adds a seat in Billing first.`
      : `${org.name} is on the free plan, which has one seat. The owner upgrades it to invite members.`,
    "payment_required",
  );
}

/** Refuse a new org when the owner already holds their free ones. */
export async function assertFreeOrgSlot(
  ctx: QueryCtx,
  ownerAuthId: string,
): Promise<void> {
  if (!isManagedService()) return;
  const owned = await ctx.db
    .query("orgs")
    .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", ownerAuthId))
    .collect();
  const free = owned.filter((org) => org.plan === "free");
  if (free.length < FREE_ORGS_PER_OWNER) return;

  throw new ClientError(
    `You already own a free organization (${free[0].name}). Upgrade it or delete it to create another.`,
    "payment_required",
  );
}

/** Recompute a user's display plan: pro while they pay for any org. */
export async function syncUserPlan(
  ctx: MutationCtx,
  authId: string,
): Promise<void> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_authId", (q) => q.eq("authId", authId))
    .unique();
  if (!user) return;
  const subs = await ctx.runQuery(
    components.stripe.public.listSubscriptionsByUserId,
    { userId: authId },
  );
  const plan = subs.some((sub) => isPaid(sub.status)) ? "pro" : "free";
  if (user.plan !== plan) await ctx.db.patch(user._id, { plan: plan });
}

/** Recompute an org's plan from the subscriptions filed under it. */
export async function syncOrgPlan(
  ctx: MutationCtx,
  orgId: string,
): Promise<void> {
  const id = ctx.db.normalizeId("orgs", orgId);
  const org = id ? await ctx.db.get(id) : null;
  if (!org) return;
  const subs = await ctx.runQuery(
    components.stripe.public.listSubscriptionsByOrgId,
    { orgId: org._id },
  );
  const plan = subs.some((sub) => isPaid(sub.status)) ? "pro" : "free";
  if (org.plan !== plan) await ctx.db.patch(org._id, { plan: plan });
}
