import type { SandboxConfig } from "../../../packages/broods/src/contracts.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  persistentSandboxKeepsFile,
  type VerifyContext,
} from "../harness.ts";

/**
 * The isolate provider through the config plane: on/off networking, a 60 s
 * timeout and no workspace. With CLOUDFLARE_ISOLATE_URL on core (a deployed
 * Worker, or `wrangler dev` in apps/cloudflare-isolate) and a model key, an
 * agent writes a file in one turn and reads it back in the next, so the
 * stored files are the same across calls.
 */
export async function isolateSandbox(context: VerifyContext): Promise<void> {
  const key = `isolate-${context.runId}`;
  const refused: SandboxConfig[] = [
    {
      provider: "isolate",
      network: { mode: "restricted", allowDomains: ["pypi.org"] },
    },
    { provider: "isolate", timeout: 120 },
  ];
  const refusals = await Promise.all(
    refused.map((config, index): Promise<string> =>
      context.account
        .createSandbox({ name: `${key}-refused-${index}`, config: config })
        .then(
          (): string => "created",
          (error: unknown): string => String(error),
        ),
    ),
  );
  assertStep(
    "an isolate sandbox refuses restricted egress and a long timeout",
    refusals[0]!.includes("deny-all or allow-all") &&
      refusals[1]!.includes("config.timeout"),
    refusals.join("\n"),
  );
  const sandbox = await context.account.createSandbox({
    name: key,
    config: {
      provider: "isolate",
      persistent: true,
      permissionMode: "bypass",
      network: { mode: "deny-all" },
    },
  });
  assertStep(
    "a persistent isolate sandbox is stored",
    sandbox.config.provider === "isolate" && sandbox.config.persistent === true,
    JSON.stringify(sandbox),
  );

  if (!process.env.CLOUDFLARE_ISOLATE_URL || !context.hasModelKey) {
    console.log(
      `  skip agent on an isolate (set CLOUDFLARE_ISOLATE_URL and ${MODEL_KEY_HINT})`,
    );
    return;
  }
  await persistentSandboxKeepsFile(context, {
    key: key,
    label: "isolate",
    path: "/workspace/marker",
    sandboxId: sandbox.sandboxId,
  });
}
