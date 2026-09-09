import { authkitProxy } from "@workos-inc/authkit-nextjs";
import type { NextMiddlewareResult } from "next/dist/server/web/types";
import type { NextFetchEvent, NextRequest } from "next/server";
import { redirectUri } from "@/app/lib/authConfig";
const authProxy = authkitProxy({
  redirectUri: redirectUri,
  // Hands the access token to the browser in a 30 s cookie on document loads,
  // so the client token store starts full instead of asking a server action.
  // With `initialAuth` in the root layout that removes both auth round trips
  // from a cold load.
  eagerAuth: true,
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: [
      "/healthz",
      "/auth/callback",
      "/auth/sign-in",
      // The component fixture the browser tests drive; it 404s outside dev.
      ...(process.env.NODE_ENV === "development" ? ["/ui-gallery"] : []),
    ],
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
