import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  API_SCOPE_MARKER,
  MODEL_KEY_HINT,
  assertHandedBackOnce,
  assertStep,
  lastJsonLine,
  runToTerminal,
  startedChildLog,
  type SubagentStartedLog,
  type VerifyContext,
} from "../harness.ts";

const CODE = "ALPHA-47";

interface ContextPreparedLog {
  eventId: string;
  eventType: string;
  historyRows: number;
}

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
      agent: {
        system:
          "You delegate. Call run_subagent exactly once per request, with no agentId, then reply with what the subagent answered.",
      },
      subagent: { enabled: true },
    },
  });
  const first = await startedChild(context, agentId, key, {
    eventId: `${key}-first`,
    text: `Call run_subagent with this exact prompt: 'Remember the release code ${CODE}. Reply OK.'`,
  });
  if (!first) {
    console.log("  skip subagent resume (the parent answered without one)");
    return;
  }
  assertHandedBackOnce(context, first, key, "completed");
  // The prompt carries the exact key, so the check never hinges on the model's recall.
  const childKey = publicKey(first.conversationKey);
  const resumed = await startedChild(context, agentId, key, {
    eventId: `${key}-resume`,
    text: `Call run_subagent once, with conversationKey "${childKey}" exactly and this exact prompt: 'What release code did I ask you to remember? Reply with the code only.'`,
    resumes: childKey,
  });
  if (!resumed) {
    console.log("  skip subagent resume (the parent did not pass the key)");
    return;
  }
  assertStep(
    "the resumed virtual subagent is the same child",
    resumed.agentId === first.agentId &&
      resumed.conversationKey === first.conversationKey,
    JSON.stringify([first, resumed]),
  );
  // The parent's history holds the code too, so only the child's own context proves it kept it.
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

async function startedChild(
  context: VerifyContext,
  agentId: string,
  key: string,
  turn: { eventId: string; text: string; resumes?: string },
): Promise<SubagentStartedLog | null> {
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

  return startedChildLog(
    context,
    turn.eventId,
    (record: SubagentStartedLog): boolean =>
      turn.resumes === undefined ||
      (record.resuming && publicKey(record.conversationKey) === turn.resumes),
  );
}

function publicKey(conversationKey: string): string {
  return conversationKey.slice(
    conversationKey.indexOf(API_SCOPE_MARKER) + API_SCOPE_MARKER.length,
  );
}
