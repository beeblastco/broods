/**
 * Stripe subscription queries, checkout/portal actions, and webhook plan sync.
 * Checkout goes through the Stripe Payment Link in `STRIPE_PRO_PAYMENT_LINK`
 * when set, so Stripe owns the price and trial; otherwise through an API
 * Checkout Session for `STRIPE_PRO_PRICE_ID`.
 */

import { StripeSubscriptions } from "@convex-dev/stripe";
import { v } from "convex/values";
import type Stripe from "stripe";
import { components } from "./_generated/api";
import {
  action,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
} from "./_generated/server";
import { authKit } from "./auth";
import { ClientError } from "./model/clientError";

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

export const stripeClient = new StripeSubscriptions(components.stripe);

export const createCheckoutSession = action({
  args: { successUrl: v.string(), cancelUrl: v.string() },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("Not authenticated");

    // Stops a second click or tab. It reads webhook-synced rows, so a checkout
    // paid seconds ago can still slip through; Stripe's "limit customers to
    // one subscription" Checkout setting closes that window.
    const subs = await ctx.runQuery(
      components.stripe.public.listSubscriptionsByUserId,
      { userId: authUser.id },
    );
    if (subs.some((sub) => !isEnded(sub.status))) {
      throw new ClientError(
        "Already subscribed; use Manage Billing to change plan",
        "conflict",
      );
    }

    // The link carries no customer or metadata. The webhook reads
    // `client_reference_id` off checkout.session.completed and stamps
    // `metadata.userId` on the subscription and customer.
    const paymentLink = process.env.STRIPE_PRO_PAYMENT_LINK;
    if (paymentLink) {
      const url = new URL(paymentLink);
      url.searchParams.set("client_reference_id", authUser.id);
      if (authUser.email) {
        url.searchParams.set("prefilled_email", authUser.email);
      }

      return { url: url.toString() };
    }

    const { customerId } = await stripeClient.getOrCreateCustomer(ctx, {
      userId: authUser.id,
      email: authUser.email ?? undefined,
    });

    const priceId = process.env.STRIPE_PRO_PRICE_ID;
    if (!priceId) throw new Error("STRIPE_PRO_PRICE_ID is not configured");

    const session = await stripeClient.createCheckoutSession(ctx, {
      priceId: priceId,
      customerId: customerId,
      mode: "subscription",
      successUrl: safeDashboardUrl(args.successUrl, "successUrl"),
      cancelUrl: safeDashboardUrl(args.cancelUrl, "cancelUrl"),
      // The component files a subscription under `metadata.userId`; billing
      // info and plan sync look it up by that key.
      subscriptionMetadata: { userId: authUser.id },
    });

    if (!session.url) throw new Error("No checkout URL returned");

    return { url: session.url };
  },
});

export const createPortalSession = action({
  args: { returnUrl: v.string() },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("Not authenticated");

    const { customerId } = await stripeClient.getOrCreateCustomer(ctx, {
      userId: authUser.id,
      email: authUser.email ?? undefined,
    });

    return await stripeClient.createCustomerPortalSession(ctx, {
      customerId: customerId,
      returnUrl: safeDashboardUrl(args.returnUrl, "returnUrl"),
    });
  },
});

export const getBillingInfo = query({
  args: {},
  returns: v.union(v.null(), v.any()),
  handler: async (ctx) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) return null;

    const subs = await ctx.runQuery(
      components.stripe.public.listSubscriptionsByUserId,
      { userId: authUser.id },
    );

    // Any subscription that is not over, including past_due and unpaid ones,
    // so the dashboard offers the portal to fix payment instead of checkout.
    return subs.find((sub) => !isEnded(sub.status)) ?? null;
  },
});

/**
 * Ids of a user's subscriptions that have not ended, or null when `authId` is
 * not a Broods user. The webhook checks both before it links a Payment Link
 * checkout to the user.
 */
export const getLiveSubscriptionIdsInternal = internalQuery({
  args: { authId: v.string() },
  returns: v.union(v.null(), v.array(v.string())),
  handler: async (ctx, args): Promise<Array<string> | null> => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", args.authId))
      .unique();
    if (!user) return null;

    const subs = await ctx.runQuery(
      components.stripe.public.listSubscriptionsByUserId,
      { userId: args.authId },
    );

    return subs
      .filter((sub) => !isEnded(sub.status))
      .map((sub) => sub.stripeSubscriptionId);
  },
});

/** Whether the webhook already handled this Stripe event id. */
export const isEventProcessedInternal = internalQuery({
  args: { eventId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const seen = await ctx.db
      .query("stripeEvents")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .first();

    return seen !== null;
  },
});

/** Record a handled Stripe event id, after its work committed. */
export const markEventProcessedInternal = internalMutation({
  args: { eventId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const seen = await ctx.db
      .query("stripeEvents")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .first();
    if (!seen) {
      await ctx.db.insert("stripeEvents", {
        eventId: args.eventId,
        processedAt: Date.now(),
      });
    }

    return null;
  },
});

