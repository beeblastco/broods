import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * The edge stamps every public request. It marks it as public, so core and the
 * config plane refuse the in-cluster service token arriving from outside, and
 * drops the `X-Account-Id` that token picks its account by. It also answers
 * CORS preflights for allowed origins only, and passes `X-Request-Id` through.
 */
export async function edgeHeaders(context: VerifyContext): Promise<void> {
  const { accountId } = await context.account.getAccount();
  const asService = async (baseUrl: string): Promise<number> => {
    const response = await fetch(`${baseUrl}/v1/account`, {
      headers: {
        Authorization: `Bearer ${context.serviceSecret}`,
        "X-Account-Id": accountId,
      },
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();

    return response.status;
  };

  // `/v1/account` then refuses the service token with a 400, which it only
  // reaches once the token has authenticated.
  const direct = await asService(context.configPlaneUrl);
  assertStep(
    "the service token authenticates in-cluster",
    direct === 400,
    `status ${direct}`,
  );
  const viaEdge = await context.measure("service token via edge", () =>
    asService(context.gatewayUrl),
  );
  assertStep(
    "the service token is refused through the edge",
    viaEdge === 401,
    `status ${viaEdge}`,
  );

  // The gateway used to stamp this; the config plane now issues its own.
  const unauthenticated = await fetch(`${context.gatewayUrl}/v1/account`, {
    headers: { "X-Request-Id": "verify-edge-1" },
    signal: AbortSignal.timeout(10_000),
  });
  await unauthenticated.body?.cancel();
  assertStep(
    "a config-plane answer keeps the caller's request id",
    unauthenticated.headers.get("x-request-id") === "verify-edge-1",
    String(unauthenticated.headers.get("x-request-id")),
  );

  const preflight = async (origin: string): Promise<string | null> => {
    const response = await fetch(`${context.gatewayUrl}/v1/agents`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();

    return response.ok
      ? response.headers.get("Access-Control-Allow-Origin")
      : `status ${response.status}`;
  };
  const allowed = await preflight("http://localhost:3000");
  assertStep(
    "a CORS preflight from an allowed origin is answered",
    allowed === "http://localhost:3000",
    String(allowed),
  );
  const refused = await preflight("https://evil.example");
  assertStep(
    "a CORS preflight from another origin gets no allow header",
    refused === null,
    String(refused),
  );
}
