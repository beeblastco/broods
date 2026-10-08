import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { appOrigin, parseReturnTo } from "@/app/lib/authConfig";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  adminKeyMatches,
  selfHosted,
  sessionUser,
  signSessionToken,
} from "@/app/lib/selfHostSession";

/**
 * The self-hosted session. GET hands the Convex client the token it cannot
 * read from the httpOnly cookie; POST is the admin-key form; DELETE signs out.
 * Sign-in and sign-out answer with a full page load so the root layout
 * renders the new session.
 */
export async function GET(): Promise<NextResponse<{ token: string | null }>> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const valid = selfHosted && (await sessionUser(token)) !== null;

  return NextResponse.json(
    { token: valid ? (token ?? null) : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** @returns 303 to `returnTo` with the session cookie, or back to the form with `error` */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const key = form.get("key");
  const returnToValue = form.get("returnTo");
  const returnTo =
    parseReturnTo(typeof returnToValue === "string" ? returnToValue : null) ??
    "/";
  if (!selfHosted || typeof key !== "string" || !adminKeyMatches(key.trim())) {
    const keyPage = new URL("/auth/key", request.nextUrl);
    keyPage.searchParams.set("returnTo", returnTo);
    keyPage.searchParams.set("error", "1");

    return NextResponse.redirect(keyPage, 303);
  }

  const response = NextResponse.redirect(
    new URL(returnTo, request.nextUrl),
    303,
  );
  response.cookies.set({
    httpOnly: true,
    maxAge: SESSION_TTL_SECONDS,
    name: SESSION_COOKIE,
    path: "/",
    sameSite: "lax",
    secure: appOrigin.startsWith("https:"),
    value: await signSessionToken(),
  });

  return response;
}

export async function DELETE(): Promise<NextResponse> {
  const response = new NextResponse(null, { status: 204 });
  response.cookies.delete(SESSION_COOKIE);

  return response;
}
