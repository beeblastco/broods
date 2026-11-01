import { processEvent } from "@convex-dev/stripe";
import { httpRouter } from "convex/server";
import Stripe from "stripe";
import { components } from "./_generated/api";
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
import { authProvider } from "./model/selfHostAuth";
import { reconcileSubscription } from "./stripe";

const http = httpRouter();

// Self-hosted AuthKit holds a placeholder webhook secret anyone could sign with.
if (authProvider() === "workos") authKit.registerRoutes(http);

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

http.route({ path: "/v1/account", method: "GET", handler: configHttp });
http.route({ path: "/v1/account", method: "PATCH", handler: configHttp });
http.route({
  path: "/v1/account/connections",
  method: "GET",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/account/connections/",
  method: "GET",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/account/connections/",
  method: "PUT",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/account/connections/",
  method: "DELETE",
  handler: configHttp,
});
http.route({
  pathPrefix: "/v1/account/connections/",
  method: "POST",
  handler: configHttp,
});
http.route({
  path: "/v1/account/rotate-secret",
  method: "POST",
  handler: configHttp,
});
http.route({
  path: "/v1/account/storage-trust",
  method: "GET",
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
// Unauthenticated by design: the path token is the credential. Convex serves HEAD here too.
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
http.route({ path: "/v1/audit", method: "GET", handler: configHttp });
http.route({ pathPrefix: "/v1/audit/", method: "GET", handler: configHttp });
http.route({ pathPrefix: "/v1/audit/", method: "PUT", handler: configHttp });
http.route({ pathPrefix: "/v1/audit/", method: "DELETE", handler: configHttp });

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

  // Every branch is idempotent, so redeliveries need no record of handled event ids.
  try {
    // A checkout also sends customer.subscription.created, so it needs no case of its own.
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      await reconcileSubscription(ctx, stripe, event.data.object.id);
    } else {
      await processEvent(ctx, components.stripe, event, stripe);
    }
  } catch (error) {
    console.error("Stripe webhook processing failed", error);

    return new Response("Webhook processing failed", { status: 500 });
  }

  return Response.json({ received: true });
}
