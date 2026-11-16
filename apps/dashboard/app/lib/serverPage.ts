/** Helpers for server pages acting as the signed-in caller: `broods login`, MCP sign-in, GitHub. */

import { currentSession, selfHosted } from "@/app/lib/selfHostSession";
import { api } from "@broods/convex/_generated/api";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { ConvexHttpClient } from "convex/browser";
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

/**
 * A Convex client for the caller whose user row and active org exist, with the org's API
 * account provisioned: what `broods login` and MCP sign-in need before they hand out access.
 */
export async function provisionedCaller(
  accessToken: string,
): Promise<ConvexHttpClient> {
  const client = convexCaller(accessToken);
  // A login right after signup can beat the WorkOS webhook that creates the user row.
  await client.action(api.user.ensureSynced, {});
  const org = await client.mutation(api.org.orgs.getOrCreate, {});
  if (org.needsProvision) {
    try {
      await client.action(api.org.lifecycle.provision, { orgId: org.orgId });
    } catch (error) {
      // Another tab may have provisioned first; only a still-missing account is a failure.
      if ((await client.mutation(api.org.orgs.getOrCreate, {})).needsProvision)
        throw error;
    }
  }

  return client;
}

/** A Convex client that acts as the signed-in caller. */
export function convexCaller(accessToken: string): ConvexHttpClient {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) throw new Error("The login backend is not configured.");
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(accessToken);

  return client;
}
