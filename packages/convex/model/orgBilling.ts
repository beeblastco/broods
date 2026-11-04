import type Stripe from "stripe";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ClientError } from "./clientError";
import { userByAuthId } from "./ownership/org";
import { isManagedService, PLAN_LIMITS, type Plan } from "./planLimits";

export const PRO_INCLUDED_DEVELOPER_SEATS = 2;

// Must match both Stripe prices, `STRIPE_PRO_PRICE_ID` and `STRIPE_SEAT_PRICE_ID`.
export const UNIT_PRICE_EUR = 20;

const ENDED_STATUSES: ReadonlyArray<Stripe.Subscription.Status> = [
  "canceled",
  "incomplete_expired",
];

const PAID_STATUSES: ReadonlyArray<Stripe.Subscription.Status> = [
  "active",
  "trialing",
];

export function isEnded(status: string): boolean {
  return ENDED_STATUSES.some((ended) => ended === status);
}

export function isPaid(status: string): boolean {
  return PAID_STATUSES.some((paid) => paid === status);
}

export function proQuantity(developers: number): number {
  return 1 + Math.max(0, developers - PRO_INCLUDED_DEVELOPER_SEATS);
}

export function seatsForQuantity(quantity: number): number {
  return PRO_INCLUDED_DEVELOPER_SEATS + quantity - 1;
}

// The paid one with most units wins, so an owner who paid per org before seats were
// pooled keeps every seat; any other paid one is a duplicate nothing counts.
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

export function seatsOf(
  subs: ReadonlyArray<{ status: string; quantity?: number }>,
): number {
  const current = currentOf(subs);

  return current && isPaid(current.status)
    ? seatsForQuantity(current.quantity ?? 1)
    : 0;
}

export function planOf(subs: ReadonlyArray<{ status: string }>): Plan {
  return subs.some((sub) => isPaid(sub.status)) ? "pro" : "free";
}

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
