/**
 * MCP Tasks server tests: how `/mcp` maps runs onto tasks, and how tool calls,
 * task updates and cancels replay through core's own run routes.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { TASKS_EXTENSION_ID_V2 } from "@modelcontextprotocol/ext-tasks/core/v2";
import type { AuthContext } from "../src/shared/auth.ts";
import * as authModule from "../src/shared/auth.ts";
import * as runtimeModule from "../src/shared/convex/runtime.ts";
import type { AgentRecord } from "../src/shared/domain/agents.ts";
import type { RunStatus } from "../src/harness/mcp-tasks.ts";
import type { CoreRequest } from "../src/shared/http.ts";
import type { AccountRecord } from "../src/shared/domain/accounts.ts";
import {
  setStorageForTests,
  type AgentScope,
  type Storage,
} from "../src/shared/storage.ts";

const ACCOUNT: AccountRecord = {
  accountId: "acct_1",
  username: "tester",
  secretHash: "hash",
  status: "active",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};
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

beforeEach((): void => {
  setStorageForTests({
    agents: {
      listForAccount: async (): Promise<AgentRecord[]> => [
        agent("agent_1", true),
      ],
      listForEndpoint: async (): Promise<AgentRecord[]> => [
        agent("agent_1", true),
      ],
    },
  } as StorageStubs as Storage);
});

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
    expect(at({ status: "completed" })).toMatchObject({
      result: {
        content: [{ type: "text", text: "" }, { type: "text" }],
        isError: false,
      },
    });
    expect(at({ status: "completed", response: "done" })).toMatchObject({
      status: "completed",
      result: {
        content: [{ type: "text", text: "done" }, { type: "text" }],
        isError: false,
      },
    });
    expect(at({ status: "failed", error: "boom" })).toMatchObject({
      status: "completed",
      result: { content: [{ type: "text", text: "boom" }], isError: true },
    });
    expect(at({ status: "completed", error: "lost" })).toMatchObject({
      status: "completed",
      result: { content: [{ type: "text", text: "lost" }], isError: true },
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
        scopes: async (): Promise<Map<string, AgentScope>> => new Map(),
      },
    };
    setStorageForTests(stubs as Storage);
    const ids = async (token: string): Promise<string[]> =>
      (await listedAgents({}, token)).map(({ id }) => id);

    expect(await ids("account")).toEqual(["private", "public"]);
    expect(await ids("frontend")).toEqual(["public"]);
  });

  it("lists each agent with its project and stage, and filters by them", async () => {
    setStorageForTests(twoStages() as Storage);

    expect(await listedAgents({})).toEqual([
      {
        name: "support",
        description: "Answers tickets.",
        project: "shop",
        stage: "production",
        id: "agent_prod",
      },
      {
        name: "support",
        project: "shop",
        stage: "development",
        id: "agent_dev",
      },
    ]);
    expect(
      (await listedAgents({ stage: "Development" })).map(({ id }) => id),
    ).toEqual(["agent_dev"]);
  });

  it("asks an agent by name, and asks for an id when the name repeats", async () => {
    setStorageForTests({
      agents: {
        ...twoStages().agents,
        listForAccount: async (): Promise<AgentRecord[]> => [
          { ...agent("agent_1", true), name: "Help Desk" },
        ],
      },
    } as StorageStubs as Storage);
    const replay = replayOf({ run_1: run({ runId: "run_1" }) });
    await rpc(
      mcpRequest("tools/call", {
        name: "ask_agent",
        arguments: { agent: "help desk", prompt: "hi" },
      }),
      replay,
    );

    expect(JSON.parse(replay.posts[0]!.body).agentId).toBe("agent_1");

    setStorageForTests(twoStages() as Storage);
    const repeated = await rpc(
      mcpRequest("tools/call", {
        name: "ask_agent",
        arguments: { agent: "support", prompt: "hi" },
      }),
      replayOf({}),
    );

    expect(repeated.result).toMatchObject({
      isError: true,
      content: [
        {
          text: "2 agents are named support. Pass one of these ids as agent: agent_prod (project shop, stage production), agent_dev (project shop, stage development).",
        },
      ],
    });
  });

  it("points a caller with an unknown agent or tool at list_agents", async () => {
    const unknownAgent = await rpc(
      mcpRequest("tools/call", {
        name: "ask_agent",
        arguments: { agent: "gone", prompt: "hi" },
      }),
      replayOf({}),
    );
    const unknownTool = await rpc(
      mcpRequest("tools/call", { name: "gone", arguments: { prompt: "hi" } }),
      replayOf({}),
    );

    expect(JSON.stringify(unknownAgent.result)).toContain(
      "No agent named gone. Call list_agents",
    );
    expect(JSON.stringify(unknownTool.error)).toContain(
      "No tool named gone. Call list_agents to see the agents, then ask_agent to run one.",
    );
  });

  it("answers directly when the client does not declare tasks", async () => {
    const replay = replayOf({
      run_1: run({
        runId: "run_1",
        status: "completed",
        response: "done",
        conversationKey: "conv_1",
      }),
    });
    const { result } = await rpc(
      mcpRequest(
        "tools/call",
        { name: "ask_agent", arguments: { agent: "agent_1", prompt: "hi" } },
        { capabilities: {} },
      ),
      replay,
    );

    expect(result).toMatchObject({
      resultType: "complete",
      isError: false,
      content: [{ text: "done" }, { text: expect.stringContaining("conv_1") }],
    });
  });

  it("hands back the run id when a read fails after the run started", async () => {
    const replay = replayOf({});
    const { result } = await rpc(
      mcpRequest(
        "tools/call",
        { name: "ask_agent", arguments: { agent: "agent_1", prompt: "hi" } },
        { capabilities: {} },
      ),
      {
        ...replay,
        replay: async (request): Promise<Response> =>
          request.method === "POST"
            ? await replay.replay(request)
            : Response.json({ error: { message: "down" } }, { status: 503 }),
      },
    );

    expect(replay.posts).toHaveLength(1);
    expect(JSON.stringify(result)).toContain('runId \\"run_1\\"');
  });

  it("refuses answers that leave a question of the prompt open", async () => {
    const replay = replayOf({
      run_1: run({
        runId: "run_1",
        status: "awaiting_input",
        questions: [
          {
            statusId: "status_1",
            answerBy: "2026-11-10T00:00:00.000Z",
            questions: ["color", "size"].map((id) => ({
              id: id,
              header: id,
              question: `Which ${id}?`,
              options: [{ label: "A" }],
            })),
          },
        ],
      }),
    });
    const { result } = await rpc(
      mcpRequest(
        "tools/call",
        {
          name: "continue_run",
          arguments: { runId: "run_1", answers: { color: "A" } },
        },
        { capabilities: {} },
      ),
      replay,
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: "Answer these questions too: size" }],
    });
    expect(replay.posts).toHaveLength(0);
  });

  it("lists continue_run only for a client without tasks", async () => {
    const names = async (capabilities: object): Promise<string[]> => {
      const { result } = await rpc(
        mcpRequest("tools/list", {}, { capabilities: capabilities }),
        replayOf({}),
      );

      return (result as { tools: { name: string }[] }).tools.map(
        ({ name }) => name,
      );
    };

    expect(await names({})).toEqual([
      "list_agents",
      "ask_agent",
      "continue_run",
    ]);
    expect(await names(TASKS)).toEqual(["list_agents", "ask_agent"]);
  });

  it("tells a client without tasks what the agent asked and takes its answer", async () => {
    const question = {
      statusId: "status_1",
      answerBy: "2026-11-10T00:00:00.000Z",
      questions: [
        {
          id: "color",
          header: "Color",
          question: "Which color?",
          options: [{ label: "Blue" }],
        },
      ],
    };
    const replay = replayOf({
      run_1: run({
        runId: "run_1",
        status: "awaiting_input",
        questions: [question],
      }),
      run_2: run({ runId: "run_2", status: "completed", response: "Blue" }),
    });
    const asked = await rpc(
      mcpRequest(
        "tools/call",
        { name: "ask_agent", arguments: { agent: "agent_1", prompt: "hi" } },
        { capabilities: {} },
      ),
      replay,
    );

    expect(JSON.stringify(asked.result)).toContain("color: Which color?");
    expect(JSON.stringify(asked.result)).toContain("continue_run");

    const continued = await rpc(
      mcpRequest(
        "tools/call",
        {
          name: "continue_run",
          arguments: { runId: "run_1", answers: { color: "Blue" } },
        },
        { capabilities: {} },
      ),
      {
        ...replay,
        replay: async (request): Promise<Response> => {
          if (request.method === "POST") {
            approvalReplies.set(
              "acct:acct_1:agent:agent_1:api:mcp-1:async-tools:status_1",
              "run_2",
            );
          }

          return await replay.replay(request);
        },
      },
    );

    expect(JSON.stringify(continued.result)).toContain("Blue");

    expect(JSON.parse(replay.posts.at(-1)!.body).answers).toEqual([
      { statusId: "status_1", answers: { color: ["Blue"] } },
    ]);
  });

  it("never lets a client without tasks approve a tool call", async () => {
    const { result } = await rpc(
      mcpRequest(
        "tools/call",
        { name: "ask_agent", arguments: { agent: "agent_1", prompt: "hi" } },
        { capabilities: {} },
      ),
      replayOf({
        run_1: run({
          runId: "run_1",
          status: "awaiting_approval",
          approvals: [
            {
              approvalId: "approval_1",
              toolCallId: "call_1",
              toolName: "bash",
              input: { command: "ls" },
            },
          ],
        }),
      }),
    );

    expect(JSON.stringify(result)).toContain("you cannot approve them");
  });

  it("hands a bad argument back as a tool error the model can fix", async () => {
    const { result } = await rpc(
      mcpRequest("tools/call", {
        name: "ask_agent",
        arguments: { agent: "agent_1" },
      }),
      replayOf({}),
    );

    expect(result).toMatchObject({ isError: true });
  });

  it("continues a conversation the caller names", async () => {
    const replay = replayOf({ run_1: run({ runId: "run_1" }) });
    await rpc(
      mcpRequest("tools/call", {
        name: "ask_agent",
        arguments: {
          agent: "agent_1",
          prompt: "more",
          conversationId: "conv_1",
        },
      }),
      replay,
    );

    expect(JSON.parse(replay.posts[0]!.body).conversationKey).toBe("conv_1");
  });

  it("starts a background run in a fresh conversation and answers its task", async () => {
    const replay = replayOf({ run_1: run({ runId: "run_1" }) });
    const { result } = await rpc(
      mcpRequest("tools/call", {
        name: "ask_agent",
        arguments: { agent: "agent_1", prompt: "hi" },
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

  it("refuses a tasks/update without a map of responses", async () => {
    const replay = replayOf({
      run_1: run({ status: "awaiting_input", questions: [] }),
    });
    const codes = [];
    for (const extra of [{}, { inputResponses: 42 }, { inputResponses: {} }]) {
      const { error } = await rpc(
        mcpRequest("tasks/update", { taskId: "run_1", ...extra }),
        replay,
      );
      codes.push(error?.code);
    }

    expect(codes).toEqual([-32602, -32602, -32602]);
    expect(replay.posts).toEqual([]);
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
          "approval-run_1": { action: "accept", content: { ap_1: true } },
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
      result: { content: [{ type: "text", text: "listed" }, { type: "text" }] },
    });
  });

  it("follows an answered question to the run that continues it", async () => {
    const replay = replayOf({
      run_1: run({
        runId: "run_1",
        eventId: "mcp-1",
        status: "awaiting_input",
        questions: [
          {
            statusId: "q1",
            answerBy: "2026-11-02T00:00:00.000Z",
            questions: [],
          },
        ],
      }),
      run_2: run({ runId: "run_2", status: "completed", response: "Blue" }),
    });
    approvalReplies.set(
      "acct:acct_1:agent:agent_1:api:mcp-1:async-tools:q1",
      "run_2",
    );
    const { result } = await rpc(
      mcpRequest("tasks/get", { taskId: "run_1" }),
      replay,
    );

    expect(result).toMatchObject({
      taskId: "run_1",
      status: "completed",
      result: { content: [{ type: "text", text: "Blue" }, { type: "text" }] },
    });
  });

  it("reports a refused status read as an error, not a missing task", async () => {
    const { error } = await rpc(mcpRequest("tasks/get", { taskId: "run_1" }), {
      posts: [],
      replay: async (): Promise<Response> =>
        Response.json({ error: { message: "Slow down" } }, { status: 429 }),
    });

    expect(error?.code).toBe(-32603);
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

  it("stops nothing when the task already finished", async () => {
    await rpc(
      mcpRequest("tasks/cancel", { taskId: "run_1" }),
      replayOf({ run_1: run({ runId: "run_1", status: "completed" }) }),
    );

    expect(stops).toEqual([]);
  });

  it("answers an unknown task with invalid params", async () => {
    const { error } = await rpc(
      mcpRequest("tasks/get", { taskId: "run_missing" }),
      replayOf({}),
    );

    expect(error?.code).toBe(-32602);
  });
});

interface ListedAgent {
  name: string;
  description?: string;
  project?: string;
  stage?: string;
  id: string;
}

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

async function listedAgents(
  filter: { project?: string; stage?: string },
  token = "account",
): Promise<ListedAgent[]> {
  const { result } = await rpc(
    mcpRequest(
      "tools/call",
      { name: "list_agents", arguments: filter },
      { token: token },
    ),
    replayOf({}),
  );
  const [content] = (result as { content: { text: string }[] }).content;

  return (JSON.parse(content!.text) as { agents: ListedAgent[] }).agents;
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
): Promise<{ result?: unknown; error?: { code: number; message?: string } }> {
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

/** One account whose `support` agent runs in two stages of one project. */
function twoStages(): StorageStubs {
  return {
    agents: {
      listForAccount: async (): Promise<AgentRecord[]> => [
        {
          ...agent("agent_prod", true),
          name: "support",
          description: "Answers tickets.",
        },
        { ...agent("agent_dev", true), name: "support" },
      ],
      scopes: async (): Promise<Map<string, AgentScope>> =>
        new Map([
          ["agent_prod", { project: "shop", stage: "production" }],
          ["agent_dev", { project: "shop", stage: "development" }],
        ]),
    },
  };
}
