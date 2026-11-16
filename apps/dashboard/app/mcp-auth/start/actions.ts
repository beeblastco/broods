"use server";

import { completeMcpSignIn, failedPath } from "@/app/lib/mcpSignIn";
import { convexCaller } from "@/app/lib/serverPage";
import { api } from "@broods/convex/_generated/api";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

/** The org picker's submit: the user comes from the session and the org is checked again. */
export async function connectMcpClient(form: FormData): Promise<void> {
  const externalAuthId = form.get("external_auth_id");
  const slug = form.get("org");
  if (typeof externalAuthId !== "string" || typeof slug !== "string") {
    redirect(failedPath("expired"));
  }
  const { accessToken, user } = await withAuth({ ensureSignedIn: true });
  const orgs = await convexCaller(accessToken).query(
    api.cli.auth.mcpSignInOrgs,
    {},
  );
  const org = orgs.find((candidate) => candidate.slug === slug);
  if (!org) redirect(failedPath("not-admin"));

  redirect(await completeMcpSignIn(user, externalAuthId, org));
}
