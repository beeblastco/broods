// An MCP server on a lambda sandbox is one POST /mcp per request to the
// reserved VM. These pin the wire shape the sandbox image reads, the warm-up
// retry, and how a JSON-RPC error surfaces.

import { afterEach, expect, test } from "bun:test";
import {
  sandboxMcpRequest,
  type SandboxMcpExecutor,
} from "../src/harness/mcp/sandbox.ts";
import type { SandboxExecutorConfig } from "../src/harness/sandbox/types.ts";

const originalFetch = globalThis.fetch;

const SANDBOX: SandboxExecutorConfig = {
  provider: "lambda",
  persistent: true,
  timeout: 30,
  options: { reservationKey: "acct:web" },
};
const SERVER = { name: "obscura", command: ["obscura", "mcp"] };
const LIST = { method: "tools/list", params: {} };

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("posts one JSON-RPC request to the reserved VM and returns its result", async () => {
  const reservations: unknown[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  stubFetch(async (url, init) => {
    requests.push({ url: url, init: init });

    return requests.length === 1
      ? new Response("warming", { status: 503 })
      : Response.json({ jsonrpc: "2.0", id: "1", result: { tools: [] } });
  });

  const result = await sandboxMcpRequest(
    SANDBOX,
    SERVER,
    LIST,
    fakeExecutor(reservations),
  );

  expect(result).toEqual({ tools: [] });
  expect(reservations).toEqual([{ reservationKey: "acct:web", shared: true }]);
  expect(requests).toHaveLength(2);
  expect(requests[1]!.url).toBe("https://vm.example.com/mcp");
  expect(requests[1]!.init.headers).toEqual({
    "content-type": "application/json",
    "X-aws-proxy-auth": "token-mvm-1-8080",
    "X-aws-proxy-port": "8080",
  });
  const body = JSON.parse(String(requests[1]!.init.body));
  expect(body).toMatchObject({
    server: "obscura",
    command: ["obscura", "mcp"],
    message: { jsonrpc: "2.0", method: "tools/list", params: {} },
    timeout_ms: 30_000,
  });
  expect(typeof body.message.id).toBe("string");
});

test("throws the server's message on a JSON-RPC error", async () => {
  stubFetch(async () =>
    Response.json({
      jsonrpc: "2.0",
      id: "1",
      error: { code: -32000, message: "spawn obscura ENOENT" },
    }),
  );

  await expect(
    sandboxMcpRequest(SANDBOX, SERVER, LIST, fakeExecutor([])),
  ).rejects.toThrow("MCP server obscura: spawn obscura ENOENT");
});

test("refuses a sandbox that is not persistent", async () => {
  await expect(
    sandboxMcpRequest({ provider: "lambda" }, SERVER, LIST, fakeExecutor([])),
  ).rejects.toThrow(
    "MCP server obscura runs on a lambda sandbox, which must be persistent",
  );
});

function fakeExecutor(reservations: unknown[]): SandboxMcpExecutor {
  return {
    acquireHarnessReservation: async function (request) {
      reservations.push(request);

      return {
        microvmId: "mvm-1",
        endpoint: "https://vm.example.com",
        isFirstCreate: false,
      };
    },
    createHarnessAuthToken: async function (microvmId, port) {
      return `token-${microvmId}-${port}`;
    },
  };
}

function stubFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => handler(String(input), init ?? {})) as typeof fetch;
}
