"use server";

import {
  completeMcpSignIn,
  failurePath,
  loggedFailure,
} from "@/app/lib/mcpSignIn";
import { provisionOrg, syncedCaller } from "@/app/lib/serverPage";
import { api } from "@broods/convex/_generated/api";
import { withAuth } from "@workos-inc/authkit-nextjs";
import type { FunctionReturnType } from "convex/server";
import { redirect } from "next/navigation";

type McpSignInOrgs = FunctionReturnType<typeof api.cli.auth.mcpSignInOrgs>;

/** The org picker's submit: the user comes from the session and the org is checked again. */
export async function connectMcpClient(form: FormData): Promise<void> {
  const externalAuthId = form.get("external_auth_id");
  const slug = form.get("org");
  if (typeof externalAuthId !== "string" || typeof slug !== "string") {
    redirect(failurePath("expired"));
  }
  const { accessToken, user } = await withAuth({ ensureSignedIn: true });
  const client = await syncedCaller(accessToken);
  const picked = async (): Promise<McpSignInOrgs[number] | undefined> =>
    (await client.query(api.cli.auth.mcpSignInOrgs, {})).find(
      (org) => org.slug === slug,
    );
  const org = await picked();
  if (!org) redirect(failurePath("not-admin"));
  if (!org.provisioned) {
    try {
      await provisionOrg(
        client,
        org.orgId,
        async () => !(await picked())?.provisioned,
      );
    } catch (error) {
      redirect(loggedFailure(error));
    }
  }

  redirect(await completeMcpSignIn(user, externalAuthId, org));
}
