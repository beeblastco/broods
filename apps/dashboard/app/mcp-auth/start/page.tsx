// MCP sign-in's browser step: WorkOS sends an MCP client's sign-in here (its Login URI), and
// the org picked here goes into the client's token, so dashboard switching never moves it.

import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import { connectMcpClient } from "@/app/mcp-auth/start/actions";
import {
  failureOf,
  MCP_SIGN_IN_PATH,
  type McpSignInOrg,
} from "@/app/lib/mcpSignIn";
import { selfHosted } from "@/app/lib/selfHostSession";
import { firstParam, syncedCaller } from "@/app/lib/serverPage";
import { api } from "@broods/convex/_generated/api";
import type { OrgRole } from "@broods/convex/model/ownership/org";
import { withAuth } from "@workos-inc/authkit-nextjs";
import Link from "next/link";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function McpAuthStartPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const externalAuthId = firstParam(params.external_auth_id);
  const failed = failureOf(firstParam(params.failed));
  if (selfHosted) {
    return (
      <Failure
        title="MCP sign-in is off"
        description="This dashboard signs in with keys. Connect an MCP client with an account key instead."
      />
    );
  }
  if (firstParam(params.cancelled)) {
    return (
      <StatusPage
        label="mcp"
        title="Connection cancelled"
        description="Your MCP client is not connected. You can close this tab."
      >
        {null}
      </StatusPage>
    );
  }
  if (failed === "not-admin") return <NotAdmin />;
  if (failed && failed !== "expired") {
    return (
      <Failure
        title="Sign-in failed"
        description={
          <>
            Ref <code className="font-mono">{failed}</code>
          </>
        }
      />
    );
  }
  if (!externalAuthId || failed) {
    return (
      <Failure
        title="This sign-in link expired"
        description="Start the connection again from your MCP client, for example with /mcp in Claude Code."
      />
    );
  }

  const { accessToken } = await withAuth({ ensureSignedIn: true });
  const client = await syncedCaller(accessToken);
  // A first sign-in creates the user's own org, as the dashboard and `broods login` do.
  await client.mutation(api.org.orgs.getOrCreate, {});
  const orgs = await client.query(api.cli.auth.mcpSignInOrgs, {});
  if (orgs.length === 0) return <NotAdmin />;

  return (
    <StatusPage
      label="mcp"
      title="Connect an MCP client"
      description="Pick the organization it works in. It stays there until you connect again."
    >
      <OrgPicker externalAuthId={externalAuthId} orgs={orgs} />
    </StatusPage>
  );
}

function Failure({
  description,
  title,
}: {
  description: React.ReactNode;
  title: string;
}): React.JSX.Element {
  return (
    <StatusPage title={title} description={description} error={true}>
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

function NotAdmin(): React.JSX.Element {
  return (
    <Failure
      title="Can't connect yet"
      description="Connecting an MCP client needs the owner or admin role in an organization. Ask an owner to make you an admin, or create your own organization."
    />
  );
}

function OrgPicker({
  externalAuthId,
  orgs,
}: {
  externalAuthId: string;
  orgs: (McpSignInOrg & { role: OrgRole; selected: boolean })[];
}): React.JSX.Element {
  return (
    <form action={connectMcpClient} className="flex w-72 flex-col gap-3">
      <input type="hidden" name="external_auth_id" value={externalAuthId} />
      <fieldset className="flex max-h-52 flex-col overflow-y-auto rounded-md border text-left">
        <legend className="sr-only">Organization</legend>
        {orgs.map((org, index) => (
          <label
            key={org.slug}
            className="flex cursor-pointer items-center gap-3 border-t px-3 py-2 first:border-t-0 has-checked:bg-muted"
          >
            <input
              type="radio"
              name="org"
              value={org.slug}
              defaultChecked={index === 0}
              required={true}
              className="cursor-pointer accent-primary"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-foreground">
                {org.name}
              </span>
              <span className="font-mono text-2xs text-muted-foreground">
                {org.slug}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              {roleLabel(org.role)}
              {org.selected ? " · selected now" : ""}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex justify-center gap-2">
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href={`${MCP_SIGN_IN_PATH}?cancelled=1`} />}
          className="cursor-pointer"
        >
          Cancel
        </Button>
        <Button type="submit" className="cursor-pointer">
          Connect
        </Button>
      </div>
    </form>
  );
}

function roleLabel(role: OrgRole): string {
  return role === "owner" ? "Owner" : "Admin";
}
