/**
 * Stripe webhook intake: owns /stripe/webhook instead of the component's
 * registerRoutes so customerless invoice events are acknowledged, not 500'd.
 */

import { processEvent } from "@convex-dev/stripe";
import { httpActionGeneric, type HttpRouter } from "convex/server";
import Stripe from "stripe";
import { components, internal } from "./_generated/api";

export function register(http: HttpRouter): void {
  http.route({
    path: "/stripe/webhook",
    method: "POST",
    handler: httpActionGeneric(async (ctx, req) => {
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        console.error("❌ STRIPE_WEBHOOK_SECRET is not set");
        return new Response("Webhook secret not configured", { status: 500 });
      }

      const signature = req.headers.get("stripe-signature");
      if (!signature) {
        console.error("❌ No Stripe signature in headers");
        return new Response("No signature provided", { status: 400 });
      }

      const apiKey = process.env.STRIPE_SECRET_KEY;
      if (!apiKey) {
        console.error("❌ STRIPE_SECRET_KEY is not set");
        return new Response("Stripe secret key not configured", {
          status: 500,
        });
      }

      const body = await req.text();
      const stripe = new Stripe(apiKey);

      let event: Stripe.Event;
      try {
        event = await stripe.webhooks.constructEventAsync(
          body,
          signature,
          webhookSecret,
        );
      } catch (err) {
        console.error("❌ Webhook signature verification failed:", err);
        return new Response(
          `Webhook signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
          { status: 400 },
        );
      }

      // Newer Stripe API versions send customerless invoices the component rejects.
      if (event.type.startsWith("invoice.")) {
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.customer === null) return ok();
      }

      try {
        await processEvent(ctx, components.stripe, event, stripe);

        if (
          event.type === "customer.subscription.updated" ||
          event.type === "customer.subscription.deleted"
        ) {
          const sub = event.data.object as Stripe.Subscription;
          const authId = sub.metadata?.authId;
          if (authId) {
            await ctx.runMutation(internal.stripe.syncPlanInternal, {
              authId: authId,
              status: sub.status,
            });
          }
        }
      } catch (error) {
        console.error("❌ Error processing webhook:", error);
        return new Response("Error processing webhook", { status: 500 });
      }

      return ok();
    }),
  });
}

function ok(): Response {
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
