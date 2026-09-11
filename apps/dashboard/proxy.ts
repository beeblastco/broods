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
 * Configure middleware to run on every route except the files actually served
 * from disk: the build output, `public/assets/`, and the favicon.
 *
 * Excluding every asset-looking path instead let `/x.png` past the proxy and
 * into the router, where `/[projectId]` matches any single segment, dot
 * included. A typo answered 200 with the app shell, so uptime checks and
 * crawlers read it as a live page.
 */
export const config = {
  matcher: ["/((?!_next|assets/|favicon\\.ico).*)", "/(api|trpc)(.*)"],
};
