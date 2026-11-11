import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AuthContext } from "../../../../apps/core/src/shared/auth.ts";
import * as authModule from "../../../../apps/core/src/shared/auth.ts";
import * as runtimeModule from "../../../../apps/core/src/shared/convex/runtime.ts";
import type { RunStatus } from "../../../../apps/core/src/harness/mcp-tasks.ts";
import type { CoreRequest } from "../../../../apps/core/src/shared/http.ts";
import type { AccountRecord } from "../../../../apps/core/src/shared/domain/accounts.ts";

const ACCOUNT: AccountRecord = {
  accountId: "acct_1",
  username: "tester",
  secretHash: "hash",
  status: "active",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};
const CORE_DIR = `${import.meta.dir}/../../../../apps/core/src/harness`;
const { TASKS_EXTENSION_ID_V2 } = (await import(
  Bun.resolveSync("@modelcontextprotocol/ext-tasks/core/v2", CORE_DIR)
)) as { TASKS_EXTENSION_ID_V2: string };
const TASKS = { extensions: { [TASKS_EXTENSION_ID_V2]: {} } };
const DECLINED = "The user declined to answer.";

await mock.module("../../../../apps/core/src/shared/auth.ts", () => ({
  ...authModule,
  resolveBearerAuth: async (): Promise<AuthContext> => ({
    kind: "account",
    account: ACCOUNT,
  }),
}));
await mock.module("../../../../apps/core/src/shared/convex/runtime.ts", () => ({
  ...runtimeModule,
  runtime: {
    ...runtimeModule.runtime,
    query: async (): Promise<null> => null,
    mutate: async (): Promise<null> => null,
  },
}));

const { handleMcpRequest, taskFromRuns } =
  await import("../../../../apps/core/src/harness/mcp-tasks.ts");

interface Replay {
  posts: CoreRequest[];
  replay: (request: CoreRequest) => Promise<Response>;
}

function run(fields: Partial<RunStatus>): RunStatus {
  return {
    runId: "run_1",
    eventId: "mcp-1",
    agentId: "agent_1",
    conversationKey: "mcp-1",
    status: "processing",
    createdAt: "2026-11-01T00:00:00.000Z",
    lastUpdatedAt: "2026-11-01T00:00:00.000Z",
    ...fields,
  };
}

function replayOf(waiting: RunStatus): Replay {
  const posts: CoreRequest[] = [];

  return {
    posts: posts,
    replay: async (request): Promise<Response> => {
      if (request.method === "POST") {
        posts.push(request);

        return Response.json({ runId: "run_2" }, { status: 202 });
      }

      return Response.json(waiting);
    },
  };
}

function update(inputResponses: Record<string, unknown>): CoreRequest {
  return {
    method: "POST",
    path: "/mcp",
    search: "",
    query: new URLSearchParams(),
    headers: {
      authorization: "Bearer account",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tasks/update",
      "mcp-name": "run_1",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/update",
      params: {
        taskId: "run_1",
        inputResponses: inputResponses,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": TASKS,
        },
      },
    }),
    cookies: [],
    clientIp: "127.0.0.1",
  };
}

function prompt(
  statusId: string,
  questionId: string,
): NonNullable<RunStatus["questions"]>[number] {
  return {
    statusId: statusId,
    answerBy: "2026-11-02T00:00:00.000Z",
    questions: [
      {
        id: questionId,
        header: "Pick",
        question: `Which ${questionId}?`,
        options: [{ label: "Red" }, { label: "Blue" }],
      },
    ],
  };
}

async function answered(
  waiting: RunStatus,
  inputResponses: Record<string, unknown>,
): Promise<unknown[]> {
  const replay = replayOf(waiting);
  await handleMcpRequest(update(inputResponses), replay.replay);

  return replay.posts.map((post): unknown => JSON.parse(post.body));
}

afterEach((): void => {
  mock.restore();
});

describe("an approval waiting on a task", (): void => {
  test("is one form with a checkbox per tool call", (): void => {
    const task = taskFromRuns({
      root: run({}),
      current: run({
        status: "awaiting_approval",
        approvals: [
          {
            approvalId: "ap_1",
            toolCallId: "c1",
            toolName: "bash",
            input: { command: "ls" },
          },
          {
            approvalId: "ap_2",
            toolCallId: "c2",
            toolName: "write",
            input: { path: "a.txt" },
          },
        ],
      }),
    });

    expect(task).toMatchObject({
      status: "input_required",
      inputRequests: {
        "approval-run_1": {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "The agent wants to run these tools.",
            requestedSchema: {
              type: "object",
              properties: {
                ap_1: {
                  type: "boolean",
                  title: "Allow bash?",
                  description: '{"command":"ls"}',
                },
                ap_2: {
                  type: "boolean",
                  title: "Allow write?",
                  description: '{"path":"a.txt"}',
                },
              },
              required: ["ap_1", "ap_2"],
            },
          },
        },
      },
    });
  });
});

describe("answers sent through tasks/update", (): void => {
  test("each answered prompt is sent as one answer, a declined one as the decline note", async (): Promise<void> => {
    const waiting = run({
      status: "awaiting_input",
      questions: [
        prompt("q1", "color"),
        prompt("q2", "shade"),
        prompt("q3", "tone"),
      ],
    });

    const posts = await answered(waiting, {
      "question-q1": { action: "accept", content: { color: "Red" } },
      "question-q2": { action: "decline" },
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      agentId: "agent_1",
      conversationKey: "mcp-1",
      eventId: expect.stringMatching(/^mcp-[0-9a-f-]{36}$/),
      answers: [
        { statusId: "q1", answers: { color: ["Red"] } },
        { statusId: "q2", answers: { shade: [DECLINED] } },
      ],
    });
  });

  test("a value that is not text is sent as text, and an accept without it as a decline", async (): Promise<void> => {
    const waiting = run({
      status: "awaiting_input",
      questions: [
        {
          statusId: "q1",
          answerBy: "2026-11-02T00:00:00.000Z",
          questions: [
            {
              id: "count",
              header: "n",
              question: "How many?",
              options: [{ label: "1" }],
            },
            {
              id: "name",
              header: "n",
              question: "Name?",
              options: [{ label: "a" }],
            },
          ],
        },
      ],
    });

    const posts = await answered(waiting, {
      "question-q1": { action: "accept", content: { count: 3 } },
    });

    expect(posts[0]).toMatchObject({
      answers: [
        { statusId: "q1", answers: { count: ["3"], name: [DECLINED] } },
      ],
    });
  });

  test("responses that match no open prompt send nothing", async (): Promise<void> => {
    const waiting = run({
      status: "awaiting_input",
      questions: [prompt("q1", "color")],
    });

    expect(
      await answered(waiting, { "question-other": { action: "decline" } }),
    ).toEqual([]);
    expect(await answered(waiting, { "question-q1": "not a result" })).toEqual(
      [],
    );
  });
});
