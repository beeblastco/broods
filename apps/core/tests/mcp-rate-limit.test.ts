/**
 * A remote MCP server's rate limit is waited out inside the tool call, so a
 * step's parallel searches do not each come back to the model as failures.
 */

import { afterEach, expect, it } from "bun:test";
import {
  callMcpTool,
  mcpConnection,
  setMcpForTests,
} from "../src/harness/mcp/client.ts";
import type { McpRecord } from "../src/shared/domain/mcp.ts";

const RATE_LIMITED =
  "Firecrawl 429: Rate limit exceeded. Consumed (req/min): 11, Remaining (req/min): 0. Upgrade your plan or please retry after 0.01s";

const record: McpRecord = {
  accountId: "acct_1",
  serverId: "mcp_1",
  projectId: "proj",
  stageId: "stage",
  name: "firecrawl",
  transport: "http",
  url: "https://mcp.example.com/mcp",
  status: "active",
  createdAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:00:00.000Z",
};

afterEach(() => setMcpForTests(null));

it("waits the asked time and retries a rate-limited call", async () => {
  let calls = 0;
  setMcpForTests({
    callTool: async () => {
      calls += 1;

      return calls < 3
        ? { isError: true, content: [{ type: "text", text: RATE_LIMITED }] }
        : { content: [{ type: "text", text: "found" }] };
    },
  });

  const result = await callMcpTool(mcpConnection(record, undefined), "search", {
    q: "x",
  });

  expect(result).toBe("found");
  expect(calls).toBe(3);
});

it("reads a wait given in words", async () => {
  let calls = 0;
  setMcpForTests({
    callTool: async () => {
      calls += 1;

      return calls < 2
        ? {
            isError: true,
            content: [
              { type: "text", text: "429: please retry after 0.01 seconds" },
            ],
          }
        : { content: [{ type: "text", text: "found" }] };
    },
  });
  const startedAt = Date.now();

  const result = await callMcpTool(mcpConnection(record, undefined), "search", {
    q: "x",
  });

  expect(result).toBe("found");
  expect(calls).toBe(2);
  // A wait read as 2s backoff instead of 10ms would show here.
  expect(Date.now() - startedAt).toBeLessThan(1_000);
});

it("fails the call once the retries are spent", async () => {
  let calls = 0;
  setMcpForTests({
    callTool: async () => {
      calls += 1;

      return { isError: true, content: [{ type: "text", text: RATE_LIMITED }] };
    },
  });

  await expect(
    callMcpTool(mcpConnection(record, undefined), "search", { q: "x" }),
  ).rejects.toThrow("Rate limit exceeded");
  expect(calls).toBe(4);
});

it("hands any other failure straight to the model", async () => {
  let calls = 0;
  setMcpForTests({
    callTool: async () => {
      calls += 1;

      return { isError: true, content: [{ type: "text", text: "boom" }] };
    },
  });

  await expect(
    callMcpTool(mcpConnection(record, undefined), "search", { q: "x" }),
  ).rejects.toThrow("boom");
  expect(calls).toBe(1);
});
