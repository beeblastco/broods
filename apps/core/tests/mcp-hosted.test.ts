/**
 * Hosted MCP transport tests (#331 phase 2, micro-batching #397): the fetch
 * adapter serializes one web request into a runner request, the batcher
 * folds the calls that arrive inside one window into one invoke, and every
 * call is rebuilt from the frame tagged with its id. The full chain against a
 * real child-runner + createMcpHandler bundle runs in the local-stack E2E,
 * not here, because the repo has no SDK fixture bundles.
 */

import {
  InvokeWithResponseStreamCommand,
  LambdaClient,
  type InvokeWithResponseStreamResponseEvent,
} from "@aws-sdk/client-lambda";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { McpRecord } from "../src/shared/domain/mcp.ts";
import {
  resetStorageForTests,
  setStorageForTests,
} from "../src/shared/storage.ts";
import { FrameQueue, type RunnerFrame } from "../src/harness/frames.ts";
import { listMcpTools, setMcpForTests } from "../src/harness/mcp/client.ts";
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
  tenantId: string;
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

    const fetchLike = hostedMcpFetch({ record: hostedRecord() });
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
        tenantId: "acct_test",
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

    const fetchLike = hostedMcpFetch({ record: hostedRecord() });
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

    const fetchLike = hostedMcpFetch({ record: hostedRecord() });
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

describe("hosted MCP invoke", () => {
  it("carries the account id as the Lambda tenant id only when MCP_TENANT_ISOLATION is on", async () => {
    // AWS_PROFILE outranks static keys; a real profile must never sign here.
    delete process.env.AWS_PROFILE;
    process.env.AWS_REGION = "eu-west-1";
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    process.env.TOOL_BUNDLES_BUCKET_NAME = "bundles";
    process.env.TOOL_RUNNER_FUNCTION_NAME = "mcp-runner";
    process.env.MCP_TENANT_ISOLATION = "true";
    const frames = new TextEncoder().encode(
      `${JSON.stringify({ t: "final", id: "1", result: ok("{}") })}\n{"t":"end"}\n`,
    );
    const send = spyOn(LambdaClient.prototype, "send").mockImplementation(
      async (): Promise<{
        EventStream: InvokeWithResponseStreamResponseEvent[];
      }> => ({ EventStream: [{ PayloadChunk: { Payload: frames } }] }),
    );

    try {
      const response = await hostedMcpFetch({
        record: hostedRecord(),
        agentId: "agent_1",
      })(URL, { method: "POST", body: "{}" });
      expect(response.status).toBe(200);
      const command = send.mock.calls[0]?.[0];
      expect(command).toBeInstanceOf(InvokeWithResponseStreamCommand);
      expect(command?.input).toMatchObject({
        FunctionName: "mcp-runner",
        TenantId: "acct_test:agent_1",
      });
      // The payload carries the same tenant for the handler's warm-child key.
      const payload =
        command instanceof InvokeWithResponseStreamCommand &&
        command.input.Payload instanceof Uint8Array
          ? command.input.Payload
          : new Uint8Array();
      expect(JSON.parse(new TextDecoder().decode(payload))).toMatchObject({
        tenantId: "acct_test:agent_1",
      });
      // A probe with no agent is the account's own tenant.
      await hostedMcpFetch({ record: hostedRecord() })(URL, {
        method: "POST",
        body: "{}",
      });
      expect(send.mock.calls[1]?.[0]?.input).toMatchObject({
        TenantId: "acct_test",
      });
      delete process.env.MCP_TENANT_ISOLATION;
      await hostedMcpFetch({ record: hostedRecord() })(URL, {
        method: "POST",
        body: "{}",
      });
      expect(send.mock.calls[2]?.[0]?.input).not.toHaveProperty("TenantId");
    } finally {
      delete process.env.MCP_TENANT_ISOLATION;
      send.mockRestore();
    }
  });
});

