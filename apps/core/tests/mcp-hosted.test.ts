/**
 * Hosted MCP transport tests (#331 phase 2, micro-batching #397): the fetch
 * adapter serializes one web request into a runner request, the batcher
 * folds the calls that arrive inside one window into one invoke, and every
 * call is rebuilt from the frame tagged with its id. The full chain against a
 * real child-runner + createMcpHandler bundle runs in the local-stack E2E,
 * not here — no SDK fixture bundles in the repo.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { McpRecord } from "../src/shared/domain/mcp.ts";
import {
  hostedMcpFetch,
  setHostedMcpSendBatchForTests,
  type HostedMcpBatchRequest,
  type HostedMcpBatchResult,
  type HostedMcpResponse,
} from "../src/harness/mcp/hosted.ts";

const URL = "http://mcp-hosted.internal/mcp";

interface SentBatch {
  serverName: string;
  accountId: string;
  requests: HostedMcpBatchRequest[];
}

describe("hosted MCP fetch adapter", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.MCP_BATCH_WINDOW_MS = "10";
    process.env.MCP_BATCH_MAX = "8";
  });
  afterEach(() => {
    setHostedMcpSendBatchForTests(null);
    process.env = { ...savedEnv };
  });

  it("serializes the request and rebuilds the child's response", async () => {
    const sent = stubBatches((request) => ok(`{"echo":${request.body}}`));

    const fetchLike = hostedMcpFetch(hostedRecord());
    const response = await fetchLike(URL, {
      method: "POST",
      headers: { "mcp-method": "tools/list" },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      echo: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(sent).toEqual([
      {
        serverName: "hosted",
        accountId: "acct_test",
        requests: [
          {
            id: "1",
            mcpRequest: {
              method: "POST",
              headers: { "mcp-method": "tools/list" },
              body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
            },
          },
        ],
      },
    ]);
  });

  it("refuses the standalone GET stream with 405", async () => {
    const sent = stubBatches(() => {
      throw new Error("invoke must not run for GET");
    });

    const fetchLike = hostedMcpFetch(hostedRecord());
    const response = await fetchLike(URL, {
      method: "GET",
      headers: { accept: "text/event-stream" },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(sent).toEqual([]);
  });

  it("surfaces an invoke failure as a thrown error on every call", async () => {
    setHostedMcpSendBatchForTests(async () => {
      throw new Error("mcp host Lambda failed: boom");
    });

    const fetchLike = hostedMcpFetch(hostedRecord());
    const results = await Promise.allSettled([
      fetchLike(URL, { method: "POST", body: "{}" }),
      fetchLike(URL, { method: "POST", body: "{}" }),
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason.message).toBe(
        "mcp host Lambda failed: boom",
      );
    }
  });
});

describe("hosted MCP micro-batching", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.MCP_BATCH_WINDOW_MS = "10";
    process.env.MCP_BATCH_MAX = "8";
  });
  afterEach(() => {
    setHostedMcpSendBatchForTests(null);
    process.env = { ...savedEnv };
  });

  it("folds the parallel calls of one step into one invoke, keyed by tenant bundle", async () => {
    const sent = stubBatches((request) => ok(`{"n":${request.body}}`));
    const fetchLike = hostedMcpFetch(hostedRecord());
    const otherTenant = hostedMcpFetch({
      ...hostedRecord(),
      accountId: "acct_other",
    });

    const responses = await Promise.all([
      fetchLike(URL, { method: "POST", body: "1" }),
      fetchLike(URL, { method: "POST", body: "2" }),
      otherTenant(URL, { method: "POST", body: "3" }),
      fetchLike(URL, { method: "POST", body: "4" }),
    ]);

    expect(await Promise.all(responses.map((r) => r.json()))).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
      { n: 4 },
    ]);
    expect(
      sent.map((batch) => [
        batch.accountId,
        batch.requests.map((r) => r.mcpRequest.body),
      ]),
    ).toEqual([
      ["acct_test", ["1", "2", "4"]],
      ["acct_other", ["3"]],
    ]);
  });

  it("splits at the cap and opens a new batch for a call after the window", async () => {
    process.env.MCP_BATCH_MAX = "2";
    const sent = stubBatches((request) => ok(request.body ?? ""));
    const fetchLike = hostedMcpFetch(hostedRecord());

    const first = Promise.all([
      fetchLike(URL, { method: "POST", body: "a" }),
      fetchLike(URL, { method: "POST", body: "b" }),
      fetchLike(URL, { method: "POST", body: "c" }),
    ]);
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fetchLike(URL, { method: "POST", body: "d" });

    expect(
      sent.map((batch) => batch.requests.map((r) => r.mcpRequest.body)),
    ).toEqual([["a", "b"], ["c"], ["d"]]);
  });

  it("runs size-one batches when the window is 0", async () => {
    process.env.MCP_BATCH_WINDOW_MS = "0";
    const sent = stubBatches((request) => ok(request.body ?? ""));
    const fetchLike = hostedMcpFetch(hostedRecord());

    await Promise.all([
      fetchLike(URL, { method: "POST", body: "a" }),
      fetchLike(URL, { method: "POST", body: "b" }),
    ]);

    expect(
      sent.map((batch) => batch.requests.map((r) => r.mcpRequest.body)),
    ).toEqual([["a"], ["b"]]);
  });

  it("fails only the call whose frame carried the error", async () => {
    setHostedMcpSendBatchForTests(async (record, requests) => ({
      responses: new Map(
        requests
          .filter((r) => r.mcpRequest.body !== "bad")
          .map((r) => [r.id, ok(r.mcpRequest.body ?? "")]),
      ),
      errors: new Map(
        requests
          .filter((r) => r.mcpRequest.body === "bad")
          .map((r) => [r.id, new Error("handler threw")]),
      ),
      cpuUsec: 0,
    }));
    const fetchLike = hostedMcpFetch(hostedRecord());

    const [good, bad] = await Promise.allSettled([
      fetchLike(URL, { method: "POST", body: "good" }),
      fetchLike(URL, { method: "POST", body: "bad" }),
    ]);

    expect(good.status).toBe("fulfilled");
    expect(bad.status).toBe("rejected");
    expect((bad as PromiseRejectedResult).reason.message).toBe("handler threw");
  });

  it("rejects a call the batch never answered", async () => {
    setHostedMcpSendBatchForTests(async () => ({
      responses: new Map(),
      errors: new Map(),
      cpuUsec: undefined,
    }));
    const fetchLike = hostedMcpFetch(hostedRecord());

    expect(
      await rejectionOf(fetchLike(URL, { method: "POST", body: "{}" })),
    ).toBe("hosted MCP server hosted returned no response");
  });

  it("splits the batch's CPU evenly across its calls before they resolve", async () => {
    setHostedMcpSendBatchForTests(async (record, requests) => ({
      responses: new Map(requests.map((r) => [r.id, ok("")])),
      errors: new Map(),
      cpuUsec: 3_000,
    }));
    const seen: number[] = [];
    const fetchLike = hostedMcpFetch(hostedRecord(), (cpuUsec) => {
      seen.push(cpuUsec);
    });

    await Promise.all([
      fetchLike(URL, { method: "POST", body: "a" }),
      fetchLike(URL, { method: "POST", body: "b" }),
      fetchLike(URL, { method: "POST", body: "c" }),
    ]);

    expect(seen).toEqual([1_000, 1_000, 1_000]);
  });

  it("drops an aborted call from its batch and abandons an invoke nobody waits on", async () => {
    let batchSignal: AbortSignal | undefined;
    setHostedMcpSendBatchForTests(
      (record, requests, abortSignal) =>
        new Promise<HostedMcpBatchResult>((resolve, reject) => {
          batchSignal = abortSignal;
          abortSignal.addEventListener("abort", () =>
            reject(new Error("invoke abandoned")),
          );
          setTimeout(
            () =>
              resolve({
                responses: new Map(requests.map((r) => [r.id, ok("")])),
                errors: new Map(),
                cpuUsec: 0,
              }),
            50,
          );
        }),
    );
    const fetchLike = hostedMcpFetch(hostedRecord());
    const early = new AbortController();
    const late = new AbortController();

    const earlyCall = fetchLike(URL, {
      method: "POST",
      body: "early",
      signal: early.signal,
    });
    const lateCall = fetchLike(URL, {
      method: "POST",
      body: "late",
      signal: late.signal,
    });
    early.abort(new Error("step cancelled"));
    expect(await rejectionOf(earlyCall)).toBe("step cancelled");
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(batchSignal?.aborted).toBe(false);

    late.abort(new Error("step cancelled"));
    expect(await rejectionOf(lateCall)).toBe("step cancelled");
    expect(batchSignal?.aborted).toBe(true);
  });
});

/**
 * Stub the invoke with a per-request answer and record every batch as sent.
 * Every request gets a response; the batch reports no CPU.
 */
function stubBatches(
  answer: (request: HostedMcpBatchRequest["mcpRequest"]) => HostedMcpResponse,
): SentBatch[] {
  const sent: SentBatch[] = [];
  setHostedMcpSendBatchForTests(async (record, requests) => {
    sent.push({
      serverName: record.name,
      accountId: record.accountId,
      requests: requests,
    });

    return {
      responses: new Map(requests.map((r) => [r.id, answer(r.mcpRequest)])),
      errors: new Map(),
      cpuUsec: undefined,
    };
  });

  return sent;
}

/** The message a promise rejects with; fails the test if it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the call to reject");
}

function ok(body: string): HostedMcpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: body,
  };
}

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