/**
 * Take the next read ticket for a subscription. The webhook claims it before
 * it reads the subscription from Stripe, so ticket order is read start order.
 */
export const claimSubscriptionSyncInternal = internalMutation({
  args: { stripeSubscriptionId: v.string() },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const sync = await ctx.db
      .query("stripeSubscriptionSyncs")
      .withIndex("by_stripeSubscriptionId", (q) =>
        q.eq("stripeSubscriptionId", args.stripeSubscriptionId),
      )
      .unique();
    if (!sync) {
      await ctx.db.insert("stripeSubscriptionSyncs", {
        stripeSubscriptionId: args.stripeSubscriptionId,
        claimed: 1,
        applied: 0,
      });

      return 1;
    }
    await ctx.db.patch(sync._id, { claimed: sync.claimed + 1 });

    return sync.claimed + 1;
  },
});

/**
 * Store a subscription as Stripe returned it, then recompute the plan of each
 * user it is filed under. Webhook payloads are only a cue to read: delivery is
 * unordered and repeats, so the snapshot in an event can be stale. A read is
 * dropped when a read with a later ticket already landed, and a subscription
 * that ended never comes back, since Stripe never reopens one.
 * `users.plan` is the source of truth; orgs the user owns carry a copy so the
 * CLI and org settings read it off the org.
 */
export const applySubscriptionInternal = internalMutation({
  args: {
    ticket: v.number(),
    subscription: v.object({
      stripeSubscriptionId: v.string(),
      stripeCustomerId: v.string(),
      status: v.string(),
      currentPeriodEnd: v.number(),
      cancelAtPeriodEnd: v.boolean(),
      cancelAt: v.optional(v.number()),
      quantity: v.number(),
      priceId: v.string(),
      metadata: v.record(v.string(), v.string()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const sub = args.subscription;
    const sync = await ctx.db
      .query("stripeSubscriptionSyncs")
      .withIndex("by_stripeSubscriptionId", (q) =>
        q.eq("stripeSubscriptionId", sub.stripeSubscriptionId),
      )
      .unique();
    if (!sync || args.ticket <= sync.applied) return null;
    await ctx.db.patch(sync._id, { applied: args.ticket });

    const stored = await ctx.runQuery(
      components.stripe.public.getSubscription,
      { stripeSubscriptionId: sub.stripeSubscriptionId },
    );
    if (stored && isEnded(stored.status) && !isEnded(sub.status)) return null;

    // Created inserts a missing row and files earlier invoices under it;
    // updated then writes the current state over an existing one.
    await ctx.runMutation(
      components.stripe.private.handleSubscriptionCreated,
      sub,
    );
    await ctx.runMutation(
      components.stripe.private.handleSubscriptionUpdated,
      sub,
    );

    const authIds = new Set([sub.metadata.userId, stored?.userId]);
    for (const authId of authIds) {
      if (authId) await syncPlan(ctx, authId);
    }

    return null;
  },
});

/** Recompute a user's plan, and the copy on orgs they own, from their stored subscriptions. */
async function syncPlan(ctx: MutationCtx, authId: string): Promise<void> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_authId", (q) => q.eq("authId", authId))
    .unique();
  if (!user) return;

  const subs = await ctx.runQuery(
    components.stripe.public.listSubscriptionsByUserId,
    { userId: authId },
  );
  const paid = subs.some((sub) =>
    PAID_STATUSES.some((status) => status === sub.status),
  );
  const plan = paid ? ("pro" as const) : ("free" as const);
  if (user.plan !== plan) await ctx.db.patch(user._id, { plan: plan });

  const orgs = await ctx.db
    .query("orgs")
    .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", authId))
    .collect();
  for (const org of orgs) {
    if (org.plan !== plan) await ctx.db.patch(org._id, { plan: plan });
  }
}

/** The configured dashboard origin, or null when neither env var is set. */
function allowedDashboardOrigin(): string | null {
  const explicit = process.env.DASHBOARD_ORIGIN?.trim();
  if (explicit) return new URL(explicit).origin;

  const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim();
  if (redirectUri) return new URL(redirectUri).origin;

  return null;
}

/** Whether a subscription status means it is over. */
function isEnded(status: string): boolean {
  return ENDED_STATUSES.some((ended) => ended === status);
}

/** Validate Stripe return URLs so callers cannot choose arbitrary domains. */
function safeDashboardUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ClientError(`${label} must be a valid URL`);
  }

  const allowed = allowedDashboardOrigin();
  const isLocalDev =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (allowed ? url.origin !== allowed : !isLocalDev) {
    throw new ClientError(`${label} must use the configured dashboard origin`);
  }

  return url.toString();
}
