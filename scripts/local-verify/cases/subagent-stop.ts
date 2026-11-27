import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  connectMachine,
  lastJsonLine,
  pollUntil,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

// apps/core harness.ts's PARENT_STOP_MESSAGE; importing it would load the whole harness.
const PARENT_STOP_LABEL = "Stopped by the parent agent at the model boundary";
// The model words the tool's note its own way, so match its meaning.
const NO_REPORT = /(\b(no|not|never)\b|n't)[^.]{0,40}\breports?\b/i;

interface SubagentStoppedLog {
  error?: string;
  message: string;
  parentEventId: string;
}

export async function subagentStop(context: VerifyContext): Promise<void> {
  if (!context.hasModelKey) {
    console.log(`  skip subagent stop (${MODEL_KEY_HINT})`);
    return;
  }
  const key = `subagent-stop-${context.runId}`;
  const machine = await connectMachine(context, {
    computer: false,
    name: key,
    // A hanging command ends fast, so the stop lands at the next step boundary.
    timeout: 5,
  });
  try {
    const { agentId } = await context.account.createAgent({
      name: key,
      config: {
        ...context.model,
        agent: {
          system:
            "Call run_subagent once, with this exact prompt word for word: 'Use the bash tool to run `sleep 3`, ten times, one call per step. Then reply DONE.' As soon as it returns, call stop_subagent with the taskId and agentId it returned. Then reply with exactly the note field stop_subagent returned and nothing else.",
        },
        sandboxes: [machine.sandboxId],
        subagent: { enabled: true, mode: "persistent" },
      },
    });
    const status = await context.measure(
      "run that stops its subagent",
      (): Promise<AsyncStatus> =>
        runToTerminal(context, {
          agentId: agentId,
          conversationKey: key,
          eventId: key,
          text: "Start the subagent, then stop it.",
        }),
    );
    const stopped = await pollUntil(
      { initialIntervalMs: 200, maxIntervalMs: 1_000, timeoutMs: 30_000 },
      async (): Promise<SubagentStoppedLog | null> =>
        lastJsonLine<SubagentStoppedLog>(
          context.coreLogPath,
          (record: SubagentStoppedLog): boolean =>
            record.message === "Subagent task stopped" &&
            record.parentEventId.endsWith(`:${key}`),
        ),
    );
    if (!stopped && status.status === "completed") {
      console.log("  skip subagent stop (the child answered before the stop)");
      return;
    }
    assertStep(
      "parent was told a stopped subagent sends no report",
      status.status === "completed" &&
        // Raw text: JSON.stringify's `\n` glues an "n" onto the next word, defeating `\bNo`.
        NO_REPORT.test(
          typeof status.response === "string"
            ? status.response
            : JSON.stringify(status.response ?? ""),
        ),
      JSON.stringify(status),
    );
    assertStep(
      "the child's stop is labelled as the parent agent's",
      stopped?.error === PARENT_STOP_LABEL,
      JSON.stringify(stopped),
    );
  } finally {
    await machine.stop();
  }
}
