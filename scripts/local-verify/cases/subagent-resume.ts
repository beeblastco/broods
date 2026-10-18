import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  convexResult,
  lastJsonLine,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

const CODE = "ALPHA-47";
// The scope every runtime key carries, `acct:<account>:agent:<agent>`, ends here.
const API_SCOPE_MARKER = ":api:";

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
  assertHandedBackOnce(context, first, key);
  // The model gets the exact key, so the check does not hang on it recalling
  // the key from history: it once started a fresh child and resumed that one.
  // Matching the resume on this key still catches it reaching another child.
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

/**
 * The child's result reached the parent exactly once: the parent's
 * conversation holds one result row for the task, and the child's result row
 * records the hand-back as stored, so no late resume or sweep repeats it.
 */
function assertHandedBackOnce(
  context: VerifyContext,
  child: SubagentStartedLog,
  parentKey: string,
): void {
  const scopeOf = (scopedKey: string): string =>
    scopedKey.slice(0, scopedKey.indexOf(API_SCOPE_MARKER));
  const row = convexResult(
    context,
    "runtime:getAsyncAgentResult",
    { eventId: `${scopeOf(child.conversationKey)}:api:${child.taskId}` },
    "read the child's result row",
  ) as { status: string; handback?: string } | null;
  assertStep(
    "the child's result row is stored with its parent",
    row?.status === "completed" && row.handback === "stored",
    JSON.stringify(row),
  );
  const history = convexResult(
    context,
    "runtime:listConversationEvents",
    { conversationKey: `${scopeOf(child.parentEventId)}:api:${parentKey}` },
    "read the parent's conversation",
  ) as { page: Array<{ event: unknown }> };
  const results = history.page.filter((entry): boolean => {
    const text = JSON.stringify(entry.event);

    return (
      text.includes(`taskId: ${child.taskId}`) &&
      text.includes("status: completed")
    );
  });
  assertStep(
    "the parent's conversation holds the child's result once",
    results.length === 1,
    JSON.stringify(results),
  );
}

/**
 * Runs one parent turn to completion and returns the child it started, or,
 * with `resumes`, the child it resumed under that key.
 */
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

  return lastJsonLine<SubagentStartedLog>(
    context.coreLogPath,
    (record: SubagentStartedLog): boolean =>
      record.message === "Subagent task started" &&
      record.parentEventId.endsWith(`:${turn.eventId}`) &&
      (turn.resumes === undefined ||
        (record.resuming &&
          publicKey(record.conversationKey) === turn.resumes)),
  );
}

/** The key run_subagent returned, read from the child's scoped conversation key. */
function publicKey(conversationKey: string): string {
  return conversationKey.slice(
    conversationKey.indexOf(":api:") + ":api:".length,
  );
}
