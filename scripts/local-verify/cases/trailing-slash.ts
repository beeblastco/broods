import { assertStep, probeHttp, type VerifyContext } from "../harness.ts";

interface Answer {
  status: number;
  body: string;
}

/**
 * A trailing slash never moves a request to the other plane: the gateway strips
 * it before routing and before the upstream call, so config, health and the
 * internal-path deny answer the same with or without it.
 */
export async function trailingSlash(context: VerifyContext): Promise<void> {
  const send = async (method: string, path: string): Promise<Answer> => {
    const response = await fetch(`${context.gatewayUrl}${path}`, {
      method: method,
      headers: { Authorization: `Bearer ${context.accountSecret}` },
      signal: AbortSignal.timeout(10_000),
    });

    return { status: response.status, body: await response.text() };
  };

  const bare = await send("GET", "/v1/agents");
  const slashed = await context.measure("trailing slash", (): Promise<Answer> =>
    send("GET", "/v1/agents/"),
  );
  assertStep(
    "a config path with a trailing slash answers like the bare one",
    bare.status === 200 && slashed.status === 200 && slashed.body === bare.body,
    `${bare.status} ${detail(slashed)}`,
  );

  const health = await probeHttp(`${context.gatewayUrl}/healthz/`);
  assertStep("/healthz/ is the health check", health === 200, String(health));

  const internal = await send("POST", "/v1/cron-runs//");
  assertStep(
    "an internal core path stays a 404 with trailing slashes",
    internal.status === 404,
    detail(internal),
  );
}

/** A failed step's detail: the status and the start of the body. */
function detail(answer: Answer): string {
  return `${answer.status} ${answer.body.slice(0, 200)}`;
}
