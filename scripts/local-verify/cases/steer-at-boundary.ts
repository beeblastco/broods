import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  connectMachine,
  type VerifyContext,
} from "../harness.ts";

const RUN_TIMEOUT_MS = 120_000;
const STEER_WORD = "PINEAPPLE";

/**
 * A steer sent while a run owns the conversation joins that run at its next
 * model step boundary: the run's bash call keeps a boundary ahead of the
 * steer, the steer settles with the run, and the run's answer uses it.
 */
export async function steerAtBoundary(context: VerifyContext): Promise<void> {
  if (!context.hasModelKey) {
    console.log(`  skip steer at a step boundary (${MODEL_KEY_HINT})`);
    return;
  }
  const key = `steer-${context.runId}`;
  const machine = await connectMachine(context, {
    computer: false,
    name: key,
  });
  try {
    const { agentId } = await context.account.createAgent({
      name: key,
      config: {
        ...context.model,
        instructions:
          "First use the bash tool to run `sleep 5`. Then reply with exactly the last word of the latest user message and nothing else.",
        sandboxes: [machine.sandboxId],
      },
    });
    const owner = await context.client.runAsync({
      agentId: agentId,
      conversationKey: key,
      eventId: `${key}-owner`,
      input: "Run the command.",
    });
    const steer = await context.client.runAsync({
      agentId: agentId,
      conversationKey: key,
      eventId: `${key}-steer`,
      input: `The word is ${STEER_WORD}`,
      mode: "steer",
    });
    assertStep(
      "steer queued behind the running turn",
      steer.status === "queued",
      JSON.stringify(steer),
    );

    const [ownerStatus, steerStatus] = await context.measure(
      "run with a steer",
      (): Promise<[AsyncStatus, AsyncStatus]> =>
        Promise.all([
          owner.wait({ intervalMs: 500, timeoutMs: RUN_TIMEOUT_MS }),
          steer.wait({ intervalMs: 500, timeoutMs: RUN_TIMEOUT_MS }),
        ]),
    );
    assertStep(
      "steer joined the running turn and settled with it",
      steerStatus.status === "completed" && steerStatus.appliedMode === "steer",
      JSON.stringify(steerStatus),
    );
    assertStep(
      "the turn answered with the steer",
      ownerStatus.status === "completed" &&
        JSON.stringify(ownerStatus.response ?? "").includes(STEER_WORD),
      JSON.stringify(ownerStatus),
    );
  } finally {
    await machine.stop();
  }
}
