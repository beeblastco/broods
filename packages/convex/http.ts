/**
 * HTTP route registration for AuthKit and Stripe webhook handlers.
 */

import { registerRoutes } from "@convex-dev/stripe";
import { httpRouter } from "convex/server";
import { components, internal } from "./_generated/api";
import { authKit } from "./auth";

const http = httpRouter();

authKit.registerRoutes(http);

registerRoutes(http, components.stripe, {
    events: {
        "customer.subscription.updated": async (ctx, event) => {
            const sub = event.data.object;
            const authId = sub.metadata?.authId;
            if (authId) {
                await ctx.runMutation(internal.stripe.syncPlanInternal, {
                    authId: authId,
                    status: sub.status,
                });
            }
        },
        "customer.subscription.deleted": async (ctx, event) => {
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
