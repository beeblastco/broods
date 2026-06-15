/**
 * HTTP onboarding endpoint for CLI project/org selection.
 */

import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

export const handle = httpAction(async (ctx, req) => {
    try {
        const auth = await bearerAuth(req);
        if (req.method === "GET") {
            const context = await ctx.runMutation(internal.cliAuth.getOnboardingContext, {
                tokenHash: auth.secretHash,
            });
            if (!context) return json({ error: "Invalid CLI token" }, 401);

            return json(context);
        }

        if (req.method === "POST") {
            const body = await req.json() as { orgId?: unknown };
            if (typeof body.orgId !== "string" || !body.orgId.trim()) {
                return json({ error: "Request body must include orgId" }, 400);
            }
            const context = await ctx.runMutation(internal.cliAuth.selectOnboardingOrg, {
                tokenHash: auth.secretHash,
                orgId: body.orgId as Id<"orgs">,
            });
            if (!context) return json({ error: "Invalid CLI token" }, 401);

            return json(context);
        }

        return json({ error: "Method not allowed" }, 405);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes("Authorization") || message.includes("token") ? 401 : 400;

        return json({ error: message }, status);
    }
});

async function bearerAuth(req: Request): Promise<{ token: string; secretHash: string }> {
    const header = req.headers.get("Authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) throw new Error("Authorization Bearer token is required");

    return {
        token: match[1],
        secretHash: await sha256Hex(match[1]),
    };
}

async function sha256Hex(value: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status: status,
        headers: { "Content-Type": "application/json" },
    });
}
