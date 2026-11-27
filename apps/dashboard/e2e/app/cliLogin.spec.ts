import { expect, test, type APIResponse } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { hasProbe, MISSING_PROBE } from "../lib/session";

test.skip(!hasProbe(), MISSING_PROBE);

// @rollout: the poll and the approval flag are Convex functions only the merge deploys.
test("approving broods login hands the waiting CLI its login @rollout", async ({
  page,
  request,
}) => {
  const verifier = randomBytes(32).toString("base64url");
  const config = await request.get("/cli-auth/config");
  const { base_url: baseUrl } = (await config.json()) as { base_url: string };
  const poll = async (): Promise<APIResponse> =>
    await request.post(`${baseUrl}/v1/account/auth/exchange`, {
      data: { code_verifier: verifier },
    });
  expect((await poll()).status()).toBe(202);

  await page.goto(
    `/cli-auth/start?${new URLSearchParams({
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code: "BCDF-GHJK",
      device: "e2e",
    })}`,
  );
  await expect(page.getByText("BCDF-GHJK")).toBeVisible();
  expect((await poll()).status(), "opening the link approves nothing").toBe(
    202,
  );
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("heading", { name: "Approved" })).toBeVisible();

  const collected = await poll();
  expect(collected.status()).toBe(200);
  const { token } = (await collected.json()) as { token: string };
  const revoked = await request.delete(`${baseUrl}/v1/account/auth/token`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(revoked.status()).toBe(204);
});
