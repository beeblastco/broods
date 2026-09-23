/**
 * The core run path: a cold background run, then a warm second turn on the
 * same conversation, the path a live chat takes. The warm turn's context
 * prepare has a budget, read from the timings core logs per run.
 */

import {
  MODEL_KEY_HINT,
  assertStep,
  createAgent,
  lastJsonLine,
  pollRunStatus,
  startRun,
  type VerifyCase,
  type VerifyContext,
} from "../harness.ts";

// Convex is on localhost here, so this catches prepare work that grows or
// goes serial, not network latency.
const PREPARE_BUDGET_MS = 100;

// The "Context prepared" line core logs once per run (apps/core harness.ts).
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

export const agentRunCase: VerifyCase = {
  name: "agent run",
  run: async (context: VerifyContext): Promise<void> => {
    const agentId = await context.measure("create agent", () =>
      createAgent(context, `smoke-${context.runId}`, {
        instructions: "Reply with the single word OK.",
      }),
    );
    const conversationKey = `smoke-${context.runId}`;
    const eventId = `smoke-${context.runId}`;

    await context.measure("cold run to terminal state", async () => {
      const statusUrl = await startRun(context, {
        agentId: agentId,
        conversationKey: conversationKey,
        eventId: eventId,
        text: "Say OK.",
      });
      const finalStatus = await pollRunStatus(statusUrl, context.accountSecret);
      assertStep(
        context.hasModelKey
          ? `run completed on ${context.model.model.modelId}`
          : `run reached a terminal state (no model key; ${MODEL_KEY_HINT})`,
        context.hasModelKey
          ? finalStatus.status === "completed"
          : finalStatus.status === "completed" ||
              finalStatus.status === "failed",
        JSON.stringify(finalStatus),
      );
    });

    const warmEventId = `${eventId}-warm`;
    await context.measure("warm run to terminal state", async () => {
      const statusUrl = await startRun(context, {
        agentId: agentId,
        conversationKey: conversationKey,
        eventId: warmEventId,
        text: "Say OK again.",
      });
      const finalStatus = await pollRunStatus(statusUrl, context.accountSecret);
      assertStep(
        "warm run reached a terminal state",
        finalStatus.status === "completed" || finalStatus.status === "failed",
        JSON.stringify(finalStatus),
      );
    });

    // Core scopes the event id under the account and agent, so the public id
    // is matched as a suffix. The last match wins, since a retry prepares again.
    const prepared = lastJsonLine<ContextPreparedLog>(
      context.coreLogPath,
      (record) =>
        record.eventType === "session.context.prepared" &&
        record.eventId.endsWith(`:${warmEventId}`),
    );
    assertStep(
      `warm context prepare under ${PREPARE_BUDGET_MS}ms`,
      prepared !== null && prepared.durationMs < PREPARE_BUDGET_MS,
      prepared === null
        ? "no Context prepared line for the warm run in the core log"
        : JSON.stringify(prepared),
    );
    console.log(
      `prepare   ${prepared.durationMs}ms: history ${prepared.historyMs}ms over ${prepared.historyRows} rows, runtime ${prepared.runtimeMs}ms, memory ${prepared.memoryMs}ms, skills ${prepared.skillsMs}ms, subagents ${prepared.subagentsMs}ms, media ${prepared.mediaMs}ms`,
    );
  },
};
