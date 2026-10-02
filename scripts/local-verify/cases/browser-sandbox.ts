import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import { assertStep, runToTerminal, type VerifyContext } from "../harness.ts";

/**
 * An agent with `browser` on a sandbox without Obscura fails the run at tool
 * assembly with the change to make, before any model or AWS call, so it needs
 * no model key.
 */
export async function browserSandbox(context: VerifyContext): Promise<void> {
  const key = `browser-${context.runId}`;
  const sandbox = await context.account.createSandbox({
    name: key,
    config: { provider: "lambda", network: { mode: "allow-all" } },
  });
  const { agentId } = await context.account.createAgent({
    name: key,
    config: {
      ...context.model,
      instructions: "Reply with the single word OK.",
      sandboxes: [sandbox.sandboxId],
      browser: { enabled: true },
    },
  });
  const status = await context.measure(
    "browser on a base image run",
    (): Promise<AsyncStatus> =>
      runToTerminal(context, {
        agentId: agentId,
        conversationKey: key,
        eventId: key,
        text: "Say OK.",
      }),
  );
  assertStep(
    "browser on a sandbox without the obscura image is refused",
    status.status === "failed" &&
      (status.error ?? "").includes('image: "obscura"'),
    JSON.stringify(status),
  );
}
