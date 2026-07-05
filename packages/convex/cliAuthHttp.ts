/**
 * HTTP exchange endpoint for WorkOS-backed CLI login codes.
 */

import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

export const exchange = httpAction(async (ctx, req) => {
    if (req.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
    }

    try {
        const body = await req.json() as { code?: unknown };
        if (typeof body.code !== "string" || !body.code.trim()) {
            return json({ error: "Request body must include code" }, 400);
        }

        const result: Record<string, unknown> = await ctx.runMutation(internal.cliAuth.exchangeLoginCode, {
            code: body.code,
        });

        // Echo this deployment's own HTTP origin so CLIs that exchanged through
        // the dashboard proxy still learn the direct control-plane URL.
        return json({ ...result, controlUrl: new URL(req.url).origin });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return json({ error: message }, 400);
    }
});

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status: status,
        headers: { "Content-Type": "application/json" },
    });
}
