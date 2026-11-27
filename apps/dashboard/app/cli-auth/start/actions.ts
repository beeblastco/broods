"use server";

import { convexCaller, signedInAccessToken } from "@/app/lib/serverPage";
import { api } from "@broods/convex/_generated/api";
import { redirect } from "next/navigation";

const FAILED = "/cli-auth/start?outcome=failed";

/** The approve button's submit: records the approval the waiting CLI polls for. */
export async function approveCliLogin(form: FormData): Promise<void> {
  const codeChallenge = form.get("code_challenge");
  if (typeof codeChallenge !== "string") redirect(FAILED);
  const accessToken = await signedInAccessToken();
  try {
    // The page provisioned the caller; the mutation re-checks user, org, role and account.
    await convexCaller(accessToken).mutation(api.cli.auth.createLoginCode, {
      codeChallenge: codeChallenge,
      approved: true,
    });
  } catch (error) {
    console.error("[cli-auth] broods login approval failed", error);
    redirect(FAILED);
  }

  redirect("/cli-auth/start?outcome=approved");
}
