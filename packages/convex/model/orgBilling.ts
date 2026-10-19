/**
 * Who pays and how many developers a Pro owner may seat. Pro belongs to the
 * owner, not to one org: one Stripe subscription per user to one €20 unit
 * price, filed under their authId. Pro is one unit and gives the owner
 * `PRO_INCLUDED_DEVELOPER_SEATS` developer seats; each seat past those is one
 * more unit (`proQuantity`). The seats are a pool across every org the owner
 * owns: each distinct developer (a member who is not the owner) in any of
 * them takes one seat, however many of those orgs they are in. A Hobby
 * (free) owner has no developer seats and keeps one workspace; creating
 * more orgs needs Pro, up to `PLAN_LIMITS.pro.maxOwnedOrgs`
 * (`assertCanCreateOrg`). A Hobby user still joins any org that invites
 * them, on its owner's seat. The rules hold only on the managed service
 * (`isManagedService`). `orgs.plan` follows its owner's subscription and
 * names the caps core enforces against the owner's pool
 * (`model/usageMeter.ts`); `users.plan` is the owner's own.
 */

import type Stripe from "stripe";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ClientError } from "./clientError";
import { userByAuthId } from "./ownership/org";
import { isManagedService, PLAN_LIMITS, type Plan } from "./planLimits";

/** Developer seats Pro includes, for its one unit. */
export const PRO_INCLUDED_DEVELOPER_SEATS = 2;

/** One unit a month in euros: the price behind `STRIPE_SEAT_PRICE_ID`, Pro or one extra seat. */
export const UNIT_PRICE_EUR = 20;

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
 * The Stripe quantity a Pro owner with `developers` seated developers pays
 * for: Pro itself, plus one unit per developer past the included seats.
 */
export function proQuantity(developers: number): number {
  return 1 + Math.max(0, developers - PRO_INCLUDED_DEVELOPER_SEATS);
}

/** The developer seats `quantity` paid units give: the included ones on the first unit, one more per unit after. */
export function seatsForQuantity(quantity: number): number {
  return PRO_INCLUDED_DEVELOPER_SEATS + quantity - 1;
}

/**
 * The subscription an owner's billing acts on: the paid one with the most
 * units, the oldest on a tie, else the oldest that has not ended (one waiting
 * on a payment). Any other paid one is a duplicate that nothing counts; the
 * most units wins so an owner who paid per org before the pool keeps every
 * seat they paid for.
 */
export function currentOf<Sub extends { status: string; quantity?: number }>(
  subs: ReadonlyArray<Sub>,
): Sub | undefined {
  const paid = subs
    .filter((sub) => isPaid(sub.status))
    .reduce<Sub | undefined>(
      (best, sub) =>
        best && (best.quantity ?? 1) >= (sub.quantity ?? 1) ? best : sub,
      undefined,
    );

  return paid ?? subs.find((sub) => !isEnded(sub.status));
}

/** The developer seats an owner's subscriptions give: what the one billing acts on buys while paid, else none. */
export function seatsOf(
  subs: ReadonlyArray<{ status: string; quantity?: number }>,
): number {
  const current = currentOf(subs);

  return current && isPaid(current.status)
    ? seatsForQuantity(current.quantity ?? 1)
    : 0;
}

/** The plan an owner's subscriptions grant: pro while one is paid. */
export function planOf(subs: ReadonlyArray<{ status: string }>): Plan {
  return subs.some((sub) => isPaid(sub.status)) ? "pro" : "free";
}

/**
 * The developers an owner seats: every member of an org they own who is not
 * them, each once, with the orgs they are in.
 */
export async function developersOf(
  ctx: QueryCtx,
  ownerAuthId: string,
): Promise<Map<Id<"users">, Array<Doc<"orgs">>>> {
  const owner = await userByAuthId(ctx, ownerAuthId);
  const owned = await ctx.db
    .query("orgs")
    .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", ownerAuthId))
    .collect();
  const developers = new Map<Id<"users">, Array<Doc<"orgs">>>();
  for (const org of owned) {
    const members = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_and_userId", (q) => q.eq("orgId", org._id))
      .collect();
    for (const member of members) {
      if (member.userId === owner?._id) continue;
      developers.set(member.userId, [
        ...(developers.get(member.userId) ?? []),
        org,
      ]);
    }
  }

  return developers;
}

