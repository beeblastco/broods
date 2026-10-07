import type { AccountSandbox } from "../../../packages/broods/src/account.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * A lambda sandbox can name a platform image variant, and the config plane
 * refuses one anywhere it could not boot. Config only, so it needs no model key
 * and no MicroVM.
 */
export async function sandboxImage(context: VerifyContext): Promise<void> {
  const key = `sandbox-image-${context.runId}`;
  const stored = await context.measure(
    "create obscura sandbox",
    (): Promise<AccountSandbox> =>
      context.account.createSandbox({
        name: key,
        config: {
          provider: "lambda",
          image: "obscura",
          network: { mode: "allow-all" },
        },
      }),
  );
  assertStep(
    "a lambda sandbox keeps image: obscura",
    stored.config.image === "obscura",
    JSON.stringify(stored),
  );

  const refused = await context.account
    .createSandbox({
      name: `${key}-workdir`,
      config: { provider: "sandbox", image: "obscura" },
    })
    .then(
      (): string => "created",
      (error: unknown): string => String(error),
    );
  assertStep(
    "an image variant on a non-lambda sandbox is refused",
    refused.includes("config.image applies to the lambda provider only"),
    refused,
  );
}
