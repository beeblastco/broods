/**
 * HTTP router exposing gateway endpoints with header-based secret auth.
 * Each route validates X-Gateway-Secret and delegates to an internal function.
 */
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { assertGatewaySecretFromHeader } from "./model/gateway";

const http = httpRouter();

/** Returns a JSON response with the given status code and body. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Maps gateway auth errors to 401, all others to 500. */
function resolveErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Unauthorized") || message.includes("X-Gateway-Secret")) {
    return 401;
  }

  return 500;
}

/**
 * Wraps an internal query behind gateway secret validation.
 * @param fn Internal query function reference
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function gatewayQuery(fn: any) {
  return httpAction(async (ctx, req) => {
    try {
      assertGatewaySecretFromHeader(req);
      const args = await req.json();
      const result = await ctx.runQuery(fn, args);

      return jsonResponse(200, result);
    } catch (error) {
      return jsonResponse(resolveErrorStatus(error), {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * Wraps an internal mutation behind gateway secret validation.
 * @param fn Internal mutation function reference
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function gatewayMutation(fn: any) {
  return httpAction(async (ctx, req) => {
    try {
      assertGatewaySecretFromHeader(req);
      const args = await req.json();
      const result = await ctx.runMutation(fn, args);

      return jsonResponse(200, result);
    } catch (error) {
      return jsonResponse(resolveErrorStatus(error), {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

// --- Sessions ---
http.route({ path: "/api/gateway/sessions/create", method: "POST", handler: gatewayMutation(internal.sessions.createForGateway) });

// --- Messages ---
http.route({ path: "/api/gateway/messages/list", method: "POST", handler: gatewayQuery(internal.messages.listForGateway) });
http.route({ path: "/api/gateway/messages/create", method: "POST", handler: gatewayMutation(internal.messages.createForGateway) });

// --- Tasks ---
http.route({ path: "/api/gateway/tasks/update", method: "POST", handler: gatewayMutation(internal.tasks.updateForGateway) });

// --- Approvals ---
http.route({ path: "/api/gateway/approval/listPending", method: "POST", handler: gatewayQuery(internal.approval.listPendingForGateway) });
http.route({ path: "/api/gateway/approval/create", method: "POST", handler: gatewayMutation(internal.approval.createForGateway) });
http.route({ path: "/api/gateway/approval/respond", method: "POST", handler: gatewayMutation(internal.approval.respondForGateway) });
http.route({ path: "/api/gateway/approval/listByApprovalIds", method: "POST", handler: gatewayQuery(internal.approval.listByApprovalIdsForGateway) });

// --- Agent Config ---
http.route({ path: "/api/gateway/agentConfig/getSubAgents", method: "POST", handler: gatewayQuery(internal.agentConfig.getSubAgentsForGateway) });

// --- Agent Deployments ---
http.route({ path: "/api/gateway/agentDeployments/getByEndpointId", method: "POST", handler: gatewayQuery(internal.agentDeployments.getByEndpointIdForGateway) });

// --- Tool Services ---
http.route({ path: "/api/gateway/toolService/getConnected", method: "POST", handler: gatewayQuery(internal.toolService.getConnectedForGateway) });

export default http;
