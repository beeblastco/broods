import { afterEach, describe, expect, it, mock } from "bun:test";
import { TASKS_EXTENSION_ID_V2 } from "@modelcontextprotocol/ext-tasks/core/v2";
import type { AuthContext } from "../src/shared/auth.ts";
import * as authModule from "../src/shared/auth.ts";
import * as runtimeModule from "../src/shared/convex/runtime.ts";
import type { AgentRecord } from "../src/shared/domain/agents.ts";
import type { CoreRequest } from "../src/shared/http.ts";
import type { AccountRecord } from "../src/shared/domain/accounts.ts";
import { setStorageForTests, type Storage } from "../src/shared/storage.ts";

const ACCOUNT = { accountId: "acct_1" } as AccountRecord;
const CREDENTIALS: Record<string, AuthContext> = {
  account: { kind: "account", account: ACCOUNT },
  frontend: {
    kind: "deployment",
    account: ACCOUNT,
    endpointId: "env_1",
    projectSlug: "demo",
    stageSlug: "dev",
  },
};
const TASKS = { extensions: { [TASKS_EXTENSION_ID_V2]: {} } };
type StorageStubs = { [Store in keyof Storage]?: Partial<Storage[Store]> };
const stops: unknown[] = [];
const approvalReplies = new Map<string, string>();

await mock.module("../src/shared/auth.ts", () => ({
  ...authModule,
  resolveBearerAuth: async (
    headers: Record<string, string>,
  ): Promise<AuthContext | null> =>
    CREDENTIALS[headers.authorization?.replace("Bearer ", "") ?? ""] ?? null,
}));
await mock.module("../src/shared/convex/runtime.ts", () => ({
  ...runtimeModule,
  runtime: {
    ...runtimeModule.runtime,
    query: async (
      name: string,
      args: { eventId: string },
    ): Promise<unknown> => {
      expect(name).toBe("getIngressStatusByEventId");
      const runId = approvalReplies.get(args.eventId);

      return runId ? { runId: runId } : null;
    },
    mutate: async (name: string, args: unknown): Promise<unknown> => {
      stops.push([name, args]);

      return { stopped: true, queuedCount: 0 };
    },
  },
}));

const { handleMcpRequest, taskFromRuns } =
  await import("../src/harness/mcp-tasks.ts");
type RunStatus = Parameters<typeof taskFromRuns>[0]["root"];

afterEach((): void => {
  stops.length = 0;
  approvalReplies.clear();
  setStorageForTests(null);
});

describe("taskFromRuns", () => {
  it("maps every run status onto a task", () => {
    const at = (fields: Partial<RunStatus>): ReturnType<typeof taskFromRuns> =>
      taskFromRuns({ root: run({}), current: run(fields) });

    for (const status of ["accepted", "queued", "processing"] as const) {
      expect(at({ status: status }).status).toBe("working");
    }
    expect(at({ status: "completed", response: "done" })).toMatchObject({
      status: "completed",
      result: { content: [{ type: "text", text: "done" }], isError: false },
    });
    expect(at({ status: "failed", error: "boom" })).toMatchObject({
      status: "completed",
      result: { content: [{ type: "text", text: "boom" }], isError: true },
    });
    expect(at({ status: "expired" })).toMatchObject({
      status: "completed",
      result: { isError: true },
    });
    expect(at({ status: "failed", stoppedByUser: true }).status).toBe(
      "cancelled",
    );
  });

  it("asks each open prompt as one form with its options as an enum", () => {
    const task = taskFromRuns({
      root: run({}),
      current: run({
        status: "awaiting_input",
        questions: [
          {
            statusId: "q1",
            answerBy: "2026-11-02T00:00:00.000Z",
            questions: [
              {
                id: "color",
                header: "Color",
                question: "Which color?",
                options: [{ label: "Red" }, { label: "Blue" }],
              },
            ],
          },
        ],
      }),
    });

    expect(task).toMatchObject({
      status: "input_required",
      inputRequests: {
        "question-q1": {
          method: "elicitation/create",
          params: {
            requestedSchema: {
              properties: { color: { enum: ["Red", "Blue"] } },
              required: ["color"],
            },
          },
        },
      },
    });
  });

  it("takes its id and start from the first run and its state from the last", () => {
    const task = taskFromRuns({
      root: run({ runId: "run_root", createdAt: "2026-11-01T00:00:00.000Z" }),
      current: run({
        runId: "run_reply",
        status: "completed",
        response: "ok",
        lastUpdatedAt: "2026-11-01T00:05:00.000Z",
      }),
    });

    expect(task).toMatchObject({
      taskId: "run_root",
      createdAt: "2026-11-01T00:00:00.000Z",
      lastUpdatedAt: "2026-11-01T00:05:00.000Z",
      status: "completed",
    });
  });
});

