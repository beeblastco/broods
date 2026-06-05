/**
 * Proxies `beeblast` CLI requests from the app domain to Convex HTTP routes.
 */

import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

type Context = {
    params: Promise<{ path: string[] }>;
};

export async function GET(req: NextRequest, ctx: Context): Promise<Response> {
    return await proxyCliRequest(req, ctx);
}

export async function PUT(req: NextRequest, ctx: Context): Promise<Response> {
    return await proxyCliRequest(req, ctx);
}

export async function DELETE(req: NextRequest, ctx: Context): Promise<Response> {
    return await proxyCliRequest(req, ctx);
}

async function proxyCliRequest(req: NextRequest, ctx: Context): Promise<Response> {
    const { path } = await ctx.params;
    const target = convexSiteUrl();
    target.pathname = `/api/cli/${path.map(encodeURIComponent).join("/")}`;
    target.search = new URL(req.url).search;

    const response = await fetch(target, {
        method: req.method,
        headers: forwardedHeaders(req),
        body: req.method === "GET" ? undefined : await req.text(),
        cache: "no-store",
    });

    return new Response(response.body, {
        status: response.status,
        headers: response.headers,
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
