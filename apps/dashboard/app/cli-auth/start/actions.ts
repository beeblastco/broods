"use server";

import { convexCaller, signedInAccessToken } from "@/app/lib/serverPage";
import { api } from "@broods/convex/_generated/api";
import { redirect } from "next/navigation";

const FAILED = "/cli-auth/start?outcome=failed";

/** The approve button's submit: records the approval the waiting CLI polls for. */
export async function approveCliLogin(form: FormData): Promise<void> {
  const codeChallenge = form.get("code_challenge");
  const slug = form.get("org");
  if (typeof codeChallenge !== "string" || typeof slug !== "string") {
    redirect(FAILED);
  }
  const client = convexCaller(await signedInAccessToken());
  try {
    // The org the page showed, not whichever one another tab made active since.
    const org = (await client.query(api.cli.auth.mcpSignInOrgs, {})).find(
      (candidate) => candidate.slug === slug,
    );
    if (!org) throw new Error(`no admin role in ${slug}`);
    await client.mutation(api.cli.auth.createLoginCode, {
      codeChallenge: codeChallenge,
      approved: true,
      orgId: org.orgId,
    });
  } catch (error) {
    console.error("[cli-auth] broods login approval failed", error);
    redirect(FAILED);
  }

  redirect("/cli-auth/start?outcome=approved");
}
