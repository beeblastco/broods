import { handleAuth } from "@workos-inc/authkit-nextjs";
import { NextResponse } from "next/server";
import { appOrigin } from "@/app/lib/authConfig";

const RETRY_COOKIE_NAME = "wos-callback-retry";

/**
 * Exchanges the WorkOS OAuth code for a session and redirects to the app.
 * On callback failure (e.g. expired PKCE cookie) restarts the sign-in flow
 * once, guarded by a one-shot cookie so a broken setup cannot redirect-loop.
 * @returns Redirect response after successful authentication
 */
export const GET = handleAuth({
  returnPathname: "/",
  baseURL: appOrigin,
  onError: ({ error, request }): NextResponse<unknown> => {
    if (request.cookies.has(RETRY_COOKIE_NAME)) {
      console.error("[auth/callback] sign-in retry also failed", error);

      return new NextResponse("Sign-in failed. Visit /auth/sign-in to retry.", {
        status: 500,
      });
    }

    const response = NextResponse.redirect(new URL("/auth/sign-in", appOrigin));
    response.cookies.set({
      name: RETRY_COOKIE_NAME,
      value: "1",
      maxAge: 60,
      httpOnly: true,
      sameSite: "lax",
      secure: appOrigin.startsWith("https:"),
      path: "/auth",
    });

    return response;
  },
});
