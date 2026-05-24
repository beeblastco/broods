/**
 * Service-token proxy from the browser to filthy-panty's harness SSE
 * endpoint. The browser never sees the service secret; this route resolves
 * the caller's active accountId via Convex and forwards the request body to
 * filthy-panty's sync streaming endpoint.
 */

import { api } from "@/convex/_generated/api";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { ConvexHttpClient } from "convex/browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/agent/stream — proxies the body to filthy-panty and pipes the SSE stream back. */
export async function POST(request: Request) {
    const { accessToken } = await withAuth({ ensureSignedIn: true });
    if (!accessToken) {
        return new Response("Unauthorized", { status: 401 });
    }

    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!convexUrl) {
        return new Response("Server misconfigured: NEXT_PUBLIC_CONVEX_URL", { status: 500 });
    }

    const convex = new ConvexHttpClient(convexUrl);
    convex.setAuth(accessToken);
    const account = await convex.query(api.org.getActiveAccount, {});
    if (!account || account.status !== "active") {
        return new Response("Account not provisioned or disabled", { status: 400 });
    }

    const harnessUrl = process.env.FILTHY_PANTY_HARNESS_URL;
    const serviceSecret = process.env.FILTHY_PANTY_SERVICE_AUTH_SECRET;
    if (!harnessUrl || !serviceSecret) {
        return new Response("Server misconfigured: filthy-panty env vars", { status: 500 });
    }

    const body = await request.text();
    const upstream = await fetch(`${harnessUrl}/`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${serviceSecret}`,
            "X-Account-Id": account.accountId,
            "Content-Type": "application/json",
        },
        body: body,
    });

    if (!upstream.ok || !upstream.body) {
        const text = await upstream.text();
        return new Response(text, { status: upstream.status });
    }

    return new Response(upstream.body, {
        status: 200,
        headers: {
            "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
        },
    });
}
