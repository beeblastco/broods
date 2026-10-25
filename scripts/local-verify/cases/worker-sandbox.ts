import type { SandboxConfig } from "../../../packages/broods/src/contracts.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  persistentSandboxKeepsFile,
  type VerifyContext,
} from "../harness.ts";

/**
 * The worker provider through the config plane: on/off networking, a 60 s
 * timeout and no workspace. With CLOUDFLARE_WORKER_URL on core (a deployed
 * Worker, or `wrangler dev` in apps/cloudflare-worker) and a model key, an
 * agent writes a file in one turn and reads it back in the next, so the
 * stored files are the same across calls.
 */
export async function workerSandbox(context: VerifyContext): Promise<void> {
  const key = `worker-${context.runId}`;
  const refused: SandboxConfig[] = [
    {
      provider: "worker",
      network: { mode: "restricted", allowDomains: ["pypi.org"] },
    },
    { provider: "worker", timeout: 120 },
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
    "a worker sandbox refuses restricted egress and a long timeout",
    refusals[0]!.includes("deny-all or allow-all") &&
      refusals[1]!.includes("config.timeout"),
    refusals.join("\n"),
  );
  const sandbox = await context.account.createSandbox({
    name: key,
    config: {
      provider: "worker",
      persistent: true,
      permissionMode: "bypass",
      network: { mode: "deny-all" },
    },
  });
  assertStep(
    "a persistent worker sandbox is stored",
    sandbox.config.provider === "worker" && sandbox.config.persistent === true,
    JSON.stringify(sandbox),
  );

  if (!process.env.CLOUDFLARE_WORKER_URL || !context.hasModelKey) {
    console.log(
      `  skip agent on a V8 Worker (set CLOUDFLARE_WORKER_URL and ${MODEL_KEY_HINT})`,
    );
    return;
  }
  await persistentSandboxKeepsFile(context, {
    key: key,
    label: "worker",
    path: "/workspace/marker",
    sandboxId: sandbox.sandboxId,
  });
}
