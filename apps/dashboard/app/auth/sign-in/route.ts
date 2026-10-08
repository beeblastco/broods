import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { parseReturnTo, redirectUri } from "@/app/lib/authConfig";
import { selfHosted } from "@/app/lib/selfHostSession";

/**
 * @returns Redirect to WorkOS AuthKit sign-in with the PKCE verifier cookie
 * attached, or to the admin-key page on a self-hosted stack
 */
export async function GET(
  request: NextRequest,
): Promise<NextResponse<unknown>> {
  const returnTo =
    parseReturnTo(request.nextUrl.searchParams.get("returnTo")) ?? "/";
  if (selfHosted) {
    const keyPage = new URL("/auth/key", request.nextUrl);
    keyPage.searchParams.set("returnTo", returnTo);

    return NextResponse.redirect(keyPage);
  }
  const authorizationUrl = await getSignInUrl({
    returnTo: returnTo,
    redirectUri: redirectUri,
  });

  // getSignInUrl sets the PKCE verifier cookie through next/headers, but
  // NextResponse.redirect() builds a fresh response that does not always
  // inherit it, and the callback then fails with "Auth cookie missing".
  const response = NextResponse.redirect(authorizationUrl);
  const cookieStore = await cookies();
  for (const cookie of cookieStore.getAll()) {
    if (cookie.name.startsWith("wos-auth-verifier")) {
      response.cookies.set(cookie);
    }
  }

  return response;
}
