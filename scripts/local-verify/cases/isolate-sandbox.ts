import type { SandboxConfig } from "../../../packages/broods/src/contracts.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

/**
 * The isolate provider through the config plane: on/off networking, no size,
 * a 60 s timeout and no workspace. With CLOUDFLARE_ISOLATE_URL on core (a
 * deployed Worker, or `wrangler dev` in apps/cloudflare-isolate) and a model
 * key, an agent writes a file in one turn and reads it back in the next, so
 * the stored files are the same across calls.
 */
export async function isolateSandbox(context: VerifyContext): Promise<void> {
  const key = `isolate-${context.runId}`;
  const refused: SandboxConfig[] = [
    {
      provider: "isolate",
      network: { mode: "restricted", allowDomains: ["pypi.org"] },
    },
    { provider: "isolate", size: "large" },
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
    "an isolate sandbox refuses restricted egress, a size and a long timeout",
    refusals[0]!.includes("deny-all or allow-all") &&
      refusals[1]!.includes("config.size does not apply") &&
      refusals[2]!.includes("config.timeout"),
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
  const { agentId } = await context.account.createAgent({
    name: key,
    config: {
      ...context.model,
      agent: {
        system:
          "Use the bash tool to run exactly the command the user gives, then reply with exactly its output and nothing else.",
      },
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
  // The read answers the marker reversed, which no prompt contains, so the
  // model cannot pass it from the conversation without the file.
  const marker = `iso-${context.runId}`;
  const reversed = marker.split("").reverse().join("");
  const wrote = await turn(
    `Run: echo ${marker} > /workspace/marker`,
    "isolate write",
  );
  const read = await turn("Run: rev /workspace/marker", "isolate read");
  assertStep(
    "a persistent isolate keeps a file between turns",
    wrote.status === "completed" &&
      read.status === "completed" &&
      JSON.stringify(read.response ?? "").includes(reversed),
    `${JSON.stringify(wrote)}\n${JSON.stringify(read)}`,
  );
}
