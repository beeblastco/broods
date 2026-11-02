import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { parseReturnTo, redirectUri } from "@/app/lib/authConfig";
import {
  keyPagePath,
  redirectToPath,
  selfHosted,
} from "@/app/lib/selfHostSession";

export async function GET(
  request: NextRequest,
): Promise<NextResponse<unknown>> {
  const returnTo =
    parseReturnTo(request.nextUrl.searchParams.get("returnTo")) ?? "/";
  if (selfHosted) {
    return redirectToPath(keyPagePath(returnTo));
  }
  const authorizationUrl = await getSignInUrl({
    returnTo: returnTo,
    redirectUri: redirectUri,
  });

  // getSignInUrl sets the PKCE verifier cookie via next/headers, which a fresh redirect
  // does not always carry; the callback then fails with "Auth cookie missing".
  const response = NextResponse.redirect(authorizationUrl);
  const cookieStore = await cookies();
  for (const cookie of cookieStore.getAll()) {
    if (cookie.name.startsWith("wos-auth-verifier")) {
      response.cookies.set(cookie);
    }
  }

  return response;
}
