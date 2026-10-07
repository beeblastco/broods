import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  runToTerminal,
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
  const { agentId } = await context.account.createAgent({
    name: key,
    config: {
      ...context.model,
      instructions:
        "Use the bash tool to run exactly the command the user gives, then reply with exactly its output and nothing else.",
      sandboxes: [sandbox.sandboxId],
    },
  });
  const turn = (text: string, step: string): Promise<AsyncStatus> =>
    context.measure(step, (): Promise<AsyncStatus> =>
      runToTerminal(context, {
        agentId: agentId,
        conversationKey: key,
        eventId: `${key}-${step}`,
        text: text,
      }),
    );
  const marker = `cf-${context.runId}`;
  const wrote = await turn(
    `Run: echo ${marker} > /tmp/marker && cat /tmp/marker`,
    "cloudflare write",
  );
  const read = await turn("Run: cat /tmp/marker", "cloudflare read");
  assertStep(
    "a warm cloudflare container keeps a file between turns",
    wrote.status === "completed" &&
      read.status === "completed" &&
      JSON.stringify(read.response ?? "").includes(marker),
    `${JSON.stringify(wrote)}\n${JSON.stringify(read)}`,
  );
}
