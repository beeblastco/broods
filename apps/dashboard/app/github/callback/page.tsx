/**
 * Where GitHub returns after installing the Broods App or signing in: trades
 * the code through Convex (which keeps the installations and, when asked,
 * creates and links the repo), then goes back to where the round trip began.
 * A failure renders here with a way back.
 */

import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import { toErrorMessage } from "@/app/lib/errors";
import { firstParam, signedInAccessToken } from "@/app/lib/serverPage";
import { api } from "@broods/convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";
import Link from "next/link";
import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function GitHubCallbackPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<React.JSX.Element> {
  const accessToken = await signedInAccessToken();
  const params = await searchParams;
  const code = firstParam(params.code);
  const state = firstParam(params.state);
  const installationId = Number(firstParam(params.installation_id));
  let target: string;
  try {
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!convexUrl) throw new Error("The backend is not configured.");
    if (!code || !state) {
      throw new Error("GitHub sent no sign-in code. Start again.");
    }
    const client = new ConvexHttpClient(convexUrl);
    client.setAuth(accessToken);
    const result = await client.action(api.github.finish, {
      code: code,
      state: state,
      installationId: Number.isInteger(installationId)
        ? installationId
        : undefined,
    });
    target = result.projectId
      ? `/${result.projectId}/settings?tab=git`
      : (result.returnTo ?? "/");
  } catch (error) {
    console.error("[github] callback failed", error);

    return (
      <StatusPage
        title="GitHub connection failed"
        description={toErrorMessage(error)}
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

  redirect(target);
}
