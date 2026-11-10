import { describe, expect, mock, test } from "bun:test";
import type { AuthContext } from "../../../../apps/core/src/shared/auth.ts";
import * as authModule from "../../../../apps/core/src/shared/auth.ts";
import * as runtimeModule from "../../../../apps/core/src/shared/convex/runtime.ts";
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

await mock.module("../../../../apps/core/src/shared/auth.ts", (): object => ({
  ...authModule,
  resolveBearerAuth: async (): Promise<AuthContext> => ({
    kind: "account",
    account: ACCOUNT,
  }),
}));
await mock.module(
  "../../../../apps/core/src/shared/convex/runtime.ts",
  (): object => ({
    ...runtimeModule,
    runtime: {
      ...runtimeModule.runtime,
      query: async (): Promise<null> => null,
      mutate: async (): Promise<null> => null,
    },
  }),
);

const { handleMcpRequest } =
  await import("../../../../apps/core/src/harness/mcp-tasks.ts");

type Replay = Parameters<typeof handleMcpRequest>[1];

function call(agentId: string): CoreRequest {
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
      "mcp-method": "tools/call",
      "mcp-name": agentId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: agentId,
        arguments: { prompt: "do it" },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": TASKS,
        },
      },
    }),
    cookies: [],
    clientIp: "127.0.0.1",
  } as CoreRequest;
}

function replayWith(started: Response, read: () => Promise<Response>): Replay {
  return async (request): Promise<Response> =>
    request.method === "POST" ? started : read();
}

async function answerOf(replay: Replay): Promise<unknown> {
  const response = await handleMcpRequest(call("agent_1"), replay);

  return JSON.parse(await response.text());
}

describe("starting a task through tools/call", (): void => {
  test("an unknown agent is an invalid-params error", async (): Promise<void> => {
    const answer = await answerOf(
      replayWith(
        new Response("{}", { status: 404 }),
        async (): Promise<Response> => new Response("{}"),
      ),
    );

    expect(JSON.stringify(answer)).toContain("Unknown tool: agent_1");
  });

  test("a refused run comes back as an error tool result", async (): Promise<void> => {
    const answer = await answerOf(
      replayWith(
        Response.json(
          { error: { message: "quota exceeded" } },
          { status: 429 },
        ),
        async (): Promise<Response> => new Response("{}"),
      ),
    );

    expect(JSON.stringify(answer)).toContain('"isError":true');
  });

  test("a started run whose first read fails is still a working task", async (): Promise<void> => {
    const answer = await answerOf(
      replayWith(
        Response.json({ runId: "run_9" }, { status: 202 }),
        async (): Promise<Response> => {
          throw new Error("read failed");
        },
      ),
    );

    expect(answer).toMatchObject({
      result: { resultType: "task", taskId: "run_9", status: "working" },
    });
  });
});
