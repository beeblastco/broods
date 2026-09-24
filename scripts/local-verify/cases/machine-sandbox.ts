import { hostname } from "node:os";

import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  connectMachine,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

/**
 * This computer joins as a machine sandbox through the gateway, and with a
 * model key an agent runs bash on it. BROODS_VERIFY_COMPUTER=1 swaps bash for
 * the computer tool.
 */
export async function machineSandbox(context: VerifyContext): Promise<void> {
  const name = `machine-${context.runId}`;
  const computer = process.env.BROODS_VERIFY_COMPUTER === "1";
  const machine = await connectMachine(context, {
    computer: computer,
    name: name,
  });
  try {
    if (!context.hasModelKey) {
      console.log(`  skip agent on this machine (${MODEL_KEY_HINT})`);
      return;
    }
    const { agentId } = await context.account.createAgent({
      name: name,
      config: {
        ...context.model,
        instructions: computer
          ? "Use the computer tool to take one screenshot, then reply with exactly the frontmost app it reported and nothing else."
          : "Use the bash tool to run `hostname`, then reply with exactly its output and nothing else.",
        sandboxes: [machine.sandboxId],
      },
    });
    const status = await context.measure(
      "machine agent run",
      (): Promise<AsyncStatus> =>
        runToTerminal(context, {
          agentId: agentId,
          conversationKey: name,
          eventId: `${name}-run`,
          text: computer ? "What app is in front?" : "Run hostname.",
        }),
    );
    const reply = JSON.stringify(status.response ?? "");
    const output = machine.output();
    assertStep(
      computer
        ? "agent screenshot ran on this machine and the reply names an app"
        : "agent bash ran on this machine and the reply names this host",
      status.status === "completed" &&
        (computer
          ? output.includes("  screenshot") && reply.length > 2
          : output.includes("$ ") && reply.includes(hostname())),
      `${JSON.stringify(status)}\n${output}`,
    );
  } finally {
    await machine.stop();
  }
}
