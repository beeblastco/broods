/**
 * HTTP route registration: AuthKit, the Stripe webhook, the CLI routes, and the
 * config-plane routes the gateway forwards here.
 */

import { processEvent } from "@convex-dev/stripe";
import { httpRouter } from "convex/server";
import Stripe from "stripe";
import { components, internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { authKit } from "./auth";
import { exchange as cliAuthExchange } from "./cli/auth";
import { handle as cliHttp } from "./cli/http";
import {
  httpHandle as cliProjectsHttp,
  httpOnboarding as cliOnboardingHttp,
} from "./cli/projects";
import {
  httpHandle as cliStagesHttp,
  sessionHttpHandle as cliStageSessionHttp,
} from "./cli/stages";
import { handle as configHttp } from "./config/http";

const http = httpRouter();

authKit.registerRoutes(http);

http.route({
  path: "/stripe/webhook",
  method: "POST",
  handler: httpAction(handleStripeWebhook),
});

http.route({
  pathPrefix: "/v1/account/projects/",
  method: "POST",
  handler: cliHttp,
});

http.route({
  path: "/v1/account/auth/exchange",
  method: "POST",
  handler: cliAuthExchange,
});

http.route({
  path: "/v1/account/onboarding",
  method: "GET",
  handler: cliOnboardingHttp,
});

http.route({
  path: "/v1/account/onboarding",
  method: "POST",
  handler: cliOnboardingHttp,
});

// Bare `/v1/account/projects` only: the `/v1/account/projects/` prefix routes
// below carry a project name and belong to the deploy-key handler.
http.route({
  path: "/v1/account/projects",
  method: "GET",
  handler: cliProjectsHttp,
});

http.route({
  path: "/v1/account/projects",
  method: "DELETE",
  handler: cliProjectsHttp,
});

http.route({
  path: "/v1/account/stages",
  method: "GET",
  handler: cliStagesHttp,
});

http.route({
  path: "/v1/account/stages",
  method: "POST",
  handler: cliStagesHttp,
});

http.route({
  path: "/v1/account/stage-session",
  method: "POST",
  handler: cliStageSessionHttp,
});

http.route({
  pathPrefix: "/v1/account/projects/",
  method: "GET",
  handler: cliHttp,
});

http.route({
  pathPrefix: "/v1/account/projects/",
  method: "PUT",
  handler: cliHttp,
});

http.route({
  pathPrefix: "/v1/account/projects/",
  method: "DELETE",
  handler: cliHttp,
});

// Public config-plane surface: account metadata/rotation,
// agents, skills, mcp, hooks, workspace files, crons, workspaces, sandbox configs,
// and policies, forwarded here by the gateway.
http.route({ path: "/v1/account", method: "GET", handler: configHttp });
http.route({ path: "/v1/account", method: "PATCH", handler: configHttp });
http.route({
  path: "/v1/account/rotate-secret",
  method: "POST",
  handler: configHttp,
});
http.route({
  path: "/v1/account/assume-role",
  method: "POST",
  handler: configHttp,
});
http.route({ path: "/v1/roles", method: "GET", handler: configHttp });
http.route({ path: "/v1/roles", method: "POST", handler: configHttp });
http.route({ pathPrefix: "/v1/roles/", method: "GET", handler: configHttp });
http.route({ pathPrefix: "/v1/roles/", method: "PATCH", handler: configHttp });
http.route({ pathPrefix: "/v1/roles/", method: "DELETE", handler: configHttp });
http.route({ path: "/v1/accounts", method: "GET", handler: configHttp });
http.route({
  pathPrefix: "/v1/accounts/",
  method: "GET",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/accounts/",
  method: "PATCH",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/accounts/",
  method: "POST",
  handler: configHttp,
});
http.route({ path: "/v1/agents", method: "GET", handler: configHttp });
http.route({ path: "/v1/agents", method: "POST", handler: configHttp });
http.route({ pathPrefix: "/v1/agents/", method: "GET", handler: configHttp });
http.route({ pathPrefix: "/v1/agents/", method: "PATCH", handler: configHttp });
http.route({
  pathPrefix: "/v1/agents/",
  method: "DELETE",
  handler: configHttp,
});
http.route({ path: "/v1/channels", method: "GET", handler: configHttp });
http.route({ path: "/v1/channels", method: "POST", handler: configHttp });
http.route({ pathPrefix: "/v1/channels/", method: "GET", handler: configHttp });
http.route({
  pathPrefix: "/v1/channels/",
  method: "PATCH",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/channels/",
  method: "DELETE",
  handler: configHttp,
});
http.route({ path: "/v1/env", method: "GET", handler: configHttp });
http.route({ pathPrefix: "/v1/env/", method: "PUT", handler: configHttp });
http.route({ pathPrefix: "/v1/env/", method: "DELETE", handler: configHttp });
http.route({ path: "/v1/skills", method: "GET", handler: configHttp });
http.route({ path: "/v1/skills", method: "POST", handler: configHttp });
http.route({ pathPrefix: "/v1/skills/", method: "GET", handler: configHttp });
http.route({ pathPrefix: "/v1/skills/", method: "PUT", handler: configHttp });
http.route({
  pathPrefix: "/v1/skills/",
  method: "DELETE",
  handler: configHttp,
});
http.route({ path: "/v1/mcp", method: "GET", handler: configHttp });
http.route({ path: "/v1/mcp", method: "POST", handler: configHttp });
// The POST prefix is what /v1/mcp/uploads matches; path: "/v1/mcp" does not.
http.route({
  pathPrefix: "/v1/mcp/",
  method: "POST",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/mcp/",
  method: "GET",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/mcp/",
  method: "PATCH",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/mcp/",
  method: "DELETE",
  handler: configHttp,
});
http.route({ path: "/v1/hooks", method: "GET", handler: configHttp });
http.route({ path: "/v1/hooks", method: "POST", handler: configHttp });
http.route({ pathPrefix: "/v1/hooks/", method: "GET", handler: configHttp });
http.route({ pathPrefix: "/v1/hooks/", method: "PATCH", handler: configHttp });
http.route({ pathPrefix: "/v1/hooks/", method: "DELETE", handler: configHttp });
http.route({ path: "/v1/workspaces", method: "GET", handler: configHttp });
http.route({ path: "/v1/workspaces", method: "POST", handler: configHttp });
http.route({
  pathPrefix: "/v1/workspaces/",
  method: "GET",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/workspaces/",
  method: "POST",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/workspaces/",
  method: "PATCH",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/workspaces/",
  method: "DELETE",
  handler: configHttp,
});
// Redeeming a workspace download link. GET only, and unauthenticated by design:
// the token in the path is the credential. Convex serves HEAD off this route.
http.route({
  pathPrefix: "/v1/downloads/",
  method: "GET",
  handler: configHttp,
});
http.route({ path: "/v1/sandboxes", method: "GET", handler: configHttp });
http.route({ path: "/v1/sandboxes", method: "POST", handler: configHttp });
http.route({
  pathPrefix: "/v1/sandboxes/",
  method: "GET",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/sandboxes/",
  method: "PATCH",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/sandboxes/",
  method: "DELETE",
  handler: configHttp,
});
http.route({ path: "/v1/policies", method: "GET", handler: configHttp });
http.route({ path: "/v1/policies", method: "POST", handler: configHttp });
http.route({ pathPrefix: "/v1/policies/", method: "GET", handler: configHttp });
http.route({
  pathPrefix: "/v1/policies/",
  method: "PATCH",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/policies/",
  method: "DELETE",
  handler: configHttp,
});
http.route({ path: "/v1/crons", method: "GET", handler: configHttp });
http.route({ path: "/v1/crons", method: "POST", handler: configHttp });
http.route({ pathPrefix: "/v1/crons/", method: "GET", handler: configHttp });
http.route({ pathPrefix: "/v1/crons/", method: "PATCH", handler: configHttp });
http.route({ pathPrefix: "/v1/crons/", method: "DELETE", handler: configHttp });

export default http;

async function handleStripeWebhook(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    console.error("Stripe webhook environment is not configured");

    return new Response("Webhook not configured", { status: 500 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing Stripe signature", { status: 400 });
  }

  const stripe = new Stripe(secretKey);
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await request.text(),
      signature,
      webhookSecret,
    );
  } catch (error) {
    console.error("Stripe webhook signature verification failed", error);

    return new Response("Invalid Stripe signature", { status: 400 });
  }

  if (
    event.data.object.object === "invoice" &&
    event.data.object.customer === null
  ) {
    return Response.json({ received: true });
  }

  try {
    await processEvent(ctx, components.stripe, event, stripe);

    if (event.type === "checkout.session.completed") {
      await linkCheckoutToUser(ctx, stripe, event.data.object);
    }
    // Plan sync needs no checkout case: Stripe also sends
    // customer.subscription.created for the subscription a checkout starts.
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const authId = event.data.object.metadata.userId;
      if (authId) {
        await ctx.runMutation(internal.stripe.syncPlanInternal, {
          authId: authId,
        });
      }
    }
  } catch (error) {
    console.error("Stripe webhook processing failed", error);

    return new Response("Webhook processing failed", { status: 500 });
  }

  return Response.json({ received: true });
}

