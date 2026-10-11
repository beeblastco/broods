import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  lastJsonLine,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

const CODE = "ALPHA-47";

interface SubagentStartedLog {
  agentId: string;
  conversationKey: string;
  message: string;
  parentEventId: string;
  resuming: boolean;
  taskId: string;
}

interface ContextPreparedLog {
  eventId: string;
  eventType: string;
  historyRows: number;
}

/**
 * A persistent virtual subagent resumed with the conversationKey it returned
 * is the same child on the same stored conversation, so it still knows what
 * the first task told it.
 */
export async function subagentResume(context: VerifyContext): Promise<void> {
  if (!context.hasModelKey) {
    console.log(`  skip subagent resume (${MODEL_KEY_HINT})`);
    return;
  }
  const key = `subagent-resume-${context.runId}`;
  const { agentId } = await context.account.createAgent({
    name: key,
    config: {
      ...context.model,
      instructions:
        "You delegate. Call run_subagent exactly once per request, with no agentId, then reply with what the subagent answered.",
      subagent: { enabled: true },
    },
  });
  const turns = [
    {
      eventId: `${key}-first`,
      text: `Call run_subagent with this exact prompt: 'Remember the release code ${CODE}. Reply OK.'`,
    },
    {
      eventId: `${key}-resume`,
      text: "Call run_subagent with the conversationKey your earlier run_subagent call returned, and this exact prompt: 'What release code did I ask you to remember? Reply with the code only.'",
    },
  ];
  const started: SubagentStartedLog[] = [];
  for (const turn of turns) {
    const answer = await context.measure(
      `parent turn ${turn.eventId}`,
      (): Promise<AsyncStatus> =>
        runToTerminal(context, {
          agentId: agentId,
          conversationKey: key,
          eventId: turn.eventId,
          text: turn.text,
        }),
    );
    assertStep(
      `parent turn ${turn.eventId} completed`,
      answer.status === "completed",
      JSON.stringify(answer),
    );
    const child = lastJsonLine<SubagentStartedLog>(
      context.coreLogPath,
      (record: SubagentStartedLog): boolean =>
        record.message === "Subagent task started" &&
        record.parentEventId.endsWith(`:${turn.eventId}`),
    );
    if (!child) {
      console.log("  skip subagent resume (the parent answered without one)");
      return;
    }
    started.push(child);
  }
  const [first, resumed] = started;
  if (resumed?.resuming !== true) {
    console.log("  skip subagent resume (the parent did not pass the key)");
    return;
  }
  assertStep(
    "the resumed virtual subagent is the same child",
    resumed.agentId === first?.agentId &&
      resumed.conversationKey === first.conversationKey,
    JSON.stringify(started),
  );
  // The child's own context, not the parent's answer: the parent's history
  // holds the code too, so only this shows the child kept its first task.
  const prepared = lastJsonLine<ContextPreparedLog>(
    context.coreLogPath,
    (record: ContextPreparedLog): boolean =>
      record.eventType === "session.context.prepared" &&
      record.eventId.endsWith(`:${resumed.taskId}`),
  );
  assertStep(
    "the resumed virtual subagent loaded its first task's prompt and answer",
    prepared !== null && prepared.historyRows >= 3,
    JSON.stringify(prepared),
  );
}
