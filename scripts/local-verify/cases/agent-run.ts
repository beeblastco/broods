import type { CreateAgentResult } from "../../../packages/broods/src/account.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  lastJsonLine,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

const PREPARE_BUDGET_MS = 100;

interface ContextPreparedLog {
  durationMs: number;
  eventId: string;
  eventType: string;
  historyMs: number;
  historyRows: number;
  mediaMs: number;
  memoryMs: number;
  runtimeMs: number;
  skillsMs: number;
  subagentsMs: number;
}

/**
 * A cold run, then a warm turn on the same conversation. The warm turn's
 * context prepare, read from the core log, must stay under budget.
 */
export async function agentRun(context: VerifyContext): Promise<void> {
  const key = `smoke-${context.runId}`;
  const { agentId } = await context.measure(
    "create agent",
    (): Promise<CreateAgentResult> =>
      context.account.createAgent({
        name: key,
        config: {
          ...context.model,
          instructions: "Reply with the single word OK.",
        },
      }),
  );
  const turns = [
    { eventId: key, step: "cold run", text: "Say OK." },
    { eventId: `${key}-warm`, step: "warm run", text: "Say OK again." },
  ];
  for (const turn of turns) {
    const status = await context.measure(turn.step, (): Promise<AsyncStatus> =>
      runToTerminal(context, {
        agentId: agentId,
        conversationKey: key,
        eventId: turn.eventId,
        text: turn.text,
      }),
    );
    assertStep(
      context.hasModelKey
        ? `${turn.step} completed on ${context.model.model.modelId}`
        : `${turn.step} reached a terminal state (${MODEL_KEY_HINT})`,
      context.hasModelKey
        ? status.status === "completed"
        : status.status === "completed" || status.status === "failed",
      JSON.stringify(status),
    );
  }

  const prepared = lastJsonLine<ContextPreparedLog>(
    context.coreLogPath,
    (record: ContextPreparedLog): boolean =>
      record.eventType === "session.context.prepared" &&
      record.eventId.endsWith(`:${key}-warm`),
  );
  assertStep(
    `warm context prepare under ${PREPARE_BUDGET_MS}ms`,
    prepared !== null && prepared.durationMs < PREPARE_BUDGET_MS,
    JSON.stringify(prepared),
  );
  console.log(
    `prepare   ${prepared.durationMs}ms: history ${prepared.historyMs}ms over ${prepared.historyRows} rows, runtime ${prepared.runtimeMs}ms, memory ${prepared.memoryMs}ms, skills ${prepared.skillsMs}ms, subagents ${prepared.subagentsMs}ms, media ${prepared.mediaMs}ms`,
  );
}
