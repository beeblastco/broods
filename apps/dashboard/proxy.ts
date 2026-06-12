import { authkitProxy } from "@workos-inc/authkit-nextjs";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";

const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? "http://localhost:3000/auth/callback";
const authProxy = authkitProxy({
    redirectUri: redirectUri,
    middlewareAuth: {
        enabled: true,
        unauthenticatedPaths: [
            "/healthz",
            "/auth/callback",
            "/auth/sign-in",
        ],
    },
});

/**
 * WorkOS AuthKit middleware for session management.
 */
export default function proxy(request: NextRequest, event: NextFetchEvent) {
    if (request.nextUrl.pathname.startsWith("/api/cli/")) {
        return NextResponse.next();
    }

    return authProxy(request, event);
}

/**
 * Configure middleware to run on all routes except static assets.
 */
export const config = {
    matcher: [
        "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
        "/(api|trpc)(.*)",
    ],
};
