import {
  MODEL_KEY_HINT,
  assertStep,
  persistentSandboxKeepsFile,
  type VerifyContext,
} from "../harness.ts";

/**
 * The cloudflare provider through the config plane: on/off networking only and
 * no workspace. With CLOUDFLARE_SANDBOX_URL on core (a deployed bridge, or
 * `wrangler dev` in apps/cloudflare-sandbox) and a model key, an agent writes a
 * file in one turn and reads it back in the next, so the warm Container is the
 * same one across calls.
 */
export async function cloudflareSandbox(context: VerifyContext): Promise<void> {
  const key = `cloudflare-${context.runId}`;
  const refused = await context.account
    .createSandbox({
      name: `${key}-restricted`,
      config: {
        provider: "cloudflare",
        network: { mode: "restricted", allowDomains: ["pypi.org"] },
      },
    })
    .then(
      (): string => "created",
      (error: unknown): string => String(error),
    );
  assertStep(
    "a cloudflare sandbox refuses restricted egress",
    refused.includes("deny-all or allow-all"),
    refused,
  );
  const sandbox = await context.account.createSandbox({
    name: key,
    config: {
      provider: "cloudflare",
      persistent: true,
      permissionMode: "bypass",
      network: { mode: "deny-all" },
    },
  });
  assertStep(
    "a persistent cloudflare sandbox is stored",
    sandbox.config.provider === "cloudflare" &&
      sandbox.config.persistent === true,
    JSON.stringify(sandbox),
  );

  if (!process.env.CLOUDFLARE_SANDBOX_URL || !context.hasModelKey) {
    console.log(
      `  skip agent on a cloudflare container (set CLOUDFLARE_SANDBOX_URL and ${MODEL_KEY_HINT})`,
    );
    return;
  }
  await persistentSandboxKeepsFile(context, {
    key: key,
    label: "cloudflare",
    path: "/tmp/marker",
    sandboxId: sandbox.sandboxId,
  });
}