describe("hosted MCP metering", () => {
  const recorded: { accountId: string; usage: unknown }[] = [];

  beforeEach(() => {
    recorded.length = 0;
    delete process.env.AWS_PROFILE;
    process.env.AWS_REGION = "eu-west-1";
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    process.env.TOOL_BUNDLES_BUCKET_NAME = "bundles";
    setStorageForTests({
      budgets: {
        record: async (accountId: string, usage: unknown): Promise<void> => {
          recorded.push({ accountId: accountId, usage: usage });
        },
      },
    } as never);
  });
  afterEach(() => {
    resetStorageForTests();
  });

  it("charges one request for an invoke Lambda accepted", async () => {
    process.env.TOOL_RUNNER_FUNCTION_NAME = "mcp-runner";
    const frames = new TextEncoder().encode(
      `${JSON.stringify({ t: "final", id: "1", result: ok("{}") })}\n{"t":"end"}\n`,
    );
    const send = spyOn(LambdaClient.prototype, "send").mockImplementation(
      async (): Promise<{
        EventStream: InvokeWithResponseStreamResponseEvent[];
      }> => ({ EventStream: [{ PayloadChunk: { Payload: frames } }] }),
    );

    try {
      await hostedMcpFetch({ record: hostedRecord() })(URL, {
        method: "POST",
        body: "{}",
      });
      await Promise.resolve();
    } finally {
      send.mockRestore();
    }

    expect(recorded).toEqual([
      {
        accountId: "acct_test",
        usage: { hostedMcpGbSeconds: expect.any(Number), hostedMcpRequests: 1 },
      },
    ]);
  });

  it("keeps a Workers-capable row on Lambda when the deployment runs no Worker", async (): Promise<void> => {
    process.env.TOOL_RUNNER_FUNCTION_NAME = "mcp-runner";
    delete process.env.CLOUDFLARE_MCP_URL;
    const frames = new TextEncoder().encode(
      `${JSON.stringify({ t: "final", id: "1", result: ok("lambda") })}\n{"t":"end"}\n`,
    );
    const send = spyOn(LambdaClient.prototype, "send").mockImplementation(
      async (): Promise<{
        EventStream: InvokeWithResponseStreamResponseEvent[];
      }> => ({ EventStream: [{ PayloadChunk: { Payload: frames } }] }),
    );

    try {
      const response = await hostedMcpFetch({
        record: { ...hostedRecord(), workersCompatible: true },
      })(URL, { method: "POST", body: "{}" });
      expect(await response.text()).toBe("lambda");
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
    }
  });

  it("keeps a row its owner pinned to Lambda off the Worker", async (): Promise<void> => {
    const bridge = mockBridge(
      async (): Promise<Response> =>
        new Response("unexpected", { status: 500 }),
    );
    const lambda = mockLambda("lambda");

    try {
      const response = await hostedMcpFetch({
        record: {
          ...hostedRecord(),
          workersCompatible: true,
          runtime: "lambda",
        },
      })(URL, { method: "POST", body: "{}" });
      expect(await response.text()).toBe("lambda");
      expect(bridge).not.toHaveBeenCalled();
    } finally {
      bridge.mockRestore();
      lambda.mockRestore();
    }
  });

  it("sends a Workers-capable row to the Cloudflare runtime and meters it like Lambda", async (): Promise<void> => {
    let reply = async (): Promise<Response> =>
      new Response(
        `${JSON.stringify({ t: "final", id: "1", result: ok("cloudflare") })}\n{"t":"end"}\n`,
      );
    const bridge = mockBridge(async (): Promise<Response> => await reply());
    const lambda = spyOn(LambdaClient.prototype, "send");

    try {
      expect(await callWorkersRow()).toBe("cloudflare");
      await Promise.resolve();
      const [target, init] = bridge.mock.calls[0] ?? [];
      expect(target).toBe("https://mcp.example.workers.dev/mcp");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer bridge-key",
      );
      expect(JSON.parse(await new Response(init?.body).text())).toMatchObject({
        tenantId: "acct_test:agent_1",
        expectedSha256: "a".repeat(64),
      });
      expect(lambda).not.toHaveBeenCalled();

      reply = async (): Promise<Response> =>
        new Response(
          `${JSON.stringify({ t: "final", id: "1", result: ok("cut") })}\n`,
        );
      await expect(callWorkersRow()).rejects.toThrow("without an end frame");
      // Answered 200, so a tool may have run: never retried on Lambda.
      expect(lambda).not.toHaveBeenCalled();
      await Promise.resolve();
    } finally {
      bridge.mockRestore();
      lambda.mockRestore();
    }

    const charge = {
      accountId: "acct_test",
      usage: { hostedMcpGbSeconds: expect.any(Number), hostedMcpRequests: 1 },
    };
    expect(recorded).toEqual([charge, charge]);
  });

  it("runs the batch on Lambda when the Worker was never reached, and charges only Lambda", async (): Promise<void> => {
    const bridge = mockBridge(async (): Promise<Response> => {
      throw Object.assign(new TypeError("Unable to connect"), {
        code: "ConnectionRefused",
      });
    });
    const lambda = mockLambda("lambda");

    try {
      expect(await callWorkersRow()).toBe("lambda");
      expect(lambda).toHaveBeenCalledTimes(1);
      await Promise.resolve();
    } finally {
      bridge.mockRestore();
      lambda.mockRestore();
    }

    expect(recorded).toHaveLength(1);
  });

  it("fails loudly on any Worker error it did not tag as nothing ran", async (): Promise<void> => {
    const bridge = mockBridge(
      async (): Promise<Response> =>
        new Response("unauthorized", { status: 401 }),
    );
    const lambda = spyOn(LambdaClient.prototype, "send");

    try {
      await expect(callWorkersRow()).rejects.toThrow("HTTP 401: unauthorized");
      bridge.mockImplementation(
        workerFetch(
          async (): Promise<Response> =>
            new Response("Service Unavailable", { status: 503 }),
        ),
      );
      await expect(callWorkersRow()).rejects.toThrow("HTTP 503");
      expect(lambda).not.toHaveBeenCalled();
    } finally {
      bridge.mockRestore();
      lambda.mockRestore();
    }
  });

  it("sends a bundle the Worker could not load straight to Lambda after that", async (): Promise<void> => {
    const bridge = mockBridge(
      async (): Promise<Response> =>
        new Response("bundle failed to load: sha256", {
          status: 422,
          headers: { "x-broods-nothing-ran": "1" },
        }),
    );
    const lambda = mockLambda("lambda");

    try {
      expect(await callWorkersRow()).toBe("lambda");
      expect(await callWorkersRow()).toBe("lambda");
      expect(bridge).toHaveBeenCalledTimes(1);
      expect(lambda).toHaveBeenCalledTimes(2);
    } finally {
      bridge.mockRestore();
      lambda.mockRestore();
    }
  });

  it("tries the Worker again after a load that only timed out", async (): Promise<void> => {
    const bridge = mockBridge(
      async (): Promise<Response> =>
        new Response("bundle failed to load: load timed out", {
          status: 504,
          headers: { "x-broods-nothing-ran": "1" },
        }),
    );
    const lambda = mockLambda("lambda");

    try {
      expect(await callWorkersRow()).toBe("lambda");
      expect(await callWorkersRow()).toBe("lambda");
      expect(bridge).toHaveBeenCalledTimes(2);
    } finally {
      bridge.mockRestore();
      lambda.mockRestore();
    }
  });

  it("keeps the Worker's reason when the Lambda fallback fails too", async (): Promise<void> => {
    const bridge = mockBridge(
      async (): Promise<Response> =>
        new Response("bundle failed to load: sha256", {
          status: 422,
          headers: { "x-broods-nothing-ran": "1" },
        }),
    );
    delete process.env.TOOL_RUNNER_FUNCTION_NAME;

    try {
      await expect(callWorkersRow()).rejects.toThrow(
        /TOOL_RUNNER_FUNCTION_NAME.*Lambda fallback after: .*HTTP 422: bundle failed to load: sha256/,
      );
    } finally {
      bridge.mockRestore();
    }
  });

  it("never retries on Lambda when the Worker connection broke after sending", async (): Promise<void> => {
    const bridge = mockBridge(async (): Promise<Response> => {
      throw Object.assign(new TypeError("socket closed"), {
        code: "ECONNRESET",
      });
    });
    const lambda = spyOn(LambdaClient.prototype, "send");

    try {
      await expect(callWorkersRow()).rejects.toThrow("socket closed");
      expect(lambda).not.toHaveBeenCalled();
    } finally {
      bridge.mockRestore();
      lambda.mockRestore();
    }
  });

  it("charges nothing when no invoke starts", async () => {
    delete process.env.TOOL_RUNNER_FUNCTION_NAME;
    const send = spyOn(LambdaClient.prototype, "send");

    try {
      await expect(
        hostedMcpFetch({ record: hostedRecord() })(URL, {
          method: "POST",
          body: "{}",
        }),
      ).rejects.toThrow("TOOL_RUNNER_FUNCTION_NAME");
      await Promise.resolve();
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }

    expect(recorded).toEqual([]);
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

describe("hosted MCP tool listing", () => {
  afterEach(() => {
    setMcpForTests(null);
  });

  it("caches a hosted listing per agent, so one agent never reads another agent's child", async () => {
    const sent = stubBatches((request) => {
      const message: { id?: number; method: string } = JSON.parse(
        request.body ?? "{}",
      );
      if (message.id === undefined)
        return { status: 202, headers: {}, body: "" };
      const result =
        message.method === "server/discover"
          ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
          : { tools: [{ name: "query", inputSchema: { type: "object" } }] };

      return ok(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resultType: "complete",
            ttlMs: 60_000,
            cacheScope: "private",
            ...result,
          },
        }),
      );
    });
    const connection = { record: hostedRecord(), headers: {} };

    await listMcpTools({ ...connection, agentId: "agent_1" });
    await listMcpTools({ ...connection, agentId: "agent_1" });
    const tools = await listMcpTools({ ...connection, agentId: "agent_2" });

    expect(tools.map((tool) => tool.name)).toEqual(["query"]);
    expect(
      sent
        .filter((batch) =>
          batch.requests.some((r) => r.mcpRequest.body?.includes("tools/list")),
        )
        .map((batch) => batch.tenantId),
    ).toEqual(["acct_test:agent_1", "acct_test:agent_2"]);
  });
});

