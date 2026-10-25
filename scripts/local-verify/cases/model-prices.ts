import {
  assertStep,
  convexResult,
  SELF_HOST_IDENTITY,
  type VerifyContext,
} from "../harness.ts";

const INLINE_PRICES = JSON.stringify({
  custom: { "GPT-OSS-120B": { input: 0.1, output: 0.5 } },
});

/**
 * Self-hosted model prices: the stack is `self-host`, so the crawl fetches no
 * catalogue, applies the org's `BROODS_MODEL_PRICES`, and the dashboard's
 * rate query reads them back. Unsetting the variable clears them again.
 */
export async function modelPrices(context: VerifyContext): Promise<void> {
  const ratesOf = (modelId: string): unknown =>
    convexResult(
      context,
      "logs:fetchModelRates",
      { models: [{ modelProvider: "custom", modelId: modelId }] },
      "the rate query answers the admin",
      SELF_HOST_IDENTITY,
    );
  const crawl = (step: string): void => {
    const cli = context.convex(["run", "modelPrices/crawl:run", "{}"]);
    assertStep(step, cli.ok, cli.output.slice(-300));
  };

  await context.measure("self-host model prices", async () => {
    const set = context.convex([
      "env",
      "set",
      "BROODS_MODEL_PRICES",
      INLINE_PRICES,
    ]);
    assertStep("the org's prices are set", set.ok, set.output.slice(-300));
    try {
      crawl("the crawl applies the org's prices without fetching");
      const rates = ratesOf("gpt-oss-120b");
      assertStep(
        "the org's rate comes back for its model",
        JSON.stringify(rates) ===
          JSON.stringify([
            {
              cacheRead: 0.1,
              cacheWrite: 0.1,
              input: 0.1,
              modelId: "gpt-oss-120b",
              modelProvider: "custom",
              output: 0.5,
            },
          ]),
        JSON.stringify(rates),
      );
    } finally {
      const removed = context.convex(["env", "remove", "BROODS_MODEL_PRICES"]);
      assertStep(
        "the org's prices are unset again",
        removed.ok,
        removed.output.slice(-300),
      );
    }
    crawl("the crawl runs with nothing configured");
    const cleared = ratesOf("gpt-oss-120b");
    assertStep(
      "unsetting the prices clears them",
      JSON.stringify(cleared) === "[]",
      JSON.stringify(cleared),
    );
  });
}
