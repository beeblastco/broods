import { afterEach, expect, it, mock } from "bun:test";
import type { Tool as McpTool } from "@modelcontextprotocol/client";
import type { Tool } from "ai";
import {
  listMcpTools,
  mcpConnection,
  setMcpForTests,
} from "../src/harness/mcp/client.ts";
import { mcpTools } from "../src/harness/mcp/mcp.tool.ts";
import type { McpRecord } from "../src/shared/domain/mcp.ts";
import * as httpModule from "../src/shared/http.ts";

type Answer = "ok" | "mismatch" | "input" | "structured" | "region";

const WRITE: McpTool = { name: "write", inputSchema: { type: "object" } };
const REGION: McpTool = {
  name: "write",
  inputSchema: {
    type: "object",
    properties: { region: { type: "string", "x-mcp-header": "Region" } },
  },
};
const COUNT: McpTool = {
  name: "write",
  inputSchema: { type: "object" },
  outputSchema: {
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
  },
};
const record: McpRecord = {
  accountId: "acct_1",
  serverId: "mcp_1",
  projectId: "proj",
  stageId: "stage",
  name: "server",
  transport: "http",
  url: "https://mcp.example.com/mcp",
  status: "active",
  createdAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:00:00.000Z",
};

let answer: Answer = "ok";
let listed: McpTool = WRITE;
let toolCalls = 0;
let toolLists = 0;

await mock.module("../src/shared/http.ts", () => ({
  ...httpModule,
  publicHostFetch: async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as {
      id?: number;
      method: string;
    };
    if (body.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: object): Response =>
      Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { resultType: "complete", ...result },
      });
    if (body.method === "server/discover") {
      return reply({
        ttlMs: 0,
        cacheScope: "private",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
      });
    }
    if (body.method === "tools/list") {
      toolLists += 1;

      return reply({ ttlMs: 0, cacheScope: "private", tools: [listed] });
    }
    toolCalls += 1;
    const region = new Headers(init?.headers).get("mcp-param-region");
    if (
      (answer === "mismatch" && toolCalls === 1) ||
      (answer === "region" && region !== "eu")
    ) {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32020, message: "header mismatch" },
        },
        { status: 400 },
      );
    }
    if (answer === "input") {
      return reply({ resultType: "input_required", requestState: "state" });
    }

    if (answer === "structured") {
      return reply({ content: [], structuredContent: { count: "three" } });
    }

    return reply({ content: [{ type: "text", text: "done" }] });
  },
}));

afterEach((): void => {
  setMcpForTests(null);
  answer = "ok";
  listed = WRITE;
  toolCalls = 0;
  toolLists = 0;
});

it("answers a normal call with one tools/call", async () => {
  expect(await callWrite()).toBe("done");
  expect(toolCalls).toBe(1);
  expect(toolLists).toBe(0);
});

it("does not resend tools/call after a header mismatch", async () => {
  answer = "mismatch";

  await expect(callWrite()).rejects.toThrow("header mismatch");
  expect(toolCalls).toBe(1);
  expect(toolLists).toBe(0);
});

it("stops resending an input_required call after ten rounds", async () => {
  answer = "input";

  await expect(callWrite()).rejects.toThrow("after 10 rounds");
  expect(toolCalls).toBe(11);
}, 10_000);

it("returns a result that does not match the tool's own outputSchema", async () => {
  answer = "structured";

  expect(await callWrite(COUNT)).toEqual({ count: "three" });
  expect(toolCalls).toBe(1);
});

it("lists again after a header mismatch and then sends the new headers", async () => {
  answer = "region";
  const connection = mcpConnection(record, undefined);
  const [stale] = await listMcpTools(connection);
  listed = REGION;

  await expect(callWrite(stale, { region: "eu" })).rejects.toThrow(
    "header mismatch",
  );
  const [fresh] = await listMcpTools(connection);
  expect(toolLists).toBe(2);
  expect(await callWrite(fresh, { region: "eu" })).toBe("done");
});

async function callWrite(
  definition: McpTool = WRITE,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  const tools = mcpTools(mcpConnection(record, undefined), [definition]);
  const write: Tool<Record<string, unknown>> | undefined = tools.server__write;

  return await write?.execute?.(input, {
    toolCallId: "call-1",
    messages: [],
    context: {},
  });
}
