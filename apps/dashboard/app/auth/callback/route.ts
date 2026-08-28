import { handleAuth } from "@workos-inc/authkit-nextjs";
import { NextResponse } from "next/server";

// One-shot guard so a systemic callback failure (bad env, clock skew) cannot
// bounce the browser between /auth/sign-in and WorkOS forever.
const RETRY_COOKIE_NAME = "wos-callback-retry";
const RETRY_COOKIE_MAX_AGE_SECONDS = 60;

const redirectUri =
  process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ??
  "http://localhost:3000/auth/callback";
const url = new URL(redirectUri);

/**
 * Exchanges the WorkOS OAuth code for a session and redirects to the app.
 *
 * The PKCE verifier cookie AuthKit sets when redirecting to sign-in only lives
 * 10 minutes. A user who sits on the WorkOS sign-in page longer than that (or
 * replays a used callback URL) hits the callback with no verifiable state,
 * which by default renders a raw JSON error. Instead, restart the sign-in flow
 * once so they get a fresh cookie and land in the app.
 * @returns Redirect response after successful authentication
 */
export const GET = handleAuth({
  returnPathname: "/",
  baseURL: url.origin,
  onError: ({ error, request }): NextResponse<unknown> => {
    if (request.cookies.has(RETRY_COOKIE_NAME)) {
      return signInFailedResponse(error);
    }

    const response = NextResponse.redirect(
      new URL("/auth/sign-in", url.origin),
    );
    response.cookies.set({
      name: RETRY_COOKIE_NAME,
      value: "1",
      maxAge: RETRY_COOKIE_MAX_AGE_SECONDS,
      httpOnly: true,
      sameSite: "lax",
      path: "/auth",
    });

    return response;
  },
});

/**
 * Terminal error page shown only when restarting the flow also failed.
 * @returns Minimal HTML response with a link to retry sign-in manually
 */
function signInFailedResponse(error: unknown): NextResponse<unknown> {
  console.error("[auth/callback] sign-in retry also failed", error);

  return new NextResponse(
    `<!doctype html><html><body style="background:#000;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><p>Sign-in failed. Please try again.</p><a href="/auth/sign-in" style="color:#fff">Sign in</a></div></body></html>`,
    {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}
