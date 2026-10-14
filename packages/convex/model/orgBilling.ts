/**
 * Who pays for an org and how many people it may hold. Each org has its own
 * Stripe subscription to one €20 unit price, billed to the org owner. Pro is
 * one unit and seats the owner plus `PRO_INCLUDED_DEVELOPER_SEATS`
 * developers; each member past those is one more unit (`proQuantity`). A
 * Hobby (free) org seats its owner only, and creating an org needs Pro
 * (`assertCanCreateOrg`), so new orgs never multiply the free allowance. A
 * Hobby user still joins any org that invites them, on that org's seat. The
 * rules hold only on the managed service (`isManagedService`). `orgs.plan`
 * follows the org's own subscription and is what core enforces; `users.plan`
 * only says whether the user pays for any org.
 */

import type Stripe from "stripe";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ClientError } from "./clientError";
import { isManagedService, type Plan } from "./planLimits";

/** Developer seats Pro includes on top of the owner's, for its one unit. */
export const PRO_INCLUDED_DEVELOPER_SEATS = 2;

/** One unit a month in euros: the price behind `STRIPE_SEAT_PRICE_ID`, Pro or one extra seat. */
export const UNIT_PRICE_EUR = 20;

/** Seats a free org has: the owner's. */
export const FREE_ORG_SEATS = 1;

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

/**
 * The Stripe quantity a Pro org of `members` people (owner included) pays
 * for: Pro itself, plus one unit per member past the included seats.
 */
export function proQuantity(members: number): number {
  return Math.max(1, members - PRO_INCLUDED_DEVELOPER_SEATS);
}

/** The seats `quantity` paid units give a Pro org: the owner's and the included ones on the first unit, one more per unit after. */
export function seatsForQuantity(quantity: number): number {
  return quantity + PRO_INCLUDED_DEVELOPER_SEATS;
}

/** The seats an org's subscriptions give it: what the paid units buy, else the owner's seat. */
export function seatsOf(
  subs: ReadonlyArray<{ status: string; quantity?: number }>,
): number {
  const paid = subs.find((sub) => isPaid(sub.status));

  return paid ? seatsForQuantity(paid.quantity ?? 1) : FREE_ORG_SEATS;
}

/** The plan a payer's or an org's subscriptions grant: pro while one is paid. */
export function planOf(subs: ReadonlyArray<{ status: string }>): Plan {
  return subs.some((sub) => isPaid(sub.status)) ? "pro" : "free";
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
  if ((await orgMemberCount(ctx, org._id)) < seatsOf(subs)) return;

  throw new ClientError(
    planOf(subs) === "pro"
      ? `Every seat in ${org.name} is taken. The owner adds a seat in Billing first.`
      : `${org.name} is on Hobby, which has one seat: the owner's. The owner upgrades it to Pro to invite developers.`,
    "payment_required",
  );
}

/** Give back the paid seat of a member who just left an org (`stripe:syncSeatsInternal`). */
export async function releaseSeat(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
): Promise<void> {
  if (!isManagedService()) return;
  await ctx.scheduler.runAfter(0, internal.stripe.syncSeatsInternal, {
    orgId: orgId,
  });
}

/**
 * Refuse a new org unless every org its owner already owns is on Pro. Owning
 * none, they get one: the Hobby workspace made for them. A new org starts on
 * Hobby, so it is upgraded before the next one. An org whose subscription
 * waits on a payment counts as Hobby until Stripe has it.
 */
export async function assertCanCreateOrg(
  ctx: QueryCtx,
  ownerAuthId: string,
): Promise<void> {
  if (!isManagedService()) return;
  const owned = await ctx.db
    .query("orgs")
    .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", ownerAuthId))
    .collect();
  const hobby = owned.find((org) => org.plan === "free");
  if (!hobby) return;
  const subs = await ctx.runQuery(
    components.stripe.public.listSubscriptionsByOrgId,
    { orgId: hobby._id },
  );

  throw new ClientError(
    subs.some((sub) => !isEnded(sub.status))
      ? `Payment for ${hobby.name} is due. Update the card in Billing first.`
      : owned.some((org) => org.plan === "pro")
        ? `${hobby.name} is still on Hobby. Upgrade it to Pro before you create another organization.`
        : `Creating an organization needs Pro. Upgrade ${hobby.name} to Pro first.`,
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
  const plan = planOf(subs);
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
  const plan = planOf(subs);
  if (org.plan !== plan) await ctx.db.patch(org._id, { plan: plan });
}
