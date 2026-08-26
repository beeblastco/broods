/**
 * Owner-authenticated internal test endpoint for the dashboard's agent Test
 * chat. Routes a chat turn to the core runtime's direct API with the shared
 * service-auth secret — the internal caller class that is never gated on
 * `publicAccess` — so an owner can test their own private agent without
 * making it publicly reachable first.
 *
 * Dashboard-internal, not part of the public account API: the caller
 * authenticates with their WorkOS session JWT (the same token the Convex
 * client uses), and ownership of the agent config's project is checked
 * server-side before any runtime call. A runtime key can never reach this.
 */

import { v } from "convex/values";
import { httpAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { authKit } from "./auth";
import { resolveAgentConversationScope } from "./model/conversationHistory";

/**
 * Resolve the caller's scope for one agent config. Runs as a sub-query of the
 * HTTP action so `authKit` sees the request's identity; returns null when the
 * caller does not own the config's project (or the agent is not deployed).
 */
export const resolveScope = internalQuery({
  args: { configId: v.id("agentConfigs") },
  returns: v.union(
    v.object({ accountId: v.string(), agentId: v.string() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const scope = await resolveAgentConversationScope(
      ctx,
      user.id,
      args.configId,
    );
    if (!scope) return null;

    return { accountId: scope.accountId, agentId: scope.agentId };
  },
});

/** Origins allowed to call the endpoint from a browser. */
function allowedOrigins(): string[] {
  const dashboardOrigin = process.env.DASHBOARD_ORIGIN?.replace(/\/+$/, "");

  return [
    ...(dashboardOrigin ? [dashboardOrigin] : []),
    // Local `next dev`. Auth still requires a WorkOS session JWT; CORS here
    // only controls which pages may attempt the call.
    "http://localhost:3000",
  ];
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";

  return allowedOrigins().includes(origin)
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      }
    : {};
}

function jsonError(
  request: Request,
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({ error: error, ...extra }), {
    status: status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request),
    },
  });
}

export const preflight = httpAction(async (_ctx, request) => {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
});

interface InvokeBody {
  configId?: unknown;
  text?: unknown;
  conversationKey?: unknown;
}

export const invoke = httpAction(async (ctx, request) => {
  let body: InvokeBody;
  try {
    body = (await request.json()) as InvokeBody;
  } catch {
    return jsonError(request, 400, "Invalid request JSON");
  }
  if (typeof body.configId !== "string" || typeof body.text !== "string") {
    return jsonError(request, 400, "configId and text are required");
  }
  if (
    body.conversationKey !== undefined &&
    typeof body.conversationKey !== "string"
  ) {
    return jsonError(request, 400, "conversationKey must be a string");
  }

  // Identity comes from the request's Authorization JWT; the sub-query
  // performs the auth + ownership checks and yields the account/agent scope.
  let scope: { accountId: string; agentId: string } | null;
  try {
    scope = await ctx.runQuery(internal.agentTestHttp.resolveScope, {
      configId: body.configId as never,
    });
  } catch {
    return jsonError(request, 401, "Unauthorized");
  }
  if (!scope) {
    return jsonError(request, 404, "Agent not found");
  }

  const baseUrl = process.env.BROODS_ACCOUNT_MANAGE_URL?.replace(/\/+$/, "");
  const secret = process.env.BROODS_SERVICE_AUTH_SECRET;
  if (!baseUrl || !secret) {
    return jsonError(
      request,
      503,
      "Internal test endpoint is not configured: BROODS_ACCOUNT_MANAGE_URL or BROODS_SERVICE_AUTH_SECRET missing",
    );
  }

  const conversationKey = body.conversationKey ?? `chat-${crypto.randomUUID()}`;
  const upstream = await fetch(`${baseUrl}/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "X-Account-Id": scope.accountId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agentId: scope.agentId,
      eventId: `evt-${crypto.randomUUID()}`,
      conversationKey: conversationKey,
      events: [
        {
          role: "user",
          content: [{ type: "text", text: body.text }],
        },
      ],
      stream: true,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");

    return jsonError(
      request,
      upstream.status || 502,
      detail || "Agent runtime request failed",
    );
  }

  // Same AI-SDK SSE stream the public HTTP path serves — pipe it through so
  // the chat renders deltas live. The conversation key rides a header so the
  // client can continue the conversation (and ticket 11's history threads it).
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Session-Id": conversationKey,
      "Access-Control-Expose-Headers": "X-Session-Id",
      ...corsHeaders(request),
    },
  });
});
