"use server";

import { provisionedCaller, signedInAccessToken } from "@/app/lib/serverPage";
import { api } from "@broods/convex/_generated/api";
import { redirect } from "next/navigation";

/** The approve button's submit: records the approval the waiting CLI polls for. */
export async function approveCliLogin(form: FormData): Promise<void> {
  const codeChallenge = form.get("code_challenge");
  const accessToken = await signedInAccessToken();
  let outcome = "approved";
  try {
    if (typeof codeChallenge !== "string") throw new Error("no code_challenge");
    const client = await provisionedCaller(accessToken);
    await client.mutation(api.cli.auth.createLoginCode, {
      codeChallenge: codeChallenge,
      approved: true,
    });
  } catch (error) {
    console.error("[cli-auth] broods login approval failed", error);
    outcome = "failed";
  }

  redirect(`/cli-auth/start?${outcome}=1`);
}
