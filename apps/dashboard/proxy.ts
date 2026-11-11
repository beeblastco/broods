import { authkitProxy } from "@workos-inc/authkit-nextjs";
import type { NextMiddlewareResult } from "next/dist/server/web/types";
import {
  NextResponse,
  type NextFetchEvent,
  type NextRequest,
} from "next/server";
import { redirectUri } from "@/app/lib/authConfig";
import {
  NONCE_HEADER,
  contentSecurityPolicy,
} from "@/app/lib/contentSecurityPolicy";
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
  ...(process.env.NODE_ENV === "development" ? ["/ui-gallery"] : []),
];

const authProxy = selfHosted
  ? null
  : authkitProxy({
      redirectUri: redirectUri,
      // Access token in a 30 s cookie on document loads: with `initialAuth` in the root
      // layout, a cold load makes no auth round trip.
      eagerAuth: true,
      middlewareAuth: {
        enabled: true,
        unauthenticatedPaths: UNAUTHENTICATED_PATHS,
      },
    });

// Next stamps the request policy's nonce on its own scripts; the layout reads NONCE_HEADER.
export default async function proxy(
  request: NextRequest,
  event: NextFetchEvent,
): Promise<NextMiddlewareResult> {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce);
  request.headers.set("content-security-policy", policy);
  request.headers.set(NONCE_HEADER, nonce);
  const response = await (authProxy
    ? authProxy(request, event)
    : selfHostProxy(request));
  if (response) response.headers.set("content-security-policy", policy);

  return response;
}

async function selfHostProxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  if (
    UNAUTHENTICATED_PATHS.includes(pathname) ||
    (await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value))
  ) {
    return NextResponse.next({ request: { headers: request.headers } });
  }

  // Absolute URL required; `request.url` carries the request's Host, not the bind address.
  return NextResponse.redirect(
    new URL(keyPagePath(pathname + search), request.url),
  );
}

// Skip only files served from disk: `/[projectId]` matches a dotted segment like `/x.png`,
// so a broader asset exclusion answers a typo 200 with the app shell. Keep next.config's
// static-policy source the complement of this.
export const config = {
  matcher: ["/((?!_next|assets/|favicon\\.ico).*)", "/(api|trpc)(.*)"],
};
