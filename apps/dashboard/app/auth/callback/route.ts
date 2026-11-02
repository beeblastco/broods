import { handleAuth } from "@workos-inc/authkit-nextjs";
import { NextResponse } from "next/server";
import { appOrigin } from "@/app/lib/authConfig";

const RETRY_COOKIE_NAME = "wos-callback-retry";

// Restarts sign-in once on failure (e.g. expired PKCE cookie); the cookie stops a loop.
export const GET = handleAuth({
  returnPathname: "/",
  baseURL: appOrigin,
  onError: ({ error, request }): NextResponse<unknown> => {
    if (request.cookies.has(RETRY_COOKIE_NAME)) {
      console.error("[auth/callback] sign-in retry also failed", error);
      // Dropping the guard gives "Sign in again" its own automatic retry.
      const failed = NextResponse.redirect(new URL("/auth/error", appOrigin));
      failed.cookies.delete({ name: RETRY_COOKIE_NAME, path: "/auth" });

      return failed;
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
