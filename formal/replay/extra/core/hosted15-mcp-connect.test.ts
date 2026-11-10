import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  callMcpToolResult,
  listMcpTools,
  setMcpForTests,
} from "../../../../apps/core/src/harness/mcp/client.ts";
import {
  setHostedMcpSendBatchForTests,
  type HostedMcpResponse,
} from "../../../../apps/core/src/harness/mcp/hosted.ts";
import type { McpRecord } from "../../../../apps/core/src/shared/domain/mcp.ts";
import { getStorage } from "../../../../apps/core/src/shared/storage.ts";

interface Message {
  id?: number;
  method: string;
}

const savedEnv = { ...process.env };
const meter = spyOn(getStorage().budgets, "record");
const methods: string[] = [];

function hostedRecord(): McpRecord {
  return {
    accountId: "acct_test",
    serverId: "k57hosted00000000000000000000000",
    projectId: "proj",
    stageId: "stage",
    name: "hosted",
    transport: "hosted",
    bundleStorageKey: "account-mcp/acct_test/bundles/x.mjs",
    sha256: "a".repeat(64),
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function answer(body: string, ttlMs: number): HostedMcpResponse {
  const message: Message = JSON.parse(body);
  if (message.id === undefined) return { status: 202, headers: {}, body: "" };
  methods.push(message.method);
  const results: Record<string, object> = {
    "server/discover": {
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
    },
    "tools/list": {
      tools: [{ name: "query", inputSchema: { type: "object" } }],
    },
    "tools/call": { content: [{ type: "text", text: "done" }] },
  };

  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        resultType: "complete",
        ttlMs: ttlMs,
        cacheScope: "private",
        ...results[message.method],
      },
    }),
  };
}

function serve(ttlMs: number): void {
  setHostedMcpSendBatchForTests(
    async (
      _batch,
      requests,
    ): Promise<{
      outcomes: Map<string, HostedMcpResponse>;
      cpuUsec: undefined;
    }> => ({
      outcomes: new Map(
        requests.map((request): [string, HostedMcpResponse] => [
          request.id,
          answer(request.mcpRequest.body ?? "{}", ttlMs),
        ]),
      ),
      cpuUsec: undefined,
    }),
  );
}

beforeEach((): void => {
  process.env.MCP_BATCH_WINDOW_MS = "1";
  methods.length = 0;
  meter.mockImplementation(async (): Promise<void> => {});
});
afterEach((): void => {
  setHostedMcpSendBatchForTests(null);
  setMcpForTests(null);
  process.env = { ...savedEnv };
});
afterAll((): void => {
  meter.mockRestore();
});

describe("connecting to an MCP server", (): void => {
  test("a server row without a url cannot be reached", async (): Promise<void> => {
    const record: McpRecord = {
      ...hostedRecord(),
      transport: "http",
      name: "nourl",
    };

    await expect(listMcpTools({ record: record, headers: {} })).rejects.toThrow(
      "MCP server nourl has no url to connect to",
    );
  });

  test("an uncached connection discovers on every call", async (): Promise<void> => {
    serve(60_000);
    const connection = { record: hostedRecord(), headers: {}, uncached: true };

    await listMcpTools(connection);
    await listMcpTools(connection);

    expect(
      methods.filter((method): boolean => method === "server/discover"),
    ).toHaveLength(2);
  });

  test("an expired discover result is dropped and discovered again", async (): Promise<void> => {
    serve(1);
    const connection = {
      record: hostedRecord(),
      headers: {},
      agentId: "agent_1",
    };

    await listMcpTools(connection);
    await Bun.sleep(15);
    const result = await callMcpToolResult(connection, "query", {});

    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(
      methods.filter((method): boolean => method === "server/discover"),
    ).toHaveLength(2);
  });
});
