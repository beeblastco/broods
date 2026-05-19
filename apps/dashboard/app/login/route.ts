import { NextResponse } from "next/server";

export async function GET() {
    const { getSignInUrl } = await import("@workos-inc/authkit-nextjs");
    const authorizationUrl = await getSignInUrl({ returnTo: "/" });
    return NextResponse.redirect(authorizationUrl);
}
