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

// harness.ts's PARENT_STOP_MESSAGE. Importing it would load the whole harness.
const PARENT_STOP_LABEL = "Stopped by the parent agent at the model boundary";
// The model words the tool's note its own way, so match its meaning.
const NO_REPORT = /(\b(no|not|never)\b|n't)[^.]{0,40}\breports?\b/i;

interface SubagentStoppedLog {
  error?: string;
  message: string;
  parentEventId: string;
}

/**
 * A parent that stops its persistent subagent with stop_subagent is told no
 * report is coming, and the child's run ends labelled as stopped by the
 * parent agent, not by the user.
 */
export async function subagentStop(context: VerifyContext): Promise<void> {
  if (!context.hasModelKey) {
    console.log(`  skip subagent stop (${MODEL_KEY_HINT})`);
    return;
  }
  const key = `subagent-stop-${context.runId}`;
  const machine = await connectMachine(context, {
    computer: false,
    name: key,
    // A command the child leaves hanging ends fast, so the stop lands at the
    // next step boundary instead of after the machine's default limit.
    timeout: 5,
  });
  try {
    const { agentId } = await context.account.createAgent({
      name: key,
      config: {
        ...context.model,
        instructions:
          "Call run_subagent once, with this exact prompt word for word: 'Use the bash tool to run `sleep 3`, ten times, one call per step. Then reply DONE.' As soon as it returns, call stop_subagent with the taskId and agentId it returned. Then reply with exactly the note field stop_subagent returned and nothing else.",
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
    // The model may hand the child a task it finishes in one step, before the
    // stop lands; then there is no stop to check.
    if (!stopped && status.status === "completed") {
      console.log("  skip subagent stop (the child answered before the stop)");
      return;
    }
    assertStep(
      "parent was told a stopped subagent sends no report",
      status.status === "completed" &&
        // The raw text: JSON.stringify turns a newline into `\n`, gluing an
        // "n" to the next word so `\bNo` no longer matches.
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
