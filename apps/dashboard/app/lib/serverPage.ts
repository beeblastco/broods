/** Helpers for server pages that act as the signed-in caller: `broods login` and the GitHub callback. */

import { currentSession, selfHosted } from "@/app/lib/selfHostSession";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

/**
 * The signed-in caller's Convex token. A self-hosted session token is
 * the Convex token itself; the proxy already sent a signed-out caller to the
 * key page with the page as `returnTo`.
 */
export async function signedInAccessToken(): Promise<string> {
  if (!selfHosted)
    return (await withAuth({ ensureSignedIn: true })).accessToken;
  const session = await currentSession();
  if (!session) redirect("/auth/sign-in");

  return session.token;
}

/** One search param of a server page, the first when it repeats. */
export function firstParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
