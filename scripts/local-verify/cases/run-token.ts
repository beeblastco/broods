import { assertStep, type VerifyContext } from "../harness.ts";

interface Answer {
  status: number;
  body: string;
}

/**
 * A run token (`fp_run_`) is a core credential for one agent run. The config
 * plane refuses the prefix outright, and core refuses one it did not sign.
 */
export async function runToken(context: VerifyContext): Promise<void> {
  const send = async (method: string, path: string): Promise<Answer> => {
    const response = await fetch(`${context.gatewayUrl}${path}`, {
      method: method,
      headers: {
        Authorization: "Bearer fp_run_e30.forged",
        "Content-Type": "application/json",
      },
      ...(method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(10_000),
    });

    return { status: response.status, body: await response.text() };
  };

  const config = await context.measure("run token on config plane", () =>
    send("GET", "/v1/agents"),
  );
  assertStep(
    "the config plane refuses a run token by its prefix",
    config.status === 401 &&
      config.body.includes("run tokens cannot reach the config plane"),
    `${config.status} ${config.body.slice(0, 200)}`,
  );

  const run = await send("POST", "/v1/runs");
  assertStep(
    "core refuses a run token it did not sign",
    run.status === 401,
    `${run.status} ${run.body.slice(0, 200)}`,
  );
}
