import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? "http://localhost:3000/auth/callback";

function parseReturnTo(value: string | null): string | null {
    if (!value?.startsWith("/")) {
        return null;
    }

    return value.startsWith("//") ? null : value;
}

/**
 * Route handler that redirects to the WorkOS sign-in page.
 * @returns Redirect to WorkOS AuthKit sign-in with the PKCE verifier cookie attached
 */
export async function GET(request: NextRequest) {
    const returnTo = parseReturnTo(request.nextUrl.searchParams.get("returnTo")) ?? "/";
    const authorizationUrl = await getSignInUrl({ returnTo: returnTo, redirectUri: redirectUri });

    // getSignInUrl sets the PKCE verifier cookie via next/headers (name prefix
    // `wos-auth-verifier-`). NextResponse.redirect() returns a fresh response
    // that does not always inherit those cookies, which makes the callback fail
    // with "Auth cookie missing — cannot verify OAuth state". Read the cookies
    // that were just set and forward the PKCE ones onto the redirect response.
    const response = NextResponse.redirect(authorizationUrl);
    const cookieStore = await cookies();
    for (const cookie of cookieStore.getAll()) {
        if (cookie.name.startsWith("wos-auth-verifier")) {
            response.cookies.set(cookie);
        }
    }

    return response;
}
