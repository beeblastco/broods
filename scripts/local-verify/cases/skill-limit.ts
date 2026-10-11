import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * Core reads every skill an agent lists on every turn, so the config plane
 * refuses more than 32 distinct skills before it looks any of them up. The
 * stack has no skill store, so dropping repeats is left to the Convex tests.
 */
export async function skillLimit(context: VerifyContext): Promise<void> {
  const response = await context.measure("agent with 33 skills", () =>
    fetch(`${context.edgeUrl}/v1/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${context.accountSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `skill-limit-${context.runId}`,
        config: {
          ...context.model,
          skills: {
            enabled: true,
            allowed: Array.from({ length: 33 }, (_, index) => `skill-${index}`),
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    }),
  );
  const body = await response.text();
  assertStep(
    "an agent listing 33 distinct skills is refused",
    response.status === 400 && body.includes("at most 32 skills"),
    `${response.status} ${body.slice(0, 300)}`,
  );
}
