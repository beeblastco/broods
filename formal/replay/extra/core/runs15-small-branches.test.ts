import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as asyncToolResults from "../../../../apps/core/src/harness/async-tool-result.ts";
import type { AsyncToolResultRecord } from "../../../../apps/core/src/harness/async-tool-result.ts";
import {
  completionToParentMessage,
  resumeLostAsyncToolResults,
} from "../../../../apps/core/src/harness/async-tools.ts";
import { prepareSessionMessage } from "../../../../apps/core/src/harness/ingress.ts";
import { refreshTokenGrant } from "../../../../apps/core/src/harness/mcp/oauth.ts";
import {
  openWorkAfterRun,
  type RunOpenWorkSources,
} from "../../../../apps/core/src/harness/questions.ts";
import { runtime } from "../../../../apps/core/src/shared/convex/runtime.ts";

const CONVERSATION = "acct:acct_1:agent:agent_1:api:chat";
const TOKEN_URL = "https://auth.example.test/token";

function questionRow(
  resultId: string,
  status: AsyncToolResultRecord["status"],
): AsyncToolResultRecord {
  return {
    resultId: resultId,
    parentEventId: "acct:acct_1:agent:agent_1:api:event_0",
    conversationKey: CONVERSATION,
    toolName: "ask_questions",
    toolCallId: `call_${resultId}`,
    input: {
      questions: [
        {
          id: "q1",
          header: "H",
          question: "Which?",
          options: [{ label: "a" }],
        },
      ],
      blocking: true,
      answerBy: new Date(Date.now() + 3_600_000).toISOString(),
    },
    status: status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: Date.now() + 3_600_000,
  };
}

function sources(overrides: Partial<RunOpenWorkSources>): RunOpenWorkSources {
  return {
    conversationKey: CONVERSATION,
    awaitingApproval: false,
    detachedResultIds: [],
    questionSummaries: [],
    ...overrides,
  };
}

function tokenFetch(body: string): () => Promise<Response> {
  return async (): Promise<Response> => new Response(body, { status: 200 });
}

afterEach((): void => {
  spyOn(runtime, "query").mockRestore();
  spyOn(asyncToolResults, "listOwedAsyncToolResults").mockRestore();
  spyOn(asyncToolResults, "markAsyncToolHandback").mockRestore();
});

describe("openWorkAfterRun", (): void => {
  function rowsByQuery(
    rows: Record<string, AsyncToolResultRecord | null>,
  ): void {
    spyOn(runtime, "query").mockImplementation(
      async (_name, args): Promise<unknown> => {
        const id = (args as { resultId: string }).resultId;
        if (rows[id] === undefined) throw new Error("lookup failed");

        return rows[id];
      },
    );
  }

  test("an open question row is a question the run waits on", async (): Promise<void> => {
    rowsByQuery({ res_1: questionRow("res_1", "processing") });

    const work = await openWorkAfterRun(
      sources({ detachedResultIds: ["res_1"] }),
    );

    expect(work.waitingOn).toBe("question");
    expect(work.questions.map((question): string => question.id)).toEqual([
      "q1",
    ]);
  });

  test("a summary whose row is gone still counts as unread", async (): Promise<void> => {
    rowsByQuery({ res_1: null });

    const work = await openWorkAfterRun(
      sources({
        detachedResultIds: ["res_1"],
        questionSummaries: [
          {
            statusId: "res_1",
            answerBy: "2026-01-01T00:00:00.000Z",
            questions: [
              {
                id: "q9",
                header: "H",
                question: "Q?",
                options: [{ label: "x" }],
              },
            ],
          },
        ],
      }),
    );

    expect(work.waitingOn).toBe("question");
    expect(work.questions.map((question): string => question.id)).toEqual([
      "q9",
    ]);
  });

  test("a failed lookup is no open work", async (): Promise<void> => {
    rowsByQuery({});

    expect(
      await openWorkAfterRun(sources({ detachedResultIds: ["res_1"] })),
    ).toEqual({
      questions: [],
    });
  });

  test("another kind of processing row leaves the run waiting on a tool", async (): Promise<void> => {
    rowsByQuery({
      job_1: { ...questionRow("job_1", "processing"), toolName: "job" },
    });

    expect(
      await openWorkAfterRun(sources({ detachedResultIds: ["job_1"] })),
    ).toEqual({
      waitingOn: "tool",
      questions: [],
    });
  });

  test("pending work is reported when no question is open", async (): Promise<void> => {
    const work = await openWorkAfterRun(
      sources({ pendingWork: (): "subagent" => "subagent" }),
    );

    expect(work).toEqual({ waitingOn: "subagent", questions: [] });
  });
});

describe("refreshTokenGrant", (): void => {
  test("refuses a token endpoint that does not answer JSON", async (): Promise<void> => {
    await expect(
      refreshTokenGrant(TOKEN_URL, {}, tokenFetch("<html>")),
    ).rejects.toThrow("token endpoint returned non-JSON");
  });

  test("refuses a response without an access token", async (): Promise<void> => {
    await expect(
      refreshTokenGrant(TOKEN_URL, {}, tokenFetch('{"access_token":""}')),
    ).rejects.toThrow("token response carries no access_token");
  });
});

describe("prepareSessionMessage input checks", (): void => {
  const base = {
    accountId: "acct_1",
    agentId: "agent_1",
    sourceConversationKey: CONVERSATION,
  };

  test("refuses an empty conversation or message", async (): Promise<void> => {
    await expect(
      prepareSessionMessage({
        ...base,
        input: { conversationKey: " ", message: "hi" },
      }),
    ).rejects.toThrow("Target conversation and message must not be empty");
    await expect(
      prepareSessionMessage({
        ...base,
        input: { conversationKey: "tg:1", message: "  " },
      }),
    ).rejects.toThrow("Target conversation and message must not be empty");
  });

  test("refuses an acct: key that names no agent", async (): Promise<void> => {
    await expect(
      prepareSessionMessage({
        ...base,
        input: { conversationKey: "acct:broken", message: "hi" },
      }),
    ).rejects.toThrow("Target conversation key is invalid");
  });
});

describe("lost async tool results", (): void => {
  test("a resume that throws keeps the row for the next pass", async (): Promise<void> => {
    const row = {
      ...questionRow("lost_1", "completed"),
      handback: "detached" as const,
    };
    spyOn(asyncToolResults, "listOwedAsyncToolResults").mockImplementation(
      async (
        options: Parameters<
          typeof asyncToolResults.listOwedAsyncToolResults
        >[0],
      ): ReturnType<typeof asyncToolResults.listOwedAsyncToolResults> => ({
        page:
          options.handback === "detached" && options.status === "completed"
            ? [row]
            : [],
        cursor: "end",
        isDone: true,
      }),
    );
    const marked = spyOn(
      asyncToolResults,
      "markAsyncToolHandback",
    ).mockResolvedValue(undefined);

    await resumeLostAsyncToolResults(async (): Promise<never> => {
      throw new Error("resume failed");
    });

    expect(marked).not.toHaveBeenCalled();
  });

  test("a string input is shown as is", (): void => {
    const text = (input: unknown): string => {
      const part = completionToParentMessage({
        resultId: "r1",
        toolName: "t",
        input: input,
        status: "failed",
        error: "x",
      }).content;

      return JSON.stringify(part);
    };

    expect(text("plain input")).toContain("Input:\\nplain input");
  });
});
