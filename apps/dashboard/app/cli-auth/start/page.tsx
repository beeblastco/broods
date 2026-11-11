// `broods login`'s browser step. Once the callback is known, a failure goes back to it as
// `error`, so the CLI stops waiting at once.

import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import { toErrorMessage } from "@/app/lib/errors";
import { firstParam, signedInAccessToken } from "@/app/lib/serverPage";
import { api } from "@broods/convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";
import Link from "next/link";
import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function CliAuthStartPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<React.JSX.Element> {
  const accessToken = await signedInAccessToken();
  const params = await searchParams;
  const callback = firstParam(params.callback);
  const state = firstParam(params.state);
  const codeChallenge = firstParam(params.code_challenge);
  if (!callback || !state || !codeChallenge || !isLocalCallback(callback)) {
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
    const code = await mintLoginCode(accessToken, codeChallenge);
    target.searchParams.set("code", code);
    target.searchParams.set("base_url", advertisedBaseUrl());
  } catch (error) {
    console.error("[cli-auth] broods login failed", error);
    target.searchParams.delete("code");
    target.searchParams.set("error", toErrorMessage(error));
  }

  redirect(target.toString());
}

// A Convex site serves only the config plane, so `broods run` and `logs` would 404 there.
function advertisedBaseUrl(): string {
  const explicit = process.env.BROODS_BASE_URL;
  if (!explicit) {
    throw new Error(
      "this dashboard has no BROODS_BASE_URL; set it to the public host in front of core",
    );
  }

  return new URL(explicit).origin;
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

async function mintLoginCode(
  accessToken: string,
  codeChallenge: string,
): Promise<string> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) throw new Error("The login backend is not configured.");

  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(accessToken);
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
  const { code } = await client.mutation(api.cli.auth.createLoginCode, {
    codeChallenge: codeChallenge,
  });

  return code;
}
