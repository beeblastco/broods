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
import { FrameQueue, type RunnerFrame } from "../src/harness/frames.ts";
import {
  collectBatchFrames,
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

const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.MCP_BATCH_WINDOW_MS = "10";
  process.env.MCP_BATCH_MAX = "8";
});
afterEach(() => {
  setHostedMcpSendBatchForTests(null);
  process.env = { ...savedEnv };
});

describe("hosted MCP fetch adapter", () => {
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

describe("hosted MCP batch frame demux", () => {
  const requests: HostedMcpBatchRequest[] = ["1", "2", "3"].map((id) => ({
    id: id,
    mcpRequest: { method: "POST", headers: {}, body: "{}" },
  }));

  it("settles each request off its tagged frame and reads CPU off end", async () => {
    const { result, ended } = await collectBatchFrames(
      "hosted",
      requests,
      framesOf(
        '{"t":"final","id":"2","result":{"status":200,"headers":{},"body":"two"}}',
        '{"t":"error","id":"3","error":"boom"}',
        '{"t":"final","id":"1","result":{"status":201,"headers":{},"body":"one"}}',
        '{"t":"end","cpuUsec":900}',
        '{"t":"final","id":"1","result":{"status":500,"headers":{},"body":"late"}}',
      ),
    );

    expect(ended).toBe(true);
    expect(result.cpuUsec).toBe(900);
    expect(outcomeSummary(result.outcomes)).toEqual({
      "1": "201 one",
      "2": "200 two",
      "3": "error: boom",
    });
  });

  it("fails every unanswered request on an untagged error and keeps the answered ones", async () => {
    const { result, ended } = await collectBatchFrames(
      "hosted",
      requests,
      framesOf(
        '{"t":"final","id":"1","result":{"status":200,"headers":{},"body":"one"}}',
        '{"t":"error","error":"mcp server run timed out","cpuUsec":50}',
      ),
    );

    expect(ended).toBe(true);
    expect(result.cpuUsec).toBe(50);
    expect(outcomeSummary(result.outcomes)).toEqual({
      "1": "200 one",
      "2": "error: mcp server run timed out",
      "3": "error: mcp server run timed out",
    });
  });

  it("names the server when a frame carries no message and rejects a malformed final", async () => {
    const { result } = await collectBatchFrames(
      "hosted",
      requests,
      framesOf(
        '{"t":"error","id":"1","error":""}',
        '{"t":"final","id":"2","result":{"status":"200"}}',
        '{"t":"end"}',
      ),
    );

    expect(outcomeSummary(result.outcomes)).toEqual({
      "1": "error: hosted MCP server hosted run failed",
      "2": "error: hosted MCP server hosted returned a malformed response",
    });
  });

  it("reports a stream that closed without a terminal frame", async () => {
    const { result, ended } = await collectBatchFrames(
      "hosted",
      requests,
      framesOf(
        '{"t":"final","id":"1","result":{"status":200,"headers":{},"body":"one"}}',
      ),
    );

    expect(ended).toBe(false);
    expect(result.cpuUsec).toBeUndefined();
    expect(outcomeSummary(result.outcomes)).toEqual({ "1": "200 one" });
  });
});

describe("hosted MCP micro-batching", () => {
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

    await Promise.all([
      fetchLike(URL, { method: "POST", body: "a" }),
      fetchLike(URL, { method: "POST", body: "b" }),
      fetchLike(URL, { method: "POST", body: "c" }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fetchLike(URL, { method: "POST", body: "d" });

    expect(
      sent.map((batch) => batch.requests.map((r) => r.mcpRequest.body)),
    ).toEqual([["a", "b"], ["c"], ["d"]]);
  });

  it("runs size-one batches when the cap is 1", async () => {
    process.env.MCP_BATCH_MAX = "1";
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
      outcomes: new Map(
        requests.map((r) => [
          r.id,
          r.mcpRequest.body === "bad"
            ? new Error("handler threw")
            : ok(r.mcpRequest.body ?? ""),
        ]),
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
      outcomes: new Map(),
      cpuUsec: undefined,
    }));
    const fetchLike = hostedMcpFetch(hostedRecord());

    expect(
      await rejectionOf(fetchLike(URL, { method: "POST", body: "{}" })),
    ).toBe("hosted MCP server hosted returned no response");
  });

  it("splits the batch's CPU evenly across its calls before they resolve", async () => {
    setHostedMcpSendBatchForTests(async (record, requests) => ({
      outcomes: new Map(requests.map((r) => [r.id, ok("")])),
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
                outcomes: new Map(requests.map((r) => [r.id, ok("")])),
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

/** Stub the invoke with a per-request answer and record every batch as sent. */
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
      outcomes: new Map(requests.map((r) => [r.id, answer(r.mcpRequest)])),
      cpuUsec: undefined,
    };
  });

  return sent;
}

/** A closed FrameQueue holding the given NDJSON lines. */
function framesOf(...lines: string[]): AsyncIterable<RunnerFrame> {
  const queue = new FrameQueue();
  queue.push(`${lines.join("\n")}\n`);
  queue.close();

  return queue.frames();
}

/** Outcomes as one readable string per id, so a test asserts the whole map at once. */
function outcomeSummary(
  outcomes: Map<string, HostedMcpResponse | Error>,
): Record<string, string> {
  return Object.fromEntries(
    [...outcomes].map(([id, outcome]) => [
      id,
      outcome instanceof Error
        ? `error: ${outcome.message}`
        : `${outcome.status} ${outcome.body}`,
    ]),
  );
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
