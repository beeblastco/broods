import {
  assertStep,
  convexResult,
  SELF_HOST_IDENTITY,
  type VerifyContext,
} from "../harness.ts";

export async function scopedAccountKey(context: VerifyContext): Promise<void> {
  const asAdmin = (fn: string, args: Record<string, unknown>): unknown =>
    convexResult(
      context,
      fn,
      args,
      `${fn} answers the admin`,
      SELF_HOST_IDENTITY,
    );
  const status = async (
    method: string,
    path: string,
    bearer: string,
  ): Promise<number> => {
    const response = await fetch(`${context.edgeUrl}${path}`, {
      method: method,
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();

    return response.status;
  };

  asAdmin("user:ensureSynced", {});
  const previous = asAdmin("org/orgs:getActive", {}) as { _id: string } | null;
  const orgId = String(
    asAdmin("org/orgs:create", { name: `keys-${context.runId}` }),
  );
  try {
    asAdmin("org/orgs:setActive", { orgId: orgId });
    // It prints an audit log line after its result, so nothing is parsed.
    context.convex([
      "run",
      "--identity",
      SELF_HOST_IDENTITY,
      "org/lifecycle:provision",
      JSON.stringify({ orgId: orgId }),
    ]);
    const created = asAdmin("accountApiKeys:create", {
      orgId: orgId,
      name: "reader",
      actions: ["agents:read"],
      expiresAt: Date.now() + 60 * 60 * 1000,
    }) as { _id: string; token: string };
    assertStep(
      "a scoped key is minted with the bask_ prefix",
      created.token.startsWith("bask_"),
      created.token.slice(0, 5),
    );

    await context.measure("scoped key through the edge", async () => {
      const read = await status("GET", "/v1/agents", created.token);
      assertStep("the key reads what it may", read === 200, `status ${read}`);
      const crons = await status("GET", "/v1/crons", created.token);
      assertStep(
        "the config plane refuses what it may not",
        crons === 403,
        `status ${crons}`,
      );
      // A role is judged before the missing sandbox's 404, so 403 means core resolved a role.
      const lifecycle = await status(
        "POST",
        "/v1/sandboxes/sbx_missing/suspend",
        created.token,
      );
      assertStep(
        "core judges the key as a role",
        lifecycle === 403,
        `status ${lifecycle}`,
      );
    });

    asAdmin("accountApiKeys:update", {
      orgId: orgId,
      keyId: created._id,
      actions: ["agents:read", "crons:read"],
    });
    const widened = await status("GET", "/v1/crons", created.token);
    assertStep(
      "an inline access change applies to the next request",
      widened === 200,
      `status ${widened}`,
    );

    asAdmin("accountApiKeys:remove", { orgId: orgId, keyId: created._id });
    const revokedConfig = await status("GET", "/v1/agents", created.token);
    assertStep(
      "a revoked key is refused by the config plane",
      revokedConfig === 401,
      `status ${revokedConfig}`,
    );
    const revokedCore = await status(
      "POST",
      "/v1/sandboxes/sbx_missing/suspend",
      created.token,
    );
    assertStep(
      "a revoked key is refused by core",
      revokedCore === 401,
      `status ${revokedCore}`,
    );
  } finally {
    if (previous) asAdmin("org/orgs:setActive", { orgId: previous._id });
    asAdmin("org/orgs:remove", { orgId: orgId });
  }
}
