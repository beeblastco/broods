import { registerRoutes } from "@convex-dev/stripe";
import { httpRouter } from "convex/server";
import type Stripe from "stripe";
import { components, internal } from "./_generated/api";
import { authKit } from "./auth";

const http = httpRouter();

authKit.registerRoutes(http);

// Register route for stripe webhooks
registerRoutes(http, components.stripe, {
    events: {
        "customer.subscription.updated": async (ctx, event: Stripe.CustomerSubscriptionUpdatedEvent) => {
            const sub = event.data.object;
            const authId = sub.metadata?.authId;
            if (authId) {
                await ctx.runMutation(internal.stripe.syncPlanInternal, {
                    authId: authId,
                    status: sub.status,
                });
            }
        },
        "customer.subscription.deleted": async (ctx, event: Stripe.CustomerSubscriptionDeletedEvent) => {
            const sub = event.data.object;
            const authId = sub.metadata?.authId;
            if (authId) {
                await ctx.runMutation(internal.stripe.syncPlanInternal, {
                    authId: authId,
                    status: sub.status,
                });
            }
        },
    },
});

export default http;
