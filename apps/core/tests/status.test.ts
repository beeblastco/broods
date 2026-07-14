/** Convex-backed async agent/tool wrapper contract tests. */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { runtime } from "../src/shared/convex/runtime.ts";
import {
  getAsyncAgentResult,
  markAsyncAgentResultAwaitingApproval,
  markAsyncAgentResultCompleted,
} from "../src/harness/async-agent-result.ts";
import {
  createPendingAsyncToolResult,
  getAsyncToolResult,
  sealDetachedAsyncToolGroup,
  settleAsyncToolResultFromCallback,
  verifyAsyncToolCompletionToken,
} from "../src/harness/async-tool-result.ts";

const originalQuery = runtime.query;
const originalMutation = runtime.mutate;
const queryMock = mock(async (_name: string, _args: Record<string, unknown>) => null);
const mutationMock = mock(async (name: string, _args: Record<string, unknown>) =>
  name.startsWith("create") ? true : null);

afterEach(() => {
  runtime.query = originalQuery;
  runtime.mutate = originalMutation;
  queryMock.mockClear();
  mutationMock.mockClear();
});

describe("async agent result persistence", () => {
  it("preserves approval and completed response shapes", async () => {
    runtime.mutate = mutationMock as never;
    const approvals = [{ approvalId: "approval-1", toolCallId: "call-1", toolName: "bash", input: { shell: "true" } }];
    await markAsyncAgentResultAwaitingApproval({ eventId: "event-1", approvals });
    await markAsyncAgentResultCompleted({ eventId: "event-1", response: { answer: "done" } });
    expect(mutationMock.mock.calls[0]).toEqual(["updateAsyncAgentResult", {
      eventId: "event-1", status: "awaiting_approval", approvals,
    }]);
    expect(mutationMock.mock.calls[1]).toEqual(["updateAsyncAgentResult", {
      eventId: "event-1", status: "completed", response: { answer: "done" },
    }]);
  });

  it("returns the public polling record unchanged", async () => {
    const record = {
      eventId: "event-1", conversationKey: "conversation-1", status: "completed" as const,
      response: { answer: "done" }, createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:01.000Z", expiresAt: 1770000000,
    };
    queryMock.mockResolvedValueOnce(record as never);
    runtime.query = queryMock as never;
    await expect(getAsyncAgentResult("event-1")).resolves.toEqual(record);
    expect(queryMock).toHaveBeenCalledWith("getAsyncAgentResult", { eventId: "event-1" });
  });
});

describe("async tool result persistence", () => {
  it("forwards delivery and callback authorization to the transactional create", async () => {
    runtime.mutate = mutationMock as never;
    await createPendingAsyncToolResult({
      resultId: "result-1", parentEventId: "event-1", conversationKey: "conversation-1",
      toolName: "slowLookup", toolCallId: "call-1", input: { query: "alpha" },
      delivery: { kind: "async" }, completionToken: "token-1",
    });
    expect(mutationMock).toHaveBeenCalledWith("createAsyncToolResult", expect.objectContaining({
      delivery: { kind: "async" }, completionToken: "token-1",
    }));
  });

  it("verifies callback tokens and settles with processing-only CAS", async () => {
    queryMock.mockResolvedValueOnce(true as never);
    runtime.query = queryMock as never;
    runtime.mutate = mutationMock as never;
    await expect(
      verifyAsyncToolCompletionToken("result-1", "token-1"),
    ).resolves.toBe(true);
    await settleAsyncToolResultFromCallback({ resultId: "result-1", status: "failed", error: "boom" });
    expect(queryMock).toHaveBeenCalledWith("getAsyncToolToken", {
      resultId: "result-1",
      completionToken: "token-1",
    });
    expect(mutationMock).toHaveBeenCalledWith("updateAsyncToolResult", {
      resultId: "result-1", status: "failed", onlyWhenProcessing: true, error: "boom",
    });
  });

  it("sorts fan-in ids and exposes general results without callback-token reads", async () => {
    queryMock.mockResolvedValueOnce({ resultId: "result-1", status: "completed" } as never);
    mutationMock.mockResolvedValueOnce({ parentEventId: "event-1", resultIds: ["result-2", "result-1"], sealed: true } as never);
    runtime.query = queryMock as never;
    runtime.mutate = mutationMock as never;
    await expect(getAsyncToolResult("result-1")).resolves.toMatchObject({ status: "completed" });
    await expect(sealDetachedAsyncToolGroup("event-1")).resolves.toEqual({
      parentEventId: "event-1", resultIds: ["result-1", "result-2"], sealed: true,
    });
    expect(queryMock).toHaveBeenCalledWith("getAsyncToolResult", { resultId: "result-1" });
  });
});
