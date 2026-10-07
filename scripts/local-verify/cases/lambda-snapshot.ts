import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * A lambda sandbox can pin a snapshot and still name the image it was built
 * from, which keeps browse working on a snapshot of an Obscura sandbox. Config
 * only, so it needs no model key and no MicroVM.
 */
export async function lambdaSnapshot(context: VerifyContext): Promise<void> {
  const key = `lambda-snapshot-${context.runId}`;
  const snapshot =
    "arn:aws:lambda:eu-west-1:000000000000:microvm-image:broods-snapshot-verify";
  const stored = await context.account.createSandbox({
    name: key,
    config: {
      provider: "lambda",
      image: "obscura",
      snapshot: snapshot,
      network: { mode: "allow-all" },
    },
  });
  assertStep(
    "a lambda sandbox keeps a snapshot and the image it was built from",
    stored.config.image === "obscura" && stored.config.snapshot === snapshot,
    JSON.stringify(stored),
  );
}
