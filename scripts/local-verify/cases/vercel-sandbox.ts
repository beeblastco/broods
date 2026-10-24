import {
  MODEL_KEY_HINT,
  assertStep,
  persistentSandboxKeepsFile,
  type VerifyContext,
} from "../harness.ts";

const VERCEL_ENV = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"];

/**
 * The vercel provider through the config plane: an idle window past Vercel's
 * 24 hour session cap is refused. With VERCEL_TOKEN, VERCEL_TEAM_ID and
 * VERCEL_PROJECT_ID on core and a model key, an agent writes a file in one turn
 * and reads it back in the next on the same reserved Vercel sandbox.
 */
export async function vercelSandbox(context: VerifyContext): Promise<void> {
  const key = `vercel-${context.runId}`;
  const refused = await context.account
    .createSandbox({
      name: `${key}-idle`,
      config: {
        provider: "vercel",
        persistent: true,
        lifecycle: { idleTimeoutSeconds: 24 * 60 * 60 + 1 },
      },
    })
    .then(
      (): string => "created",
      (error: unknown): string => String(error),
    );
  assertStep(
    "a vercel idle window past 24 hours is refused",
    refused.includes("must be at most 86400 on the vercel provider"),
    refused,
  );

  const missing = VERCEL_ENV.filter((name): boolean => !process.env[name]);
  if (missing.length > 0 || !context.hasModelKey) {
    console.log(
      `  skip agents on vercel sandboxes (set ${VERCEL_ENV.join(", ")} and ${MODEL_KEY_HINT})`,
    );
    return;
  }
  const sandbox = await context.account.createSandbox({
    name: key,
    config: {
      provider: "vercel",
      persistent: true,
      permissionMode: "bypass",
      network: { mode: "deny-all" },
      lifecycle: { idleTimeoutSeconds: 600 },
    },
  });
  await persistentSandboxKeepsFile(context, {
    key: key,
    label: "vercel",
    path: "/tmp/marker",
    sandboxId: sandbox.sandboxId,
  });
}