describe("handleMcpRequest", () => {
  it("refuses a request with no credential", async () => {
    const response = await handleMcpRequest(
      mcpRequest("tools/list", {}, { token: "" }),
      replayOf({}).replay,
    );

    expect(response.status).toBe(401);
  });

  it("lists every agent for an account key and only public ones for the frontend key", async () => {
    const stubs: StorageStubs = {
      agents: {
        listForAccount: async (): Promise<AgentRecord[]> => [
          agent("private", false),
          agent("public", true),
        ],
        listForEndpoint: async (): Promise<AgentRecord[]> => [
          agent("private", false),
          agent("public", true),
        ],
      },
    };
    setStorageForTests(stubs as Storage);
    const names = async (token: string): Promise<string[]> => {
      const { result } = await rpc(
        mcpRequest("tools/list", {}, { token: token }),
        replayOf({}),
      );

      return (result as { tools: { name: string }[] }).tools.map(
        (tool) => tool.name,
      );
    };

    expect(await names("account")).toEqual(["private", "public"]);
    expect(await names("frontend")).toEqual(["public"]);
  });

  it("refuses a tool call from a client that does not declare tasks", async () => {
    const { error } = await rpc(
      mcpRequest(
        "tools/call",
        { name: "agent_1", arguments: { prompt: "hi" } },
        { capabilities: {} },
      ),
      replayOf({}),
    );

    expect(error?.code).toBe(-32021);
  });

  it("starts a background run in a fresh conversation and answers its task", async () => {
    const replay = replayOf({ run_1: run({ runId: "run_1" }) });
    const { result } = await rpc(
      mcpRequest("tools/call", {
        name: "agent_1",
        arguments: { prompt: "hi" },
      }),
      replay,
    );

    expect(result).toMatchObject({
      resultType: "task",
      taskId: "run_1",
      status: "working",
    });
    const started = JSON.parse(replay.posts[0]!.body);
    expect(started).toMatchObject({
      agentId: "agent_1",
      background: true,
      events: [{ role: "user", content: "hi" }],
    });
    expect(started.conversationKey).toBe(started.eventId);
  });

  it("follows an approval reply sent through tasks/update", async () => {
    const waiting = run({
      runId: "run_1",
      eventId: "mcp-1",
      status: "awaiting_approval",
      approvals: [
        {
          approvalId: "ap_1",
          toolCallId: "call_1",
          toolName: "bash",
          input: { command: "ls" },
        },
      ],
    });
    const replay = replayOf({
      run_1: waiting,
      run_2: run({ runId: "run_2", status: "completed", response: "listed" }),
    });
    await rpc(
      mcpRequest("tasks/update", {
        taskId: "run_1",
        inputResponses: {
          "approval-ap_1": { action: "accept", content: { allow: true } },
        },
      }),
      replay,
    );

    const reply = JSON.parse(replay.posts[0]!.body);
    expect(reply).toMatchObject({
      eventId: "mcp-1:approval",
      conversationKey: "mcp-1",
      events: [
        {
          role: "tool",
          content: [
            {
              type: "tool-approval-response",
              approvalId: "ap_1",
              approved: true,
            },
          ],
        },
      ],
    });

    approvalReplies.set(
      "acct:acct_1:agent:agent_1:api:mcp-1:approval",
      "run_2",
    );
    const { result } = await rpc(
      mcpRequest("tasks/get", { taskId: "run_1" }),
      replay,
    );
    expect(result).toMatchObject({
      taskId: "run_1",
      status: "completed",
      result: { content: [{ type: "text", text: "listed" }] },
    });
  });

  it("stops the task's conversation on cancel", async () => {
    await rpc(
      mcpRequest("tasks/cancel", { taskId: "run_1" }),
      replayOf({ run_1: run({ runId: "run_1", conversationKey: "mcp-1" }) }),
    );

    expect(stops).toEqual([
      [
        "stopIngressOwner",
        {
          accountId: "acct_1",
          agentId: "agent_1",
          conversationKey: "acct:acct_1:agent:agent_1:api:mcp-1",
        },
      ],
    ]);
  });

  it("answers an unknown task with invalid params", async () => {
    const { error } = await rpc(
      mcpRequest("tasks/get", { taskId: "run_missing" }),
      replayOf({}),
    );

    expect(error?.code).toBe(-32602);
  });
});

interface FakeReplay {
  posts: CoreRequest[];
  replay: (request: CoreRequest) => Promise<Response>;
}

function agent(agentId: string, publicAccess: boolean): AgentRecord {
  return {
    accountId: "acct_1",
    agentId: agentId,
    name: agentId,
    config: { publicAccess: publicAccess },
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  } as AgentRecord;
}

function mcpRequest(
  method: string,
  params: Record<string, unknown>,
  options: { token?: string; capabilities?: object } = {},
): CoreRequest {
  const name =
    typeof params.taskId === "string"
      ? params.taskId
      : typeof params.name === "string"
        ? params.name
        : undefined;

  return {
    method: "POST",
    path: "/mcp",
    search: "",
    query: new URLSearchParams(),
    headers: {
      authorization: `Bearer ${options.token ?? "account"}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities":
            options.capabilities ?? TASKS,
        },
      },
    }),
    cookies: [],
    clientIp: "127.0.0.1",
  };
}

/** Core's run routes over a fixed set of runs; every POST is recorded. */
function replayOf(runs: Record<string, RunStatus>): FakeReplay {
  const posts: CoreRequest[] = [];

  return {
    posts: posts,
    replay: async (request): Promise<Response> => {
      if (request.method === "POST") {
        posts.push(request);

        return Response.json({ runId: "run_1" }, { status: 202 });
      }
      const found = runs[request.path.split("/").at(-1) ?? ""];

      return found
        ? Response.json(found)
        : Response.json({ error: { message: "No run" } }, { status: 404 });
    },
  };
}

async function rpc(
  request: CoreRequest,
  replay: FakeReplay,
): Promise<{ result?: unknown; error?: { code: number } }> {
  const response = await handleMcpRequest(request, replay.replay);

  return (await response.json()) as {
    result?: unknown;
    error?: { code: number };
  };
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
