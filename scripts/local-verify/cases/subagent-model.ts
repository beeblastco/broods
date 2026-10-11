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

// A second model the stack's DeepSeek key serves, unlike the parent's.
const SUBAGENT_MODEL_ID = "deepseek-v4-pro";

interface SubagentStartedLog {
  agentId: string;
  message: string;
  parentEventId: string;
}

interface ModelStepLog {
  agentId?: string;
  eventType?: string;
  modelId?: string;
  toolCalls?: { toolName: string }[];
}

/**
 * A virtual subagent runs on `subagent.model` and still calls the parent's
 * tools: its bash step runs on the parent's sandbox, on the configured model,
 * while the parent stays on its own.
 */
export async function subagentModel(context: VerifyContext): Promise<void> {
  if (!context.hasModelKey) {
    console.log(`  skip subagent model (${MODEL_KEY_HINT})`);
    return;
  }
  const key = `subagent-model-${context.runId}`;
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
          "Call run_subagent once, with no agentId, and with this exact prompt word for word: 'Use the bash tool to run `echo subagent-model-ok`, then reply with its output.' Then reply with the result it reports.",
        sandboxes: [machine.sandboxId],
        subagent: { enabled: true, model: { modelId: SUBAGENT_MODEL_ID } },
      },
    });
    const status = await context.measure(
      "run whose virtual subagent has its own model",
      (): Promise<AsyncStatus> =>
        runToTerminal(context, {
          agentId: agentId,
          conversationKey: key,
          eventId: key,
          text: "Start the subagent and report what it found.",
        }),
    );
    assertStep(
      "parent run with a virtual subagent completed",
      status.status === "completed",
      JSON.stringify(status),
    );
    const delegated = lastJsonLine<ModelStepLog>(
      context.coreLogPath,
      (record: ModelStepLog): boolean =>
        record.eventType === "model.step.finished" &&
        record.agentId === agentId &&
        record.toolCalls?.some(
          (call: { toolName: string }): boolean =>
            call.toolName === "run_subagent",
        ) === true,
    );
    if (!delegated) {
      console.log(
        "  skip subagent model (the parent answered without a subagent)",
      );
      return;
    }
    const started = await pollUntil(
      { initialIntervalMs: 200, maxIntervalMs: 1_000, timeoutMs: 10_000 },
      async (): Promise<SubagentStartedLog | null> =>
        lastJsonLine<SubagentStartedLog>(
          context.coreLogPath,
          (record: SubagentStartedLog): boolean =>
            record.message === "Subagent task started" &&
            record.parentEventId.endsWith(`:${key}`),
        ),
    );
    assertStep(
      "the parent started a virtual subagent",
      started?.agentId.startsWith("virtual_subagent_") === true,
      JSON.stringify(started),
    );
    const childStep = await pollUntil(
      { initialIntervalMs: 200, maxIntervalMs: 1_000, timeoutMs: 10_000 },
      async (): Promise<ModelStepLog | null> =>
        lastJsonLine<ModelStepLog>(
          context.coreLogPath,
          (record: ModelStepLog): boolean =>
            record.eventType === "model.step.finished" &&
            record.agentId === started?.agentId &&
            record.toolCalls?.some(
              (call: { toolName: string }): boolean => call.toolName === "bash",
            ) === true,
        ),
    );
    assertStep(
      "the virtual subagent called the parent's bash tool on subagent.model",
      childStep?.modelId === SUBAGENT_MODEL_ID,
      JSON.stringify(childStep),
    );
    const parentStep = lastJsonLine<ModelStepLog>(
      context.coreLogPath,
      (record: ModelStepLog): boolean =>
        record.eventType === "model.step.finished" &&
        record.agentId === agentId,
    );
    assertStep(
      "the parent stayed on its own model",
      parentStep?.modelId === context.model.model.modelId,
      JSON.stringify(parentStep),
    );
  } finally {
    await machine.stop();
  }
}
