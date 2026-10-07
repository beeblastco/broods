// An MCP server on a lambda sandbox is one JSON-RPC request per POST /mcp to
// the reserved VM. These pin the body the sandbox image reads and how replies
// are checked; reaching the VM is the executor's, tested in sandbox-executor.

import { expect, test } from "bun:test";
import {
  sandboxMcpRequest,
  type SandboxMcpExecutor,
  type SandboxMcpTarget,
} from "../src/harness/mcp/sandbox.ts";

const TARGET: SandboxMcpTarget = {
  config: { provider: "lambda", persistent: true, timeout: 30 },
  reservation: { reservationKey: "agent-vm" },
  command: ["obscura", "mcp"],
};
const LIST = { method: "tools/list", params: {} };

test("posts the JSON-RPC request with the server's command and timeouts", async () => {
  const requests: unknown[] = [];
  const executor = answering(requests, {
    jsonrpc: "2.0",
    id: "1",
    result: { tools: [] },
  });

  const result = await sandboxMcpRequest(
    TARGET,
    "obscura",
    LIST,
    undefined,
    executor,
  );

  expect(result).toEqual({ tools: [] });
  expect(requests).toEqual([
    {
      reservationKey: "agent-vm",
      path: "/mcp",
      body: {
        server: "obscura",
        command: ["obscura", "mcp"],
        message: {
          jsonrpc: "2.0",
          id: expect.any(String),
          method: "tools/list",
          params: {},
        },
        timeout_ms: 30_000,
      },
      timeoutMs: 60_000,
      abortSignal: undefined,
    },
  ]);
});

test("throws the server's message on a JSON-RPC error", async () => {
  const executor = answering([], {
    jsonrpc: "2.0",
    id: "1",
    error: { code: -32000, message: "spawn obscura ENOENT" },
  });

  expect(
    await failure(
      sandboxMcpRequest(TARGET, "obscura", LIST, undefined, executor),
    ),
  ).toContain("MCP server obscura: spawn obscura ENOENT");
});

test("refuses a reply that is not JSON-RPC", async () => {
  const executor = answering([], { tools: [] });

  expect(
    await failure(
      sandboxMcpRequest(TARGET, "obscura", LIST, undefined, executor),
    ),
  ).toContain("answered with no JSON-RPC result");
});

test("names the server when the VM cannot be reached", async () => {
  const executor: SandboxMcpExecutor = {
    postReserved: async function (): Promise<unknown> {
      throw new Error("MicroVM /mcp failed (500): boom");
    },
  };

  expect(
    await failure(
      sandboxMcpRequest(TARGET, "obscura", LIST, undefined, executor),
    ),
  ).toContain("MCP server obscura on its sandbox failed: MicroVM /mcp failed");
});

test("gives a tool call 120 s on a sandbox with no timeout of its own", async () => {
  const requests: unknown[] = [];
  const executor: SandboxMcpExecutor = {
    postReserved: async function (request): Promise<unknown> {
      requests.push(request);

      return { jsonrpc: "2.0", id: "1", result: {} };
    },
  };

  await sandboxMcpRequest(
    { ...TARGET, config: { provider: "lambda", persistent: true } },
    "obscura",
    LIST,
    undefined,
    executor,
  );

  expect(requests[0]).toMatchObject({ body: { timeout_ms: 120_000 } });
});

test("refuses a sandbox whose executor has no MCP host", async () => {
  expect(
    await failure(
      sandboxMcpRequest(
        { ...TARGET, config: { provider: "sandbox", persistent: true } },
        "obscura",
        LIST,
        undefined,
        {},
      ),
    ),
  ).toContain(
    "MCP server obscura needs a lambda sandbox; sandbox has no MCP host",
  );
});

// An executor whose every POST answers `reply`, recording each request.
function answering(requests: unknown[], reply: unknown): SandboxMcpExecutor {
  return {
    postReserved: async function (request): Promise<unknown> {
      requests.push(request);

      return reply;
    },
  };
}

// The error a call fails with, or "resolved" when it does not fail.
function failure(call: Promise<unknown>): Promise<string> {
  return call.then(
    (): string => "resolved",
    (error: unknown): string => String(error),
  );
}
