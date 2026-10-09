import { authkitProxy } from "@workos-inc/authkit-nextjs";
import type { NextMiddlewareResult } from "next/dist/server/web/types";
import {
  NextResponse,
  type NextFetchEvent,
  type NextRequest,
} from "next/server";
import { redirectUri } from "@/app/lib/authConfig";
import {
  SESSION_COOKIE,
  keyPagePath,
  selfHosted,
  verifySessionToken,
} from "@/app/lib/selfHostSession";

const UNAUTHENTICATED_PATHS = [
  "/healthz",
  "/auth/callback",
  "/auth/error",
  "/auth/key",
  "/auth/sign-in",
  "/auth/session",
  // The component fixture the browser tests drive; it 404s outside dev.
  ...(process.env.NODE_ENV === "development" ? ["/ui-gallery"] : []),
];

// A self-hosted stack never builds the AuthKit proxy, so it needs no WorkOS config.
const authProxy = selfHosted
  ? null
  : authkitProxy({
      redirectUri: redirectUri,
      // Hands the access token to the browser in a 30 s cookie on document loads,
      // so the client token store starts full instead of asking a server action.
      // With `initialAuth` in the root layout that removes both auth round trips
      // from a cold load.
      eagerAuth: true,
      middlewareAuth: {
        enabled: true,
        unauthenticatedPaths: UNAUTHENTICATED_PATHS,
      },
    });

export default function proxy(
  request: NextRequest,
  event: NextFetchEvent,
): Promise<NextMiddlewareResult> | NextMiddlewareResult {
  return authProxy ? authProxy(request, event) : selfHostProxy(request);
}

// Lets a signed-in admin through; anyone else goes to the admin-key page.
async function selfHostProxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  if (UNAUTHENTICATED_PATHS.includes(pathname)) return NextResponse.next();
  if (await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  // The proxy must redirect to an absolute URL; `request.url` carries the
  // request's own Host, not the server's bind address.
  return NextResponse.redirect(
    new URL(keyPagePath(pathname + search), request.url),
  );
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
