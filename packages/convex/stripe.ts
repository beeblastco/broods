/**
 * Stripe subscription queries, checkout/portal actions, and webhook plan sync.
 */

import { StripeSubscriptions } from "@convex-dev/stripe";
import { v } from "convex/values";
import type Stripe from "stripe";
import { components } from "./_generated/api";
import { action, internalMutation, query } from "./_generated/server";
import { authKit } from "./auth";

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

    const { customerId } = await stripeClient.getOrCreateCustomer(ctx, {
      userId: authUser.id,
      email: authUser.email ?? undefined,
    });

    // Stops a second click or tab. It reads webhook-synced rows, so a checkout
    // paid seconds ago can still slip through; Stripe's "limit customers to
    // one subscription" Checkout setting closes that window.
    const subs = await ctx.runQuery(
      components.stripe.public.listSubscriptions,
      { stripeCustomerId: customerId },
    );
    if (subs.some((sub) => !isEnded(sub.status))) {
      throw new Error("Already subscribed; use Manage Billing to change plan");
    }

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

    return subs.find((sub) => !isEnded(sub.status)) ?? subs[0] ?? null;
  },
});

/**
 * Recompute a user's plan from their synced subscriptions. The webhook runs
 * it after `processEvent`. `users.plan` is the source of truth; orgs the user
 * owns carry a copy so the CLI and org settings read it off the org.
 */
export const syncPlanInternal = internalMutation({
  args: { authId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", args.authId))
      .unique();
    if (!user) return null;

    const subs = await ctx.runQuery(
      components.stripe.public.listSubscriptionsByUserId,
      { userId: args.authId },
    );
    const paid = subs.some((sub) =>
      PAID_STATUSES.some((status) => status === sub.status),
    );
    const plan = paid ? ("pro" as const) : ("free" as const);
    if (user.plan !== plan) await ctx.db.patch(user._id, { plan: plan });

    const orgs = await ctx.db
      .query("orgs")
      .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", args.authId))
      .collect();
    for (const org of orgs) {
      if (org.plan !== plan) await ctx.db.patch(org._id, { plan: plan });
    }

    return null;
  },
});

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
    throw new Error(`${label} must be a valid URL`);
  }

  const allowed = allowedDashboardOrigin();
  const isLocalDev =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (allowed ? url.origin !== allowed : !isLocalDev) {
    throw new Error(`${label} must use the configured dashboard origin`);
  }

  return url.toString();
}