/**
 * Link a Payment Link checkout to the Broods user in `client_reference_id` by
 * stamping `metadata.userId` on its subscription and customer. The
 * customer.subscription.updated that follows files the subscription under the
 * user and syncs the plan. API checkouts set the metadata up front and carry
 * no `client_reference_id`, so they skip this.
 */
async function linkCheckoutToUser(
  ctx: ActionCtx,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const authId = session.client_reference_id;
  const subscriptionId = stripeId(session.subscription);
  const customerId = stripeId(session.customer);
  if (session.mode !== "subscription" || !authId) return;
  if (!subscriptionId || !customerId) return;

  const liveIds = await ctx.runQuery(
    internal.stripe.getLiveSubscriptionIdsInternal,
    { authId: authId },
  );
  if (liveIds === null) {
    console.warn(`Checkout ${session.id} names unknown user ${authId}`);

    return;
  }
  const otherIds = liveIds.filter((id) => id !== subscriptionId);
  if (otherIds.length > 0) {
    console.warn(
      `User ${authId} paid ${subscriptionId} while ${otherIds.join(", ")} is still live`,
    );
  }

  await stripe.subscriptions.update(subscriptionId, {
    metadata: { userId: authId },
  });
  await stripe.customers.update(customerId, { metadata: { userId: authId } });
  // customer.updated does not copy `metadata.userId` onto the component's
  // customer row (only customer.created does), so file it here. The portal
  // finds the customer by that key.
  await ctx.runMutation(components.stripe.public.createOrUpdateCustomer, {
    stripeCustomerId: customerId,
    email: session.customer_details?.email ?? undefined,
    metadata: { userId: authId },
  });
}

/** The id of an expandable Stripe field, whether or not it was expanded. */
function stripeId(field: string | { id: string } | null): string | null {
  return typeof field === "string" ? field : (field?.id ?? null);
}
