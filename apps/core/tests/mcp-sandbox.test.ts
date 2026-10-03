// An MCP server on a lambda sandbox is one POST /mcp per request to the
// reserved VM. These pin the wire shape the sandbox image reads, that a request
// is never resent, that a warm VM is reused, and how replies are checked.

import { afterEach, expect, spyOn, test } from "bun:test";
import {
  sandboxMcpRequest,
  type SandboxMcpExecutor,
  type SandboxMcpTarget,
} from "../src/harness/mcp/sandbox.ts";

const SERVER = { name: "obscura", command: ["obscura", "mcp"] };
const LIST = { method: "tools/list", params: {} };

const fetchSpy = spyOn(globalThis, "fetch");

afterEach(() => {
  fetchSpy.mockReset();
});

// Each test reserves its own key, because a warm VM is remembered per key.
function target(reservationKey: string): SandboxMcpTarget {
  return {
    config: { provider: "lambda", persistent: true, timeout: 30 },
    reservationKey: reservationKey,
  };
}

test("posts one JSON-RPC request and reuses the warm VM for the next", async () => {
  const reservations: unknown[] = [];
  const executor = fakeExecutor(reservations);
  answerWith(async () =>
    Response.json({ jsonrpc: "2.0", id: "1", result: { tools: [] } }),
  );

  const first = await sandboxMcpRequest(
    target("warm"),
    SERVER,
    LIST,
    undefined,
    executor,
  );
  await sandboxMcpRequest(target("warm"), SERVER, LIST, undefined, executor);

  expect(first).toEqual({ tools: [] });
  expect(reservations).toEqual([{ reservationKey: "warm", shared: true }]);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  const [url, init] = fetchSpy.mock.calls[0]!;
  expect(url).toBe("https://vm.example.com/mcp");
  expect(init?.headers).toEqual({
    "content-type": "application/json",
    "X-aws-proxy-auth": "token-mvm-1-8080",
    "X-aws-proxy-port": "8080",
  });
  const body: unknown = JSON.parse(
    typeof init?.body === "string" ? init.body : "",
  );
  expect(body).toMatchObject({
    server: "obscura",
    command: ["obscura", "mcp"],
    message: { jsonrpc: "2.0", method: "tools/list", params: {} },
    timeout_ms: 30_000,
  });
});

test("never resends a request, and reserves again after a failure", async () => {
  const reservations: unknown[] = [];
  const executor = fakeExecutor(reservations);
  answerWith(async () => new Response("warming", { status: 503 }));

  expect(
    await failure(
      sandboxMcpRequest(target("cold"), SERVER, LIST, undefined, executor),
    ),
  ).toContain("failed (503)");
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  answerWith(async () =>
    Response.json({ jsonrpc: "2.0", id: "1", result: { tools: [] } }),
  );
  await sandboxMcpRequest(target("cold"), SERVER, LIST, undefined, executor);
  expect(reservations).toHaveLength(2);
});

test("throws the server's message on a JSON-RPC error", async () => {
  answerWith(async () =>
    Response.json({
      jsonrpc: "2.0",
      id: "1",
      error: { code: -32000, message: "spawn obscura ENOENT" },
    }),
  );

  expect(
    await failure(
      sandboxMcpRequest(
        target("error"),
        SERVER,
        LIST,
        undefined,
        fakeExecutor([]),
      ),
    ),
  ).toContain("MCP server obscura: spawn obscura ENOENT");
});

test("refuses a reply that is not JSON-RPC", async () => {
  answerWith(async () => Response.json({ tools: [] }));

  expect(
    await failure(
      sandboxMcpRequest(
        target("garbled"),
        SERVER,
        LIST,
        undefined,
        fakeExecutor([]),
      ),
    ),
  ).toContain("answered with no JSON-RPC result");
});

// The error a call fails with, or "resolved" when it does not fail.
function failure(call: Promise<unknown>): Promise<string> {
  return call.then(
    (): string => "resolved",
    (error: unknown): string => String(error),
  );
}

// Every fetch in the test answers with `respond`.
function answerWith(respond: () => Promise<Response>): void {
  fetchSpy.mockImplementation(
    Object.assign(respond, { preconnect: globalThis.fetch.preconnect }),
  );
}

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
    reportBurst: function (): void {},
  };
}