describe("hosted MCP micro-batching", () => {
  it("folds the parallel calls of one step into one invoke, keyed by account, agent and bundle", async () => {
    const sent = stubBatches((request) => ok(`{"n":${request.body}}`));
    const fetchLike = hostedMcpFetch({
      record: hostedRecord(),
      agentId: "agent_1",
    });
    const otherTenant = hostedMcpFetch({
      record: { ...hostedRecord(), accountId: "acct_other" },
      agentId: "agent_1",
    });
    const otherAgent = hostedMcpFetch({
      record: hostedRecord(),
      agentId: "agent_2",
    });

    const responses = await Promise.all([
      fetchLike(URL, { method: "POST", body: "1" }),
      fetchLike(URL, { method: "POST", body: "2" }),
      otherTenant(URL, { method: "POST", body: "3" }),
      otherAgent(URL, { method: "POST", body: "5" }),
      fetchLike(URL, { method: "POST", body: "4" }),
    ]);

    expect(await Promise.all(responses.map((r) => r.json()))).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
      { n: 5 },
      { n: 4 },
    ]);
    expect(
      sent.map((batch) => [
        batch.tenantId,
        batch.requests.map((r) => r.mcpRequest.body),
      ]),
    ).toEqual([
      ["acct_test:agent_1", ["1", "2", "4"]],
      ["acct_other:agent_1", ["3"]],
      ["acct_test:agent_2", ["5"]],
    ]);
  });

  it("splits at the cap and opens a new batch for a call after the window", async () => {
    process.env.MCP_BATCH_MAX = "2";
    const sent = stubBatches((request) => ok(request.body ?? ""));
    const fetchLike = hostedMcpFetch({ record: hostedRecord() });

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
    const fetchLike = hostedMcpFetch({ record: hostedRecord() });

    await Promise.all([
      fetchLike(URL, { method: "POST", body: "a" }),
      fetchLike(URL, { method: "POST", body: "b" }),
    ]);

    expect(
      sent.map((batch) => batch.requests.map((r) => r.mcpRequest.body)),
    ).toEqual([["a"], ["b"]]);
  });

  it("fails only the call whose frame carried the error", async () => {
    setHostedMcpSendBatchForTests(async (_batch, requests) => ({
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
    const fetchLike = hostedMcpFetch({ record: hostedRecord() });

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
    const fetchLike = hostedMcpFetch({ record: hostedRecord() });

    expect(
      await rejectionOf(fetchLike(URL, { method: "POST", body: "{}" })),
    ).toBe("hosted MCP server hosted returned no response");
  });

  it("splits the batch's CPU evenly across its calls before they resolve", async () => {
    setHostedMcpSendBatchForTests(async (_batch, requests) => ({
      outcomes: new Map(requests.map((r) => [r.id, ok("")])),
      cpuUsec: 3_000,
    }));
    const seen: number[] = [];
    const fetchLike = hostedMcpFetch({ record: hostedRecord() }, (cpuUsec) => {
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
    const fetchLike = hostedMcpFetch({ record: hostedRecord() });
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
  setHostedMcpSendBatchForTests(async (batch, requests) => {
    sent.push({
      serverName: batch.record.name,
      tenantId: batch.tenantId,
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

/** One call by agent_1 through a Workers-capable row; the response body as text. */
async function callWorkersRow(): Promise<string> {
  const response = await hostedMcpFetch({
    record: { ...hostedRecord(), workersCompatible: true },
    agentId: "agent_1",
  })(URL, { method: "POST", body: "{}" });

  return await response.text();
}

/** Point core at a stub Worker that answers with `reply`; restore the spy after. */
function mockBridge(
  reply: () => Promise<Response>,
): ReturnType<typeof spyOn<typeof globalThis, "fetch">> {
  process.env.CLOUDFLARE_MCP_URL = "https://mcp.example.workers.dev/mcp";
  process.env.CLOUDFLARE_MCP_API_KEY = "bridge-key";

  return spyOn(globalThis, "fetch").mockImplementation(workerFetch(reply));
}

/** A Lambda that answers every batch with one final frame carrying `body`. */
function mockLambda(
  body: string,
): ReturnType<typeof spyOn<LambdaClient, "send">> {
  process.env.TOOL_RUNNER_FUNCTION_NAME = "mcp-runner";
  const frames = new TextEncoder().encode(
    `${JSON.stringify({ t: "final", id: "1", result: ok(body) })}\n{"t":"end"}\n`,
  );

  return spyOn(LambdaClient.prototype, "send").mockImplementation(
    async (): Promise<{
      EventStream: InvokeWithResponseStreamResponseEvent[];
    }> => ({ EventStream: [{ PayloadChunk: { Payload: frames } }] }),
  );
}

/** `reply` shaped as the global fetch, which Bun types with `preconnect`. */
function workerFetch(reply: () => Promise<Response>): typeof fetch {
  return Object.assign(async (): Promise<Response> => await reply(), {
    preconnect: (): void => {},
  });
}
