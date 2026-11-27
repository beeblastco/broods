// `broods login`'s browser step: the terminal prints a code and waits, and the approval
// here is what it collects.

import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import { approveCliLogin } from "@/app/cli-auth/start/actions";
import { selfHosted } from "@/app/lib/selfHostSession";
import {
  firstParam,
  provisionedCaller,
  signedInAccessToken,
} from "@/app/lib/serverPage";
import { api } from "@broods/convex/_generated/api";
import { withAuth } from "@workos-inc/authkit-nextjs";
import Link from "next/link";

// A host name only: the link picks this text, and it sits beside the approve button.
const DEVICE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const LOGIN_CODE_PATTERN = /^[A-Z]{4}-[A-Z]{4}$/;
const OUTCOMES = {
  approved: {
    title: "Approved",
    description: "Return to your terminal. You can close this tab.",
  },
  cancelled: {
    title: "Sign-in cancelled",
    description:
      "The broods CLI is not signed in. Press Ctrl-C in the terminal, then close this tab.",
  },
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function CliAuthStartPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<React.JSX.Element> {
  const accessToken = await signedInAccessToken();
  const params = await searchParams;
  const codeChallenge = firstParam(params.code_challenge);
  const code = firstParam(params.code);
  const outcome = firstParam(params.outcome);
  if (outcome === "approved" || outcome === "cancelled") {
    return (
      <StatusPage
        label="broods login"
        title={OUTCOMES[outcome].title}
        description={OUTCOMES[outcome].description}
      >
        {null}
      </StatusPage>
    );
  }
  if (outcome) {
    return (
      <Failure description="The sign-in could not be approved. Press Ctrl-C in the terminal, then run broods login again." />
    );
  }
  if (firstParam(params.callback)) {
    return (
      <Failure description="This link is from an older broods CLI. Update it with npm i -g broods@latest, then run broods login again." />
    );
  }
  if (!codeChallenge || !code || !LOGIN_CODE_PATTERN.test(code)) {
    return (
      <Failure description="This login link is incomplete. Run broods login again." />
    );
  }

  const client = await provisionedCaller(accessToken);
  const org = (await client.query(api.cli.auth.mcpSignInOrgs, {})).find(
    ({ selected }) => selected,
  );
  if (!org) {
    return (
      <Failure description="Signing in the CLI needs the owner or admin role in your current organization. Press Ctrl-C in the terminal, switch organizations in the dashboard, then run broods login again." />
    );
  }
  if (!org.provisioned) {
    return (
      <Failure
        description={`${org.name} has no active API account. Press Ctrl-C in the terminal, set it up under Organization > API Access, then run broods login again.`}
      />
    );
  }
  const email = selfHosted ? undefined : (await withAuth()).user?.email;
  const named = firstParam(params.device);
  const device = named && DEVICE_PATTERN.test(named) ? named : undefined;

  return (
    <StatusPage label="broods login" title="Sign in the broods CLI?">
      <form
        action={approveCliLogin}
        className="flex flex-col items-center gap-2"
      >
        <input type="hidden" name="code_challenge" value={codeChallenge} />
        <input type="hidden" name="org" value={org.slug} />
        <p className="font-mono text-2xl tracking-widest text-foreground">
          {code}
        </p>
        <p className="max-w-60 text-sm text-muted-foreground">
          Approve only if your terminal shows this code.
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          {[device, email, org.name].filter(Boolean).join(" · ")}
        </p>
        <div className="flex justify-center gap-2 pt-2">
          <Button type="submit" className="cursor-pointer">
            Approve
          </Button>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/cli-auth/start?outcome=cancelled" />}
            className="cursor-pointer"
          >
            Cancel
          </Button>
        </div>
      </form>
    </StatusPage>
  );
}

function Failure({ description }: { description: string }): React.JSX.Element {
  return (
    <StatusPage
      title="broods login failed"
      description={description}
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
