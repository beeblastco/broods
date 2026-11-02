import { assertStep, convexResult, type VerifyContext } from "../harness.ts";

interface AsyncToolRow {
  handback?: string;
  status: string;
}

/**
 * A status read hands the model a result and stores nothing; the history
 * write that saves the read's tool message carries the result's id, and only
 * that write stores the row (#1183). An id that names another conversation's
 * result moves nothing. Drives the deployed backend directly, so it needs no
 * model key.
 */
export async function statusReadHandback(
  context: VerifyContext,
): Promise<void> {
  const { accountId } = await context.account.getAccount();
  const conversation = (name: string): string =>
    `acct:${accountId}:agent:verify-agent:api:${name}-${context.runId}`;
  const read = conversation("status-read");
  const other = conversation("status-read-other");
  const ownResult = `async_tool_read_${context.runId}`;
  const otherResult = `async_tool_other_${context.runId}`;
  for (const [resultId, conversationKey] of [
    [ownResult, read],
    [otherResult, other],
  ] as const) {
    convexResult(
      context,
      "runtime:createAsyncToolResult",
      {
        resultId: resultId,
        parentEventId: `${conversationKey}:parent`,
        conversationKey: conversationKey,
        toolName: "lookup",
        toolCallId: `call-${resultId}`,
        input: {},
      },
      "create a background result row",
    );
    convexResult(
      context,
      "runtime:updateAsyncToolResult",
      {
        resultId: resultId,
        status: "completed",
        response: "done",
        onlyWhenProcessing: true,
      },
      "settle the background result",
    );
  }
  const handback = (resultId: string): string | undefined =>
    (
      convexResult(
        context,
        "runtime:getAsyncToolResult",
        { resultId: resultId },
        "read the result row",
      ) as AsyncToolRow | null
    )?.handback;
  assertStep(
    "a settled result waits for its conversation to save it",
    handback(ownResult) === "pending",
    String(handback(ownResult)),
  );

  // The read's step save, carrying both ids: only the conversation's own
  // result moves.
  convexResult(
    context,
    "runtime:appendConversationEvent",
    {
      conversationKey: read,
      events: [
        {
          cursor: `${new Date().toISOString()}#status-read#0001`,
          event: { role: "tool", content: [] },
          toolResultIds: [ownResult, otherResult],
        },
      ],
    },
    "save the status read's step",
  );
  assertStep(
    "the saved read stores its result",
    handback(ownResult) === "stored",
    String(handback(ownResult)),
  );
  assertStep(
    "an id for another conversation's result moves nothing",
    handback(otherResult) === "pending",
    String(handback(otherResult)),
  );
}
