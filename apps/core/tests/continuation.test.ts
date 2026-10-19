import { describe, expect, it } from "bun:test";
import {
  AGENT_PROCESSING_FAILED,
  turnSettlement,
  type ParentContinuationResult,
} from "../src/harness/continuation.ts";
import type { ToolApprovalSummary } from "../src/harness/harness.ts";
import type { PendingQuestionSummary } from "../src/harness/questions.ts";

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
