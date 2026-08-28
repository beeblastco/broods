import { authkitProxy } from "@workos-inc/authkit-nextjs";
import type { NextMiddlewareResult } from "next/dist/server/web/types";
import type { NextFetchEvent, NextRequest } from "next/server";
import { redirectUri } from "@/app/lib/authConfig";
const authProxy = authkitProxy({
  redirectUri: redirectUri,
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ["/healthz", "/auth/callback", "/auth/sign-in"],
  },
});

/**
 * WorkOS AuthKit middleware for session management.
 */
export default function proxy(
  request: NextRequest,
  event: NextFetchEvent,
): Promise<NextMiddlewareResult> | NextMiddlewareResult {
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
