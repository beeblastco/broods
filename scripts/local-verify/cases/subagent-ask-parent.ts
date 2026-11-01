import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  convexResult,
  lastJsonLine,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

const ANSWER = "TEAL";
// The scope every runtime key carries, `acct:<account>:agent:<agent>`, ends here.
const API_SCOPE_MARKER = ":api:";

interface SubagentStartedLog {
  conversationKey: string;
  message: string;
  parentEventId: string;
  resuming: boolean;
  taskId: string;
}

interface ResultRow {
  status: string;
  handback?: string;
  question?: string;
}

/**
 * A persistent child's ask_parent ends its turn: the question lands on its
 * result row as awaiting_input, reaches the parent once through the same
 * hand-back as a result, and the parent's answer resumes the child on its
 * stored conversation, so its next turn answers from it.
 */
export async function subagentAskParent(context: VerifyContext): Promise<void> {
  if (!context.hasModelKey) {
    console.log(`  skip subagent ask_parent (${MODEL_KEY_HINT})`);
    return;
  }
  const key = `subagent-ask-${context.runId}`;
  const { agentId: childId } = await context.account.createAgent({
    name: `${key}-child`,
    config: {
      ...context.model,
      agent: {
        system:
          "On your first task call ask_parent exactly once with the question 'Which color?', and nothing else. When the answer arrives, reply with exactly COLOR= followed by the answer and nothing else.",
      },
    },
  });
  const { agentId } = await context.account.createAgent({
    name: key,
    config: {
      ...context.model,
      agent: {
        system: `Call run_subagent once with agentId "${childId}" and the prompt 'Pick a color.'. When a subagent question arrives, answer it by calling run_subagent once with the conversationKey and agentId it names and the prompt '${ANSWER}'. When its result arrives, reply with exactly that result.`,
      },
      subagent: { enabled: true, mode: "persistent", allowed: [childId] },
    },
  });
  const answer = await context.measure(
    "parent turn that answers a question",
    (): Promise<AsyncStatus> =>
      runToTerminal(context, {
        agentId: agentId,
        conversationKey: key,
        eventId: key,
        text: "Get a color from the subagent.",
      }),
  );
  assertStep(
    "the parent turn completed",
    answer.status === "completed",
    JSON.stringify(answer),
  );
  const asked = childTurn(context, key, false);
  if (!asked) {
    console.log("  skip subagent ask_parent (the parent started no child)");
    return;
  }
  const askedRow = resultRow(context, asked);
  if (askedRow?.status !== "awaiting_input") {
    console.log(
      `  skip subagent ask_parent (the child asked nothing: ${JSON.stringify(askedRow)})`,
    );
    return;
  }
  assertStep(
    "the child's question is on its result row and stored with its parent",
    askedRow.question !== undefined && askedRow.handback === "stored",
    JSON.stringify(askedRow),
  );
  const history = convexResult(
    context,
    "runtime:listConversationEvents",
    {
      conversationKey: `${scopeOf(asked.parentEventId)}${API_SCOPE_MARKER}${key}`,
    },
    "read the parent's conversation",
  ) as { page: Array<{ event: unknown }> };
  const questions = history.page.filter((entry): boolean => {
    const text = JSON.stringify(entry.event);

    return (
      text.includes(`taskId: ${asked.taskId}`) &&
      text.includes("Subagent question")
    );
  });
  assertStep(
    "the parent's conversation holds the question once",
    questions.length === 1,
    JSON.stringify(questions),
  );
  const resumed = childTurn(context, key, true);
  assertStep(
    "the parent's answer resumed the same child conversation",
    resumed !== null && resumed.conversationKey === asked.conversationKey,
    JSON.stringify([asked, resumed]),
  );
  const resumedRow = resultRow(context, resumed);
  assertStep(
    "the resumed child answered from the parent's answer",
    resumedRow?.status === "completed" &&
      JSON.stringify(resumedRow).toUpperCase().includes(ANSWER),
    JSON.stringify(resumedRow),
  );
}

/** The parent turn's first child start, or its resume of that child. */
function childTurn(
  context: VerifyContext,
  key: string,
  resuming: boolean,
): SubagentStartedLog | null {
  return lastJsonLine<SubagentStartedLog>(
    context.coreLogPath,
    (record: SubagentStartedLog): boolean =>
      record.message === "Subagent task started" &&
      record.parentEventId.endsWith(`:${key}`) &&
      record.resuming === resuming,
  );
}

function resultRow(
  context: VerifyContext,
  child: SubagentStartedLog,
): ResultRow | null {
  return convexResult(
    context,
    "runtime:getAsyncAgentResult",
    {
      eventId: `${scopeOf(child.conversationKey)}${API_SCOPE_MARKER}${child.taskId}`,
    },
    "read the child's result row",
  ) as ResultRow | null;
}

function scopeOf(scopedKey: string): string {
  return scopedKey.slice(0, scopedKey.indexOf(API_SCOPE_MARKER));
}
