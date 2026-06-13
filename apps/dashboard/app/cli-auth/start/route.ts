/**
 * Authenticated browser bridge for `filthy-panty login`.
 */

import { withAuth } from "@workos-inc/authkit-nextjs";
import { api } from "@filthy-panty/convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
    try {
        const auth = await withAuth({ ensureSignedIn: true });
        const callback = request.nextUrl.searchParams.get("callback");
        const state = request.nextUrl.searchParams.get("state");
        if (!callback || !state) {
            return text("callback and state are required", 400);
        }
        if (!isLocalCallback(callback)) {
            return text("callback must be a localhost URL", 400);
        }

        const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
        if (!convexUrl) {
            return text("NEXT_PUBLIC_CONVEX_URL is required", 500);
        }

        const client = new ConvexHttpClient(convexUrl);
        client.setAuth(auth.accessToken);
        const { code } = await client.mutation(api.cliAuth.createLoginCode, {});
        const target = new URL(callback);
        target.searchParams.set("code", code);
        target.searchParams.set("state", state);

        return NextResponse.redirect(target);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return text(`filthy-panty CLI login failed: ${message}`, 500);
    }
}

function isLocalCallback(value: string): boolean {
    try {
        const url = new URL(value);

        return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    } catch {
        return false;
    }
}

function text(message: string, status: number): Response {
    return new Response(`${message}\n`, {
        status: status,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
}
