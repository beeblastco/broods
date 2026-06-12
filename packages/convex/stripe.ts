/**
 * Stripe subscription queries, checkout/portal actions, and webhook plan sync.
 */

import { StripeSubscriptions } from "@convex-dev/stripe";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { action, internalMutation, query } from "./_generated/server";
import { authKit } from "./auth";

export const stripeClient = new StripeSubscriptions(components.stripe);

/** Returns the configured dashboard origin, with localhost fallback for dev. */
function allowedDashboardOrigin(): string | null {
    const explicit = process.env.DASHBOARD_ORIGIN?.trim();
    if (explicit) return new URL(explicit).origin;

    const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim();
    if (redirectUri) return new URL(redirectUri).origin;

    return null;
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
    const isLocalDev = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (allowed ? url.origin !== allowed : !isLocalDev) {
        throw new Error(`${label} must use the configured dashboard origin`);
    }

    return url.toString();
}

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

        return subs[0] ?? null;
    },
});

export const createCheckoutSession = action({
    args: { successUrl: v.string(), cancelUrl: v.string() },
    returns: v.object({ url: v.string() }),
    handler: async (ctx, args) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("Not authenticated");

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
            subscriptionMetadata: { authId: authUser.id },
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

export const syncPlanInternal = internalMutation({
    args: { authId: v.string(), status: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
        const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", args.authId))
            .first();

        if (!user) return null;

        const plan = args.status === "active" || args.status === "trialing" ? "pro" as const : "free" as const;
        await ctx.db.patch(user._id, { plan: plan });

        return null;
    },
});
