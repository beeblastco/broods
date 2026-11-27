/** Helpers for server pages acting as the signed-in caller: `broods login`, MCP sign-in, GitHub. */

import { currentSession, selfHosted } from "@/app/lib/selfHostSession";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
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

/** The public host in front of core. A Convex site serves only the config plane. */
export function advertisedBaseUrl(): string {
  const explicit = process.env.BROODS_BASE_URL;
  if (!explicit) {
    throw new Error(
      "this dashboard has no BROODS_BASE_URL; set it to the public host in front of core",
    );
  }

  return new URL(explicit).origin;
}

/** One search param of a server page, the first when it repeats. */
export function firstParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A Convex client for the caller whose user row and active org exist, with the org's API
 * account provisioned: what `broods login` needs before it hands out access.
 */
export async function provisionedCaller(
  accessToken: string,
): Promise<ConvexHttpClient> {
  const client = await syncedCaller(accessToken);
  const org = await client.mutation(api.org.orgs.getOrCreate, {});
  if (org.needsProvision) {
    await provisionOrg(
      client,
      org.orgId,
      async () =>
        (await client.mutation(api.org.orgs.getOrCreate, {})).needsProvision,
    );
  }

  return client;
}

/** Creates `orgId`'s API account; `stillMissing` tells a lost race from a real failure. */
export async function provisionOrg(
  client: ConvexHttpClient,
  orgId: Id<"orgs">,
  stillMissing: () => Promise<boolean>,
): Promise<void> {
  try {
    await client.action(api.org.lifecycle.provision, { orgId: orgId });
  } catch (error) {
    // Another tab may have provisioned first; only a still-missing account is a failure.
    if (await stillMissing()) throw error;
  }
}

/** A Convex client for the caller, once their user row exists. */
export async function syncedCaller(
  accessToken: string,
): Promise<ConvexHttpClient> {
  const client = convexCaller(accessToken);
  // A login right after signup can beat the WorkOS webhook that creates the user row.
  await client.action(api.user.ensureSynced, {});

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
