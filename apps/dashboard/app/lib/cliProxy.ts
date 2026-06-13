/**
 * Proxies filthy-panty CLI requests from the dashboard domain to Convex HTTP routes.
 */

import type { NextRequest } from "next/server";

export async function proxyCliRequest(req: NextRequest): Promise<Response> {
    const incoming = new URL(req.url);
    const target = convexSiteUrl();
    // Forward the already-encoded /api/cli/... path verbatim. The dashboard and
    // Convex share this prefix, so copying pathname avoids a decode/re-encode
    // round-trip that would otherwise double-encode special characters.
    target.pathname = incoming.pathname;
    target.search = incoming.search;

    let response: Response;
    try {
        response = await fetch(target, {
            method: req.method,
            headers: forwardedHeaders(req),
            body: req.method === "GET" ? undefined : await req.text(),
            cache: "no-store",
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return json({ error: `Failed to reach Convex CLI endpoint: ${message}` }, 502);
    }

    const body = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") ?? "application/json";

    return new Response(body, {
        status: response.status,
        headers: {
            "Content-Type": contentType,
            "Cache-Control": "no-store",
        },
    });
}

function convexSiteUrl(): URL {
    const explicit = process.env.CONVEX_SITE_URL;
    if (explicit) return new URL(explicit);
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!convexUrl) throw new Error("CONVEX_SITE_URL or NEXT_PUBLIC_CONVEX_URL is required");

    return new URL(convexUrl.replace(".convex.cloud", ".convex.site"));
}

function forwardedHeaders(req: NextRequest): Headers {
    const headers = new Headers();
    const authorization = req.headers.get("authorization");
    const contentType = req.headers.get("content-type");
    if (authorization) headers.set("authorization", authorization);
    if (contentType) headers.set("content-type", contentType);

    return headers;
}

function json(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status: status,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        },
    });
}
