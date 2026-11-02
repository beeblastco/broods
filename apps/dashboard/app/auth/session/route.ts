import { NextRequest, NextResponse } from "next/server";
import { parseReturnTo } from "@/app/lib/authConfig";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  adminKeyMatches,
  currentSession,
  keyPagePath,
  redirectToPath,
  selfHosted,
  signSessionToken,
} from "@/app/lib/selfHostSession";

// The client's Convex token refresh; `null` once signed out.
export async function GET(): Promise<NextResponse<{ token: string | null }>> {
  const session = selfHosted ? await currentSession() : null;

  return NextResponse.json(
    { token: session?.token ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// Both end in a full page load, so the root layout renders the new session.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const key = form.get("key");
  const returnToValue = form.get("returnTo");
  const returnTo =
    parseReturnTo(typeof returnToValue === "string" ? returnToValue : null) ??
    "/";
  if (!selfHosted || typeof key !== "string" || !adminKeyMatches(key)) {
    return redirectToPath(keyPagePath(returnTo, true), 303);
  }

  const response = redirectToPath(returnTo, 303);
  response.cookies.set({
    httpOnly: true,
    maxAge: SESSION_TTL_SECONDS,
    name: SESSION_COOKIE,
    path: "/",
    sameSite: "lax",
    // Behind a TLS-terminating proxy the request itself arrives over http.
    secure:
      request.nextUrl.protocol === "https:" ||
      request.headers.get("x-forwarded-proto") === "https",
    value: await signSessionToken(),
  });

  return response;
}

export async function DELETE(): Promise<NextResponse> {
  const response = new NextResponse(null, { status: 204 });
  response.cookies.delete(SESSION_COOKIE);

  return response;
}
