/**
 * Authenticated browser bridge for `broods login`. Sets up the caller's org on
 * a first login, mints a one-time code and redirects to the CLI's localhost
 * callback. A failure once the callback is known goes back to it as `error`
 * (with `state`), so the CLI stops waiting at once; a bad link renders here.
 */

import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import { toErrorMessage } from "@/app/lib/errors";
import { api } from "@broods/convex/_generated/api";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { ConvexHttpClient } from "convex/browser";
import Link from "next/link";
import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function CliAuthStartPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<React.JSX.Element> {
  const auth = await withAuth({ ensureSignedIn: true });
  const params = await searchParams;
  const callback = firstParam(params.callback);
  const state = firstParam(params.state);
  if (!callback || !state || !isLocalCallback(callback)) {
    return (
      <StatusPage
        title="broods login failed"
        description="This login link is incomplete. Run broods login again."
        error={true}
      >
        <Button
          nativeButton={false}
          render={<Link href="/" />}
          className="cursor-pointer"
        >
          Open dashboard
        </Button>
      </StatusPage>
    );
  }

  const target = new URL(callback);
  target.searchParams.set("state", state);
  try {
    const code = await mintLoginCode(
      auth.accessToken,
      firstParam(params.code_challenge),
    );
    target.searchParams.set("code", code);
    // BROODS_BASE_URL advertises the unified public domain (the gateway,
    // which proxies /v1/account/* to Convex); without it we point the CLI at
    // the Convex deployment directly.
    target.searchParams.set("base_url", advertisedBaseUrl());
  } catch (error) {
    console.error("[cli-auth] broods login failed", error);
    target.searchParams.delete("code");
    target.searchParams.set("error", toErrorMessage(error));
  }

  redirect(target.toString());
}

/** Public base URL the CLI should call for the /v1/account/* control-plane routes. */
function advertisedBaseUrl(): string {
  const explicit = process.env.BROODS_BASE_URL;
  if (explicit) {
    return new URL(explicit).origin;
  }
  // Self-hosted Convex has no derivable HTTP-actions host; it must be provided.
  const siteUrl = process.env.CONVEX_SITE_URL;
  if (siteUrl) {
    return new URL(siteUrl).origin;
  }
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl)
    throw new Error("login base URL is not configured; set BROODS_BASE_URL");

  return new URL(convexUrl.replace(".convex.cloud", ".convex.site")).origin;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isLocalCallback(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

/**
 * Bootstraps the caller's org the way the dashboard home does, provisions its
 * API account on a first login, then mints the one-time code. A CLI signup
 * never sees the provisioned account secret; it can be rotated under
 * Organization > API Access.
 */
async function mintLoginCode(
  accessToken: string,
  codeChallenge: string | undefined,
): Promise<string> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) throw new Error("The login backend is not configured.");

  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(accessToken);
  // A login right after signup can beat the WorkOS webhook that creates the
  // user row; sync it before bootstrapping.
  await client.action(api.user.ensureSynced, {});
  const org = await client.mutation(api.org.orgs.getOrCreate, {});
  if (org.needsProvision) {
    try {
      await client.action(api.org.lifecycle.provision, { orgId: org.orgId });
    } catch (error) {
      // Another tab may have provisioned first; only a still-missing account
      // is a failure.
      if ((await client.mutation(api.org.orgs.getOrCreate, {})).needsProvision)
        throw error;
    }
  }
  const { code } = await client.mutation(
    api.cli.auth.createLoginCode,
    codeChallenge ? { codeChallenge: codeChallenge } : {},
  );

  return code;
}
