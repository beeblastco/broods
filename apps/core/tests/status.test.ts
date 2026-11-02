import { afterEach, describe, expect, it, mock } from "bun:test";
import { runtime } from "../src/shared/convex/runtime.ts";
import {
  createDetachedAsyncToolResult,
  settleAsyncToolResultFromCallback,
  verifyAsyncToolCompletionToken,
} from "../src/harness/async-tool-result.ts";

const originalQuery = runtime.query.bind(runtime);
const originalMutation = runtime.mutate.bind(runtime);
const queryMock = mock(
  async (_name: string, _args: Record<string, unknown>): Promise<unknown> =>
    null,
);
const mutationMock = mock(
  async (name: string, _args: Record<string, unknown>) =>
    name.startsWith("create") ? true : null,
);

afterEach(() => {
  runtime.query = originalQuery;
  runtime.mutate = originalMutation;
  queryMock.mockClear();
  mutationMock.mockClear();
});

describe("async tool result persistence", () => {
  it("forwards delivery and callback authorization to the transactional create", async () => {
    runtime.mutate = mutationMock as never;
    await createDetachedAsyncToolResult({
      eventId: "event-1",
      tag: "bash",
      resultId: "result-1",
      conversationKey: "conversation-1",
      toolName: "slowLookup",
      toolCallId: "call-1",
      input: { query: "alpha" },
      delivery: { kind: "async" },
      completionToken: "token-1",
    });
    expect(mutationMock).toHaveBeenCalledWith(
      "createAsyncToolResult",
      expect.objectContaining({
        parentEventId: "event-1:bash:result-1",
        delivery: { kind: "async" },
        completionToken: "token-1",
      }),
    );
  });

  it("verifies callback tokens and settles with processing-only CAS", async () => {
    queryMock.mockResolvedValueOnce(true as never);
    runtime.query = queryMock as never;
    runtime.mutate = mutationMock as never;
    expect(verifyAsyncToolCompletionToken("result-1", "token-1")).resolves.toBe(
      true,
    );
    await settleAsyncToolResultFromCallback({
      resultId: "result-1",
      status: "failed",
      error: "boom",
    });
    expect(queryMock).toHaveBeenCalledWith("getAsyncToolToken", {
      resultId: "result-1",
      completionToken: "token-1",
    });
    expect(mutationMock).toHaveBeenCalledWith("updateAsyncToolResult", {
      resultId: "result-1",
      status: "failed",
      onlyWhenProcessing: true,
      error: "boom",
    });
  });
});
