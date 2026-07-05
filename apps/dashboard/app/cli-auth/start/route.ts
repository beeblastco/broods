/**
 * Authenticated browser bridge for `broods login`.
 */

import { withAuth } from "@workos-inc/authkit-nextjs";
import { api } from "@broods/convex/_generated/api";
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
        const { code } = await createLoginCodeWithRetry(client);
        const target = new URL(callback);
        target.searchParams.set("code", code);
        target.searchParams.set("state", state);
        // BROODS_BASE_URL advertises the unified public domain (the gateway,
        // which proxies /v1/cli/* to Convex); without it we point the CLI at
        // the Convex deployment directly.
        target.searchParams.set("base_url", advertisedBaseUrl());

        return NextResponse.redirect(target);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return text(`broods CLI login failed: ${message}`, 500);
    }
}

async function createLoginCodeWithRetry(client: ConvexHttpClient): Promise<{ code: string }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            return await client.mutation(api.cliAuth.createLoginCode, {});
        } catch (error) {
            lastError = error;
            if (!isRetryableLoginRace(error) || attempt === 3) {
                throw error;
            }
            await wait(350 * (attempt + 1));
        }
    }

    throw lastError;
}

function isRetryableLoginRace(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);

    return /User not found/i.test(message);
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Public base URL the CLI should call for the /v1/cli/* control-plane routes. */
function advertisedBaseUrl(): string {
    const explicit = process.env.BROODS_BASE_URL;
    if (explicit) {
        return new URL(explicit).origin;
    }
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!convexUrl) throw new Error("BROODS_BASE_URL or NEXT_PUBLIC_CONVEX_URL is required");

    return new URL(convexUrl.replace(".convex.cloud", ".convex.site")).origin;
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
