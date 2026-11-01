import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  connectMachine,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

/**
 * A bash call past its sandbox's per-call limit fails with one timeout result
 * that names the limit: a machine sandbox capped at 2s runs `sleep 5`.
 */
export async function bashTimeout(context: VerifyContext): Promise<void> {
  if (!context.hasModelKey) {
    console.log(`  skip bash past its limit (${MODEL_KEY_HINT})`);
    return;
  }
  const name = `timeout-${context.runId}`;
  const machine = await connectMachine(context, {
    computer: false,
    name: name,
    timeout: 2,
  });
  try {
    const { agentId } = await context.account.createAgent({
      name: name,
      config: {
        ...context.model,
        agent: {
          system:
            "Call the bash tool exactly once, with the command `sleep 5`. Never call a tool again, whatever it returns. Then reply with exactly the text the tool returned and nothing else.",
        },
        sandboxes: [machine.sandboxId],
      },
    });
    const status = await context.measure(
      "bash past its limit",
      (): Promise<AsyncStatus> =>
        runToTerminal(context, {
          agentId: agentId,
          conversationKey: name,
          eventId: `${name}-run`,
          text: "Run `sleep 5` with the bash tool, once, and reply with what it returned.",
        }),
    );
    const reply = JSON.stringify(status.response ?? "");
    assertStep(
      "bash past the per-call limit fails naming the limit",
      status.status === "completed" &&
        machine.output().includes("(timed out)") &&
        reply.includes("timed out after 2s"),
      `${JSON.stringify(status)}\n${machine.output()}`,
    );
  } finally {
    await machine.stop();
  }
}
