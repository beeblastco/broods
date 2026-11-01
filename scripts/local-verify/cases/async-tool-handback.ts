import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  convexResult,
  pollUntil,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

const API_SCOPE_MARKER = ":api:";
const CONTINUATION_TIMEOUT_MS = 120_000;
const QUESTION_ID = "color";
const ANSWER = "Blue";

interface AsyncToolRow {
  parentEventId: string;
  status: string;
  handback?: string;
}

export async function asyncToolHandback(context: VerifyContext): Promise<void> {
  if (!context.hasModelKey) {
    console.log(`  skip async tool hand-back (${MODEL_KEY_HINT})`);
    return;
  }
  const key = `tool-handback-${context.runId}`;
  const { agentId } = await context.account.createAgent({
    name: key,
    config: {
      ...context.model,
      agent: {
        system: `On the first user message call ask_questions exactly once, with blocking true and one question: id "${QUESTION_ID}", header "Color", question "Which color?", options "Red" and "Blue". Then end your turn with no other tool call. When the answer arrives, reply with exactly the chosen color and nothing else.`,
      },
    },
  });
  const asked = await context.measure(
    "turn that asks",
    (): Promise<AsyncStatus> =>
      runToTerminal(context, {
        agentId: agentId,
        conversationKey: key,
        eventId: `${key}-ask`,
        text: "Pick a color for me.",
      }),
  );
  const statusId = asked.questions?.[0]?.statusId;
  if (asked.status !== "awaiting_input" || statusId === undefined) {
    console.log(
      `  skip async tool hand-back (the agent asked nothing: ${JSON.stringify(asked)})`,
    );
    return;
  }

  const answered = await fetch(`${context.edgeUrl}/v1/runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${context.accountSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agentId: agentId,
      conversationKey: key,
      eventId: `${key}-answer`,
      answers: [{ statusId: statusId, answers: { [QUESTION_ID]: [ANSWER] } }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const accepted = (await answered.json()) as { invoked?: boolean };
  assertStep(
    "the answer resumed the conversation",
    answered.status === 202 && accepted.invoked === true,
    `status ${answered.status} ${JSON.stringify(accepted)}`,
  );

  // Admission stores the row in its own transaction, so no sweep delivers it twice.
  const row = convexResult(
    context,
    "runtime:getAsyncToolResult",
    { resultId: statusId },
    "read the question's result row",
  ) as AsyncToolRow | null;
  assertStep(
    "the answered row is stored with its conversation",
    row?.status === "completed" && row.handback === "stored",
    JSON.stringify(row),
  );

  // The question row's parent is the asking turn's scoped event id.
  const scope = row.parentEventId.slice(
    0,
    row.parentEventId.indexOf(API_SCOPE_MARKER),
  );
  const resumed = await pollUntil(
    {
      initialIntervalMs: 500,
      maxIntervalMs: 5_000,
      timeoutMs: CONTINUATION_TIMEOUT_MS,
    },
    async (): Promise<{ status: string; response?: unknown } | null> => {
      const continuation = convexResult(
        context,
        "runtime:getAsyncAgentResult",
        { eventId: `${row.parentEventId}:async-tools:${statusId}` },
        "read the resumed turn's row",
      ) as { status: string; response?: unknown } | null;

      return continuation?.status === "completed" ||
        continuation?.status === "failed"
        ? continuation
        : null;
    },
  );
  assertStep(
    "the resumed turn answered from the delivered result",
    resumed?.status === "completed" &&
      JSON.stringify(resumed.response ?? "").includes(ANSWER),
    JSON.stringify(resumed),
  );

  const history = convexResult(
    context,
    "runtime:listConversationEvents",
    { conversationKey: `${scope}${API_SCOPE_MARKER}${key}` },
    "read the conversation",
  ) as { page: Array<{ event: unknown }> };
  const injected = history.page.filter((entry): boolean =>
    JSON.stringify(entry.event).includes(`statusId: ${statusId}`),
  );
  assertStep(
    "the conversation holds the answer once",
    injected.length === 1,
    JSON.stringify(injected),
  );
}
