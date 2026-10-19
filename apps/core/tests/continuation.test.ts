import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { AsyncToolCoordinator } from "../src/harness/async-tools.ts";
import {
  AGENT_PROCESSING_FAILED,
  runAgentLoopUntilSubagentsIdle,
  turnSettlement,
  type ParentContinuationResult,
} from "../src/harness/continuation.ts";
import * as harness from "../src/harness/harness.ts";
import type { ToolApprovalSummary } from "../src/harness/harness.ts";
import * as hookDispatcher from "../src/harness/hook-dispatcher.ts";
import type { SessionMessageResult } from "../src/harness/ingress.ts";
import type { PendingQuestionSummary } from "../src/harness/questions.ts";
import { Session } from "../src/harness/session.ts";
import { runtime } from "../src/shared/convex/runtime.ts";

const APPROVAL: ToolApprovalSummary = {
  approvalId: "approval_1",
  toolCallId: "call_1",
  toolName: "bash",
  input: { command: "rm -rf build" },
};
const QUESTION: PendingQuestionSummary = {
  statusId: "status_1",
  questions: [
    {
      id: "q1",
      header: "Region",
      question: "Which region?",
      options: [{ label: "eu" }, { label: "us" }],
    },
  ],
  answerBy: "2026-10-19T10:00:00.000Z",
};

/** A clean, answered turn; each case overrides the one field that changes the outcome. */
function completedTurn(
  overrides: Partial<ParentContinuationResult> = {},
): ParentContinuationResult {
  return {
    didFail: false,
    failureText: null,
    finalResponse: "done",
    approvals: [],
    questions: [],
    ...overrides,
  };
}

describe("turnSettlement", () => {
  it("fails the envelope with the loop's failure text, or the default", () => {
    expect(
      turnSettlement(completedTurn({ didFail: true, failureText: "boom" })),
    ).toEqual({ status: "failed", error: "boom" });
    expect(turnSettlement(completedTurn({ didFail: true }))).toEqual({
      status: "failed",
      error: AGENT_PROCESSING_FAILED,
    });
  });

  it("completes with the pending approvals as the result", () => {
    expect(turnSettlement(completedTurn({ approvals: [APPROVAL] }))).toEqual({
      status: "completed",
      result: { status: "awaiting_approval", approvals: [APPROVAL] },
    });
  });

  it("completes with the open questions as the result", () => {
    expect(turnSettlement(completedTurn({ questions: [QUESTION] }))).toEqual({
      status: "completed",
      result: { status: "awaiting_input", questions: [QUESTION] },
    });
  });

  it("completes with the final response, and without one when the turn had none", () => {
    expect(turnSettlement(completedTurn())).toEqual({
      status: "completed",
      result: "done",
    });
    expect(turnSettlement(completedTurn({ finalResponse: undefined }))).toEqual(
      { status: "completed" },
    );
  });
});

describe("runAgentLoopUntilSubagentsIdle", () => {
  afterEach(() => {
    mock.restore();
  });

  it("writes finished background tool results before it yields the slot", async () => {
    const order: string[] = [];
    spyOn(runtime, "mutate").mockResolvedValue(null);
    spyOn(runtime, "query").mockResolvedValue(null);
    spyOn(Session.prototype, "createTurnContext").mockResolvedValue({
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    });
    spyOn(
      AsyncToolCoordinator.prototype,
      "drainCompletionsToParent",
    ).mockImplementation(async (): Promise<number> => {
      order.push("drain tool results");

      return 0;
    });
    spyOn(hookDispatcher, "createAgentHookDispatcher").mockResolvedValue({
      hasHooksFor: (): boolean => false,
      runMutation: async (): Promise<Record<string, unknown>> => ({}),
    });
    let passes = 0;
    spyOn(harness, "runAgentLoop").mockImplementation((async () => {
      passes += 1;
      order.push(`pass ${passes}`);
      const yielded = passes === 1;

      return {
        traceId: (): undefined => undefined,
        consumeStream: async (): Promise<void> => {},
        questionSummaries: (): PendingQuestionSummary[] => [],
        didFail: (): boolean => false,
        yielded: (): boolean => yielded,
        failureText: (): null => null,
      };
    }) as never);
    const session = new Session({
      eventId: "event",
      conversationKey: "conversation",
      accountId: "acct",
      agentId: "agent",
      agentConfig: {},
    });

    await runAgentLoopUntilSubagentsIdle(
      session,
      await session.createTurnContext([]),
      {},
      {
        requestId: "request",
        deadlineMs: Date.now() + 60_000,
        waitUntil: (): void => {},
        yieldSlot: async (): Promise<void> => {
          order.push("yield slot");
        },
      },
      { onFinalText: async () => {}, onErrorText: async () => {} },
      {
        dispatchAppliedIngress: async () => {},
        dispatchSessionMessage: async (): Promise<SessionMessageResult> => ({
          conversationKey: "conversation",
          status: "accepted",
        }),
        subagents: {},
      },
    );

    expect(order.slice(0, 4)).toEqual([
      "pass 1",
      "drain tool results",
      "yield slot",
      "pass 2",
    ]);
  });
});
