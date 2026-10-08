import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * Every provider that boots a prebuilt image picks it with the top-level
 * `snapshot`, and the provider options that used to pick it are refused.
 * Config only, so it needs no model key and no provider account.
 */
export async function providerSnapshot(context: VerifyContext): Promise<void> {
  const key = `provider-snapshot-${context.runId}`;
  const stored = await context.account.createSandbox({
    name: key,
    config: {
      provider: "e2b",
      snapshot: "runtime-template",
      network: { mode: "allow-all" },
    },
  });
  assertStep(
    "an e2b sandbox keeps its template in snapshot",
    stored.config.snapshot === "runtime-template",
    JSON.stringify(stored),
  );

  const refused = await context.account
    .createSandbox({
      name: `${key}-template`,
      config: {
        provider: "e2b",
        network: { mode: "allow-all" },
        options: { template: "runtime-template" },
      },
    })
    .then(
      (): string => "created",
      (error: unknown): string => String(error),
    );
  assertStep(
    "options.template is refused in favor of snapshot",
    refused.includes("config.options.template is not supported"),
    refused,
  );
}
