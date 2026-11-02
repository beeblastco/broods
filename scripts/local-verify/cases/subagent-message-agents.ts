import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertHandedBackOnce,
  assertStep,
  childResultRow,
  pollUntil,
  runToTerminal,
  startedChildLog,
  type AsyncAgentRow,
  type SubagentStartedLog,
  type VerifyContext,
} from "../harness.ts";

const ANSWER = "TEAL";
const FALLBACK = "DEFAULT";
// The recovery sweep runs every 30s; this leaves room for the woken child's
// model call and the parent turn its result starts.
const TIMEOUT_WAKE_MS = 150_000;

/**
 * message-agents both ways: a persistent child waiting on "parent" ends its
 * turn, its message lands on its result row as awaiting_input and reaches the
 * parent once through the same hand-back as a result, and the parent's reply
 * to the child's address resumes it on its stored conversation, so its next
 * turn answers from it.
 */
export async function subagentMessageAgents(
  context: VerifyContext,
): Promise<void> {
  if (!context.hasModelKey) {
    console.log(`  skip subagent message-agents (${MODEL_KEY_HINT})`);
    return;
  }
  const key = `subagent-ask-${context.runId}`;
  const asked = await askingChild(context, key, {
    child: `If you have not messaged your parent yet, call message-agents exactly once with to 'parent', text 'Which color?' and waitSeconds 600, and nothing else. Once your parent has replied, reply with exactly COLOR= followed by the color and nothing else.`,
    parent: `When a subagent message arrives, reply to it by calling message-agents once with the to address it names, text '${ANSWER}' and waitSeconds 600. When its result arrives, reply with exactly that result.`,
  });
  const resumed = startedChildLog(
    context,
    key,
    (record: SubagentStartedLog): boolean => record.resuming,
  );
  assertStep(
    "the parent's reply resumed the same child conversation",
    resumed !== null && resumed.conversationKey === asked.conversationKey,
    JSON.stringify([asked, resumed]),
  );
  const resumedRow = childResultRow(context, resumed);
  assertStep(
    "the resumed child answered from the parent's reply",
    resumedRow?.status === "completed" &&
      JSON.stringify(resumedRow).toUpperCase().includes(ANSWER),
    JSON.stringify(resumedRow),
  );
}

/**
 * A child whose parent never replies is not stuck: once its wait runs out the
 * recovery sweep closes the question, wakes the child on its stored
 * conversation, and the child's answer reaches the parent like a late result.
 */
export async function subagentQuestionTimeout(
  context: VerifyContext,
): Promise<void> {
  if (!context.hasModelKey) {
    console.log(`  skip subagent question timeout (${MODEL_KEY_HINT})`);
    return;
  }
  const key = `subagent-timeout-${context.runId}`;
  const asked = await askingChild(context, key, {
    child: `If you have not messaged your parent yet, call message-agents exactly once with to 'parent', text 'Which color?' and waitSeconds 1, and nothing else. If your parent did not reply, reply with exactly COLOR=${FALLBACK} and nothing else.`,
    parent:
      "Never call message-agents. When a subagent message arrives, reply with exactly WAITING. When a subagent result arrives, reply with exactly that result.",
  });
  const woken = await context.measure(
    "the sweep wakes the unanswered child",
    (): Promise<AsyncAgentRow> =>
      pollUntil(
        {
          initialIntervalMs: 1_000,
          maxIntervalMs: 5_000,
          timeoutMs: TIMEOUT_WAKE_MS,
        },
        async (): Promise<AsyncAgentRow> => {
          const child = startedChildLog(
            context,
            key,
            (record: SubagentStartedLog): boolean =>
              record.resuming &&
              record.conversationKey === asked.conversationKey,
          );
          const row = child ? childResultRow(context, child) : null;

          return row?.status === "completed" && row.handback === "stored"
            ? row
            : null;
        },
      ),
  );
  assertStep(
    "the woken child carried on and its answer reached the parent",
    woken !== null && JSON.stringify(woken.response).includes(FALLBACK),
    JSON.stringify(woken),
  );
  assertStep(
    "the timed-out question is closed",
    childResultRow(context, asked)?.answerBy === undefined,
    JSON.stringify(childResultRow(context, asked)),
  );
}

/**
 * Runs a parent turn that starts one persistent child, which messages its
 * parent and waits; returns that child once its message reached the parent.
 */
async function askingChild(
  context: VerifyContext,
  key: string,
  prompts: { child: string; parent: string },
): Promise<SubagentStartedLog> {
  const { agentId: childId } = await context.account.createAgent({
    name: `${key}-child`,
    config: { ...context.model, agent: { system: prompts.child } },
  });
  const { agentId } = await context.account.createAgent({
    name: key,
    config: {
      ...context.model,
      agent: {
        system: `Call run_subagent once with agentId "${childId}" and the prompt 'Pick a color.'. ${prompts.parent}`,
      },
      subagent: { enabled: true, mode: "persistent", allowed: [childId] },
    },
  });
  const turn = await context.measure(
    `parent turn ${key}`,
    (): Promise<AsyncStatus> =>
      runToTerminal(context, {
        agentId: agentId,
        conversationKey: key,
        eventId: key,
        text: "Get a color from the subagent.",
      }),
  );
  assertStep(
    `parent turn ${key} completed`,
    turn.status === "completed",
    JSON.stringify(turn),
  );
  const asked = startedChildLog(
    context,
    key,
    (record: SubagentStartedLog): boolean => !record.resuming,
  );
  assertStep("the parent started a child", asked !== null, key);
  const askedRow = childResultRow(context, asked);
  assertStep(
    "the child's message is on its result row",
    askedRow?.question !== undefined,
    JSON.stringify(askedRow),
  );
  assertHandedBackOnce(context, asked, key, "awaiting_input");

  return asked;
}
