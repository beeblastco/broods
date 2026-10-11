import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * The config plane counts failed logins by source, never by token: a caller
 * that sends a new invalid bearer each time is still blocked within 20 tries,
 * and a valid key keeps working from that source. It talks to the Convex site
 * directly with a forwarded address of its own, so the edge's address, which
 * other cases fail logins from, never gets blocked. Runs last for the same
 * reason.
 */
export async function authFailures(context: VerifyContext): Promise<void> {
  const source = `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
  const status = async (bearer: string): Promise<number> => {
    const response = await fetch(`${context.configPlaneUrl}/v1/agents`, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        "X-Forwarded-For": source,
      },
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();

    return response.status;
  };

  const statuses: number[] = [];
  await context.measure("rotate invalid tokens from one source", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const answer = await status(`bask_invalid${attempt}${context.runId}`);
      statuses.push(answer);
      if (answer === 429) break;
    }
  });
  assertStep(
    "rotating invalid tokens from one source is blocked within 20 tries",
    statuses.at(-1) === 429 && statuses.slice(0, -1).every((s) => s === 401),
    statuses.join(","),
  );
  const valid = await status(context.accountSecret);
  assertStep(
    "a valid key still works from the blocked source",
    valid === 200,
    `status ${valid}`,
  );
}
