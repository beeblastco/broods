/**
 * HTTP route registration for AuthKit and Stripe webhook handlers.
 */

import { registerRoutes } from "@convex-dev/stripe";
import { httpRouter } from "convex/server";
import { components, internal } from "./_generated/api";
import { authKit } from "./auth";
import { exchange as cliAuthExchange } from "./cliAuthHttp";
import { handle as cliHttp } from "./cliHttp";
import { handle as cliOnboardingHttp } from "./cliOnboardingHttp";
import { handle as configHttp } from "./configHttp";

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

http.route({
    pathPrefix: "/api/cli/projects/",
    method: "POST",
    handler: cliHttp,
});

http.route({
    path: "/api/cli/auth/exchange",
    method: "POST",
    handler: cliAuthExchange,
});

http.route({
    path: "/api/cli/onboarding",
    method: "GET",
    handler: cliOnboardingHttp,
});

http.route({
    path: "/api/cli/onboarding",
    method: "POST",
    handler: cliOnboardingHttp,
});

http.route({
    pathPrefix: "/api/cli/projects/",
    method: "GET",
    handler: cliHttp,
});

http.route({
    pathPrefix: "/api/cli/projects/",
    method: "PUT",
    handler: cliHttp,
});

http.route({
    pathPrefix: "/api/cli/projects/",
    method: "DELETE",
    handler: cliHttp,
});

// Public config-plane surface (epic #85 phase 9): skills, tools, workspace
// files, crons, workspaces, sandbox configs, and policies, forwarded here by
// the gateway. Bearer account auth.
http.route({ path: "/v1/skills", method: "GET", handler: configHttp });
http.route({ path: "/v1/skills", method: "POST", handler: configHttp });
http.route({ pathPrefix: "/v1/skills/", method: "GET", handler: configHttp });
http.route({ pathPrefix: "/v1/skills/", method: "PUT", handler: configHttp });
http.route({ pathPrefix: "/v1/skills/", method: "DELETE", handler: configHttp });
http.route({ path: "/v1/tools", method: "GET", handler: configHttp });
http.route({ path: "/v1/tools", method: "POST", handler: configHttp });
http.route({ pathPrefix: "/v1/tools/", method: "GET", handler: configHttp });
http.route({ pathPrefix: "/v1/tools/", method: "PATCH", handler: configHttp });
http.route({ pathPrefix: "/v1/tools/", method: "DELETE", handler: configHttp });
http.route({ path: "/v1/workspaces", method: "GET", handler: configHttp });
http.route({ path: "/v1/workspaces", method: "POST", handler: configHttp });
http.route({ pathPrefix: "/v1/workspaces/", method: "GET", handler: configHttp });
http.route({ pathPrefix: "/v1/workspaces/", method: "POST", handler: configHttp });
http.route({ pathPrefix: "/v1/workspaces/", method: "PATCH", handler: configHttp });
http.route({ pathPrefix: "/v1/workspaces/", method: "DELETE", handler: configHttp });
http.route({ path: "/v1/sandboxes", method: "GET", handler: configHttp });
http.route({ path: "/v1/sandboxes", method: "POST", handler: configHttp });
http.route({ pathPrefix: "/v1/sandboxes/", method: "GET", handler: configHttp });
http.route({ pathPrefix: "/v1/sandboxes/", method: "PATCH", handler: configHttp });
http.route({ pathPrefix: "/v1/sandboxes/", method: "DELETE", handler: configHttp });
http.route({ path: "/v1/policies", method: "GET", handler: configHttp });
http.route({ path: "/v1/policies", method: "POST", handler: configHttp });
http.route({ pathPrefix: "/v1/policies/", method: "GET", handler: configHttp });
http.route({ pathPrefix: "/v1/policies/", method: "PATCH", handler: configHttp });
http.route({ pathPrefix: "/v1/policies/", method: "DELETE", handler: configHttp });
http.route({ path: "/v1/crons", method: "GET", handler: configHttp });
http.route({ path: "/v1/crons", method: "POST", handler: configHttp });
http.route({ pathPrefix: "/v1/crons/", method: "GET", handler: configHttp });
http.route({ pathPrefix: "/v1/crons/", method: "PATCH", handler: configHttp });
http.route({ pathPrefix: "/v1/crons/", method: "DELETE", handler: configHttp });

export default http;
