import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * Every Broods credential is routed by its `b` prefix. Through the edge, the
 * account key authenticates on both planes, and the same key under the old
 * `ask_` prefix, or any other unbranded bearer, gets 401 on both.
 */
export async function credentialPrefixes(
  context: VerifyContext,
): Promise<void> {
  const status = async (
    method: string,
    path: string,
    bearer: string,
  ): Promise<number> => {
    const response = await fetch(`${context.edgeUrl}${path}`, {
      method: method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      ...(method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();

    return response.status;
  };

  assertStep(
    "the account key is minted with the bask_ prefix",
    context.accountSecret.startsWith("bask_"),
    context.accountSecret.slice(0, 5),
  );
  const config = await context.measure("bask_ key on the config plane", () =>
    status("GET", "/v1/agents", context.accountSecret),
  );
  assertStep("a bask_ key reads agents", config === 200, `status ${config}`);
  // An empty run body fails validation, which core reaches only past auth.
  const core = await status("POST", "/v1/runs", context.accountSecret);
  assertStep("a bask_ key passes core auth", core === 400, `status ${core}`);

  const body = context.accountSecret.slice("bask_".length);
  for (const prefix of ["ask_", "sk_", "fp_sts_", ""]) {
    const bearer = `${prefix}${body}`;
    const label = prefix ? `an ${prefix} key` : "an unprefixed key";
    const oldConfig = await status("GET", "/v1/agents", bearer);
    assertStep(
      `${label} is refused by the config plane`,
      oldConfig === 401,
      `status ${oldConfig}`,
    );
    const oldCore = await status("POST", "/v1/runs", bearer);
    assertStep(
      `${label} is refused by core`,
      oldCore === 401,
      `status ${oldCore}`,
    );
  }
}
