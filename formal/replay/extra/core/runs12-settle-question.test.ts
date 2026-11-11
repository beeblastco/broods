import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { runtime } from "../../../../apps/core/src/shared/convex/runtime.ts";
import type { AsyncToolResultRecord } from "../../../../apps/core/src/harness/async-tool-result.ts";
import { settleQuestion } from "../../../../apps/core/src/harness/questions.ts";

const record: AsyncToolResultRecord = {
  resultId: "res_1",
  parentEventId: "event_1",
  conversationKey: "acct:a:agent:b:api:c",
  toolName: "ask_questions",
  toolCallId: "call_1",
  input: {},
  status: "processing",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: 0,
};

afterEach((): void => {
  spyOn(runtime, "mutate").mockRestore();
});

describe("settleQuestion", (): void => {
  test("completes the row with the answers, only while it is still processing", async (): Promise<void> => {
    const mutate = spyOn(runtime, "mutate").mockResolvedValue({
      ...record,
      status: "completed",
    });
    const answers = {
      status: "answered" as const,
      answers: { q1: ["yes"] },
    };

    const settled = await settleQuestion(record, answers);

    expect(settled).toMatchObject({ resultId: "res_1", status: "completed" });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith("updateAsyncToolResult", {
      resultId: "res_1",
      status: "completed",
      onlyWhenProcessing: true,
      response: answers,
    });
  });

  test("answers null when another writer settled the row first", async (): Promise<void> => {
    spyOn(runtime, "mutate").mockResolvedValue(null);

    expect(
      await settleQuestion(record, { status: "answered", answers: {} }),
    ).toBeNull();
  });
});