/**
 * Refuse to add `userId` to an org when its owner has no developer seat for
 * them. While the owner pays, someone already seated in another of their
 * orgs joins free; anyone else needs a free seat, which the owner buys first
 * (`stripe:addSeat`), so the invite lands only once it is paid. An owner who
 * does not pay has no seats, so nobody joins, seated or not.
 */
export async function assertFreeSeat(
  ctx: QueryCtx,
  org: Doc<"orgs">,
  userId: Id<"users">,
): Promise<void> {
  if (!isManagedService()) return;
  const subs = await ctx.runQuery(
    components.stripe.public.listSubscriptionsByUserId,
    { userId: org.ownerAuthId },
  );
  const seats = seatsOf(subs);
  const developers = await developersOf(ctx, org.ownerAuthId);
  if (seats > 0 && (developers.has(userId) || developers.size < seats)) {
    return;
  }

  throw new ClientError(
    planOf(subs) === "pro"
      ? "Every developer seat is taken. Add a seat in Billing."
      : subs.some((sub) => !isEnded(sub.status))
        ? `Payment for ${org.name}'s owner's Pro plan is due. Their seats come back once they update the card in Billing.`
        : `${org.name}'s owner is on Hobby, which has no developer seats. They upgrade to Pro to invite developers.`,
    "payment_required",
  );
}

/**
 * Give back the seat of a developer who just left one of an org's owner's
 * orgs, or the seats of an org about to be deleted (`stripe:syncSeatsInternal`).
 */
export async function releaseSeat(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
): Promise<void> {
  if (!isManagedService()) return;
  const org = await ctx.db.get(orgId);
  if (!org) return;
  await ctx.scheduler.runAfter(0, internal.stripe.syncSeatsInternal, {
    authId: org.ownerAuthId,
  });
}

/**
 * Refuse a new org past what its owner's plan allows, and give the plan it
 * starts on: its owner's. Owning none, everyone gets one: the Hobby workspace
 * made for them. A Pro owner creates up to `maxOwnedOrgs`, all drawing on
 * their one pool of caps. A subscription that waits on a payment is not Pro
 * until Stripe has it. A self-hosted install bills no one: every org starts
 * free and the rule does not apply.
 */
export async function assertCanCreateOrg(
  ctx: QueryCtx,
  ownerAuthId: string,
): Promise<Plan> {
  if (!isManagedService()) return "free";
  const subs = await ctx.runQuery(
    components.stripe.public.listSubscriptionsByUserId,
    { userId: ownerAuthId },
  );
  const plan = planOf(subs);
  const owned = await ctx.db
    .query("orgs")
    .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", ownerAuthId))
    .collect();
  if (owned.length < PLAN_LIMITS[plan].maxOwnedOrgs) return plan;

  throw new ClientError(
    plan === "pro"
      ? `You own ${owned.length} organizations, the most Pro allows.`
      : subs.some((sub) => !isEnded(sub.status))
        ? "Payment for your Pro plan is due. Update the card in Billing first."
        : "Creating another organization needs Pro. Upgrade to Pro first.",
    plan === "pro" ? "invalid_request" : "payment_required",
  );
}

/** Recompute an owner's plan from their subscriptions, and put every org they own on it. */
export async function syncUserPlan(
  ctx: MutationCtx,
  authId: string,
): Promise<void> {
  const subs = await ctx.runQuery(
    components.stripe.public.listSubscriptionsByUserId,
    { userId: authId },
  );
  const plan = planOf(subs);
  const user = await userByAuthId(ctx, authId);
  if (user && user.plan !== plan) await ctx.db.patch(user._id, { plan: plan });
  const owned = await ctx.db
    .query("orgs")
    .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", authId))
    .collect();
  for (const org of owned) {
    if (org.plan !== plan) await ctx.db.patch(org._id, { plan: plan });
  }
}
