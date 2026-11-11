import { z } from "../../apps/cloudflare-mcp/node_modules/zod";
import { WEB_GLOBALS_SOURCE } from "../../apps/core/src/harness/isolate/runner/web-globals.mjs";
import {
  isTimeoutError,
  isUnreachableError,
  toErrorMessage,
} from "../../apps/core/src/shared/errors.ts";
import { afterAll, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  resetConnectionsForTests,
  tokenFetch,
} from "../../apps/core/src/harness/connections.ts";
import {
  FrameQueue,
  parseRunnerFrame,
} from "../../apps/core/src/harness/frames.ts";
import {
  collectBatchFrames,
  hostedMcpFetch,
  setHostedMcpSendBatchForTests,
} from "../../apps/core/src/harness/mcp/hosted.ts";
import {
  taskFromRuns,
  type RunStatus,
} from "../../apps/core/src/harness/mcp-tasks.ts";
import {
  callMcpTool,
  callMcpToolResult,
  mcpConnection,
  setMcpForTests,
} from "../../apps/core/src/harness/mcp/client.ts";
import * as http from "../../apps/core/src/shared/http.ts";
import {
  setStorageForTests,
  type Storage,
} from "../../apps/core/src/shared/storage.ts";
import { normalizeBundlePath } from "../../packages/convex/model/skillRules.ts";
import { assertMcpRow } from "../../packages/convex/model/mcp.ts";
import type { McpRecord } from "../../apps/core/src/shared/domain/mcp.ts";
import { suite } from "./suites/hosted.ts";

interface Vector {
  kind: string;
  name: string;
  input: unknown;
  expected: unknown;
}

const TOKEN_URL = "https://auth.tool.test/token";
let serveTool: typeof http.publicHostFetch = async (): Promise<Response> => {
  throw new Error("unstubbed public host call");
};
void mock.module("../../apps/core/src/shared/http.ts", () => ({
  ...http,
  publicHostFetch: (
    ...args: Parameters<typeof http.publicHostFetch>
  ): Promise<Response> => serveTool(...args),
}));

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (): Promise<Response> => {
  throw new Error("unstubbed network call");
}) as typeof fetch;
afterAll((): void => {
  globalThis.fetch = originalFetch;
  setHostedMcpSendBatchForTests(null);
});

// Private bodies are extracted without loading cloud services.
function privateFunction<T>(
  file: string,
  name: string,
  constants: string,
  dependencies: Record<string, unknown> = {},
): T {
  const source = sourceFor(file);
  let start = source.indexOf(`function ${name}(`);
  if (source.slice(start - 6, start) === "async ") start -= 6;
  if (start < 0) throw new Error(`missing ${name}`);
  const next = source
    .slice(start + 1)
    .search(/\n(?:async )?function |\nexport /);
  const body =
    next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(
    `${constants}\n${body}\nreturn ${name};`,
  );

  // oxlint-disable-next-line typescript/no-implied-eval -- evaluates code taken from the real source on purpose
  return new Function(...Object.keys(dependencies), js)(
    ...Object.values(dependencies),
  ) as T;
}

const WRITE_TOOL = { name: "write", inputSchema: { type: "object" as const } };

// A fake MCP server behind the stubbed publicHostFetch; counts tools/call sends only.
async function toolCallSends(input: {
  path: "agent" | "bare" | "explorer";
  connected: boolean;
  modern: boolean;
  script: string[];
}): Promise<number> {
  let sends = 0;
  let issued = 0;
  serveTool = async (url, init): Promise<Response> => {
    const target = url instanceof Request ? url.url : url.toString();
    if (target === TOKEN_URL) {
      issued += 1;

      return Response.json({
        access_token: `token-${issued}`,
        expires_in: 3600,
      });
    }
    const sent = typeof init?.body === "string" ? init.body : "";
    const body = JSON.parse(sent) as {
      id?: number;
      method: string;
    };
    if (body.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: object): Response =>
      Response.json({ jsonrpc: "2.0", id: body.id, result: result });
    const complete = input.modern ? { resultType: "complete" } : {};
    if (body.method === "server/discover") {
      if (!input.modern) {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        });
      }

      return reply({
        ...complete,
        ttlMs: 0,
        cacheScope: "private",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
      });
    }
    if (body.method === "initialize") {
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1" },
      });
    }
    if (body.method === "tools/list") {
      return reply({
        ...complete,
        ttlMs: 0,
        cacheScope: "private",
        tools: [WRITE_TOOL],
      });
    }
    const answer = input.script[sends % input.script.length];
    sends += 1;
    switch (answer) {
      case "401":
        return new Response("unauthorized", { status: 401 });
      case "mismatch":
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32020, message: "header mismatch" },
          },
          { status: 400 },
        );
      case "input":
        return reply({ resultType: "input_required", requestState: "state" });
      default:
        return reply({
          ...complete,
          isError: answer === "rate",
          content: [
            {
              type: "text",
              text: answer === "rate" ? "429 retry after 0ms" : "ok",
            },
          ],
        });
    }
  };
  const stored = {
    clientId: "client",
    tokenUrl: TOKEN_URL,
    resource: "https://tool.test/mcp",
    accessToken: "token-0",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
    updatedAt: 0,
  };
  setStorageForTests({
    mcp: {
      loadConnection: async (): Promise<typeof stored> => stored,
      saveRefreshedConnection: async (): Promise<boolean> => true,
    },
  } as unknown as Storage);
  setMcpForTests(null);
  resetConnectionsForTests();
  // The SDK paces a requestState-only input_required leg by 250ms; the count does not depend on it.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void, ms?: number): unknown =>
    realSetTimeout(handler, ms === 250 ? 0 : ms)) as typeof setTimeout;
  const record = {
    accountId: "account",
    serverId: "server",
    projectId: "project",
    stageId: "stage",
    name: "server",
    transport: "http",
    url: "https://tool.test/mcp",
    connected: input.connected,
    status: "active",
    createdAt: "date",
    updatedAt: "date",
  } as McpRecord;
  const connection = mcpConnection(record, undefined);
  try {
    if (input.path === "explorer") {
      await callMcpToolResult(connection, "write", {});
    } else {
      await callMcpTool(
        connection,
        "write",
        {},
        input.path === "agent" ? { toolDefinition: WRITE_TOOL } : {},
      );
    }
  } catch {
    // A thrown call ends the loop; only the send count is compared.
  } finally {
    globalThis.setTimeout = realSetTimeout;
    setStorageForTests(null);
    setMcpForTests(null);
    resetConnectionsForTests();
  }

  return sends;
}

function sourceFor(file: string): string {
  let source = readFileSync(file, "utf8");
  const index =
    process.env.SPEC_SUITE === "hosted" && process.env.SPEC_MUTATION
      ? process.env.SPEC_MUTATION
      : undefined;
  const mutation =
    index === undefined ? undefined : suite.mutations[Number(index)];
  if (mutation?.file === file) {
    if (!source.includes(mutation.find))
      throw new Error("mutation no longer matches");
    source = source.replace(mutation.find, mutation.replace);
  }
  return source;
}

const rateWait = privateFunction<
  (message: string, attempt: number) => number | null
>(
  "apps/core/src/harness/mcp/client.ts",
  "rateLimitWaitMs",
  "const RATE_LIMIT_PATTERN = /\\b429\\b|rate limit/i; const RATE_LIMIT_WAIT_PATTERN = /(?:retry after|try again in) (\\d+(?:\\.\\d+)?)\\s*(ms|milliseconds?|s|seconds?)\\b/i; const RATE_LIMIT_BACKOFF_MS = 2000; const MAX_RATE_LIMIT_WAIT_MS = 60000;",
);
const clampTtl = privateFunction<(n: unknown) => number>(
  "apps/core/src/harness/mcp/client.ts",
  "clampTtlMs",
  "const DEFAULT_TTL_MS = 300000; const MAX_TTL_MS = 3600000;",
);
const lambdaPrefix = privateFunction<
  (prefix: Buffer, length: number, expected: Buffer) => boolean
>("apps/lambda/handler.mjs", "lineStartsWith", "");
const workerEncode = privateFunction<(frame: object) => Uint8Array>(
  "apps/cloudflare-mcp/src/index.ts",
  "encodeFrame",
  "",
);

const drainBridge = privateFunction<
  (
    url: string,
    payload: object,
    signal: AbortSignal,
    queue: FrameQueue,
    invoked: (at: number) => void,
  ) => Promise<void>
>(
  "apps/core/src/harness/mcp/hosted.ts",
  "drainBridgeStream",
  `const RUNNER_REQUEST_TIMEOUT_MS = 45000; const CLOUDFLARE_ERROR_BODY_CHARS = 512; const WORKER_NOTHING_RAN_HEADER = "x-broods-nothing-ran";
   const requireEnv = () => "test";
   class WorkerNotRunError extends Error { constructor(message, status) { super(message); this.status = status; this.notRun = true; } }`,
  {
    isTimeoutError: isTimeoutError,
    isUnreachableError: isUnreachableError,
    toErrorMessage: toErrorMessage,
  },
);
const run = spawnSync(
  `${import.meta.dir}/../.lake/build/bin/spec-replay`,
  ["hosted"],
  {
    cwd: `${import.meta.dir}/..`,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  },
);
if (run.status !== 0) throw new Error(run.stderr + run.stdout);
const vectors = run.stdout
  .trim()
  .split("\n")
  .map((line): Vector => JSON.parse(line) as Vector);
if (!vectors.length) throw new Error("no vectors");

test.each(vectors)("$kind: $name", async (vector): Promise<void> => {
  switch (vector.kind) {
    case "retry": {
      const input = vector.input as {
        code?: string;
        name?: string;
        status?: number;
        tagged?: boolean;
      };
      const blockedFetch = globalThis.fetch;
      let metered = false;
      let retryable = false;
      globalThis.fetch = (async (): Promise<Response> => {
        if (input.code || input.name) {
          const error = new Error("injected");
          if (input.name) error.name = input.name;
          if (input.code) Object.assign(error, { code: input.code });
          throw error;
        }

        return new Response("failed", {
          status: input.status,
          headers: input.tagged ? { "x-broods-nothing-ran": "0" } : {},
        });
      }) as typeof fetch;
      try {
        await drainBridge(
          "https://test/mcp",
          {},
          new AbortController().signal,
          new FrameQueue(),
          (): void => {
            metered = true;
          },
        );
      } catch (error) {
        retryable = error instanceof Error && "notRun" in error;
      } finally {
        globalThis.fetch = blockedFetch;
      }
      expect([retryable, metered]).toEqual(vector.expected);

      return;
    }
    case "token": {
      const statuses = vector.input as number[];
      const sent: string[] = [];
      let issued = 0;
      const stored = (): {
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        updatedAt: number;
      } => ({
        accessToken: `token-${issued}`,
        refreshToken: "refresh",
        expiresAt: Date.now() + 3_600_000,
        updatedAt: issued,
      });
      resetConnectionsForTests();
      const signedIn = tokenFetch(
        {
          key: "replay",
          missing: "missing",
          load: async () => stored(),
          refresh: async () => {
            issued += 1;

            return {
              accessToken: `token-${issued}`,
              expiresAt: Date.now() + 3_600_000,
            };
          },
          refreshFailed: (message: string): string => message,
          save: async (): Promise<boolean> => true,
        },
        async (_input, init): Promise<Response> => {
          sent.push(new Headers(init?.headers).get("Authorization") ?? "");

          return new Response(null, {
            status: statuses[Math.min(sent.length - 1, 1)],
          });
        },
      );
      const response = await signedIn("https://tool.test/mcp", {
        method: "POST",
        body: "{}",
      });
      resetConnectionsForTests();
      expect([sent.length, response.status]).toEqual(vector.expected);
      if (sent.length === 2) expect(sent[1]).not.toBe(sent[0]);

      return;
    }
    case "sends": {
      const input = vector.input as Parameters<typeof toolCallSends>[0];
      expect(await toolCallSends(input)).toBe(vector.expected);

      return;
    }
    case "frames": {
      const wire = (vector.input as string[]).join("");
      const parsed = JSON.parse(wire) as {
        t: string;
        id?: string;
        cpuUsec?: number;
      };
      expect(new TextDecoder().decode(workerEncode(parsed))).toBe(
        wire.endsWith("\n") ? wire : wire + "\n",
      );
      const prefix = Buffer.from(wire);
      const detected =
        lambdaPrefix(prefix, prefix.length, Buffer.from('{"t":"end"')) ||
        lambdaPrefix(
          prefix,
          prefix.length,
          Buffer.from('{"t":"error","error"'),
        );
      expect(detected).toBe(
        parsed.t === "end" || (parsed.t === "error" && parsed.id === undefined),
      );
      const queue = new FrameQueue();
      for (const chunk of vector.input as string[]) queue.push(chunk);
      queue.close();
      const actual = [];
      for await (const frame of queue.frames()) actual.push(frame);
      expect(actual).toEqual(vector.expected);

      return;
    }
    case "parse":
      expect(parseRunnerFrame(vector.input as string)).toEqual(vector.expected);
      return;
    case "path": {
      let valid = true;
      try {
        normalizeBundlePath(vector.input as string);
      } catch {
        valid = false;
      }
      expect(valid).toBe(vector.expected);

      return;
    }
    case "ttl":
      expect(clampTtl(vector.input)).toBe(vector.expected);
      return;
    case "wait": {
      const [attempt, asked] = vector.input as [number, number | null];
      expect(
        rateWait(
          asked === null ? "rate limit" : `429 retry after ${asked}ms`,
          attempt,
        ),
      ).toBe(vector.expected);

      return;
    }
    case "task": {
      const [status, stopped] = vector.input as [RunStatus["status"], boolean];
      const current = {
        runId: "run",
        agentId: "agent",
        conversationKey: "key",
        eventId: "event",
        createdAt: "date",
        lastUpdatedAt: "date",
        status: status,
        stoppedByUser: stopped,
      } as RunStatus;
      const task = taskFromRuns({ root: current, current: current });
      expect([
        task.status,
        "result" in task && task.result?.isError === true,
      ]).toEqual(vector.expected);

      return;
    }
    case "row": {
      const [
        machine,
        hosted,
        sandbox,
        command,
        headers,
        runtime,
        oauth,
        https,
        authorization,
      ] = vector.input as boolean[];
      let valid = true;
      try {
        assertMcpRow({
          transport: machine ? "machine" : hosted ? "hosted" : "http",
          ...(sandbox ? { sandbox: "box" } : {}),
          ...(command ? { command: ["cmd"] } : {}),
          ...(headers || authorization
            ? { headers: authorization ? { Authorization: "x" } : {} }
            : {}),
          ...(runtime ? { runtime: "auto" } : {}),
          ...(oauth
            ? {
                oauth: {
                  clientId: "x",
                  clientSecret: "x",
                  refreshToken: "x",
                },
              }
            : {}),
          url: https ? "https://example.test" : "http://example.test",
        });
      } catch {
        valid = false;
      }
      const expected = vector.expected;
      expect(valid).toBe(expected);

      return;
    }
    default:
      throw new Error(`unknown vector ${vector.kind}`);
  }
});

test("collector: duplicate id overwrites, unknown retained, terminal stops", async (): Promise<void> => {
  const queue = new FrameQueue();
  for (const frame of [
    { t: "final", id: "1", result: { status: 200, body: "old" } },
    { t: "final", id: "1", result: { status: 201, body: "new" } },
    { t: "error", id: "unknown", error: "unknown" },
    { t: "error", error: "batch failed", cpuUsec: 10 },
    { t: "final", id: "2", result: { status: 200, body: "late" } },
  ])
    queue.push(JSON.stringify(frame) + "\n");
  queue.close();
  const requests = ["1", "2"].map((id) => ({
    id: id,
    mcpRequest: { method: "POST", headers: {}, body: "" },
  }));
  const actual = await collectBatchFrames("server", requests, queue.frames());
  expect(actual.ended).toBe(true);
  expect(actual.result.outcomes.get("1")).toEqual({ status: 201, body: "new" });
  expect(actual.result.outcomes.get("2")).toBeInstanceOf(Error);
  expect(actual.result.outcomes.get("unknown")).toBeInstanceOf(Error);
  expect(actual.result.cpuUsec).toBe(10);
});

test("batch: max eight, tenant segregation, missing response and GET", async (): Promise<void> => {
  const batches: { tenant: string; size: number }[] = [];
  setHostedMcpSendBatchForTests(async (batch, requests) => {
    batches.push({ tenant: batch.tenantId, size: requests.length });

    return {
      outcomes: new Map(
        requests
          .filter((request) => request.id !== "2")
          .map((request) => [
            request.id,
            { status: 200, headers: {}, body: "ok" },
          ]),
      ),
      cpuUsec: 10,
    };
  });
  const record = {
    accountId: "account",
    serverId: "server",
    name: "server",
    projectId: "project",
    stageId: "stage",
    status: "active",
    transport: "hosted",
    sha256: "a".repeat(64),
    bundleStorageKey: "bundle",
    updatedAt: "date",
  } as McpRecord;
  const fetchA = hostedMcpFetch({ record: record, agentId: "a" });
  const fetchB = hostedMcpFetch({ record: record, agentId: "b" });
  expect((await fetchA("http://test/mcp")).status).toBe(405);
  const pending = Array.from({ length: 9 }, (): Promise<Response> =>
    fetchA("http://test/mcp", { method: "POST", body: "{}" }),
  );
  pending.push(fetchB("http://test/mcp", { method: "POST", body: "{}" }));
  const results = await Promise.allSettled(pending);
  expect(batches).toEqual([
    { tenant: "account:a", size: 8 },
    { tenant: "account:a", size: 1 },
    { tenant: "account:b", size: 1 },
  ]);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  expect(rateWait("socket reset", 1)).toBeNull();
  setHostedMcpSendBatchForTests(null);
});

test.failing(
  "G600: malformed known-tag frames should be rejected",
  (): void => {
    expect(parseRunnerFrame('{"t":"final"}')).toBeNull();
  },
);

test("G7: semantic rate-limit error repeats an already acted call at most three times", async (): Promise<void> => {
  const { callMcpTool, setMcpForTests } =
    await import("../../apps/core/src/harness/mcp/client.ts");
  let acted = 0;
  setMcpForTests({
    callTool: async () => {
      acted += 1;

      return {
        isError: true,
        content: [{ type: "text", text: "429 retry after 0ms" }],
      };
    },
  });
  try {
    await expect(
      callMcpTool(
        { record: { name: "server" } as McpRecord, headers: {} },
        "write",
        {},
      ),
    ).rejects.toThrow("429");
    expect(acted).toBe(4);
  } finally {
    setMcpForTests(null);
  }
});

// oxlint-disable-next-line typescript/no-implied-eval -- evaluates code taken from the real source on purpose
const shim = new Function(
  "globalThis",
  "$0",
  "$1",
  `${WEB_GLOBALS_SOURCE}\nreturn globalThis;`,
)(
  {},
  (): null => null,
  (): number[] => [],
) as { TextDecoder: typeof TextDecoder };

test("G601: actual isolate decoder accepts overlong encoding as NUL", (): void => {
  expect(
    new shim.TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array([0xe0, 0x80, 0x80]),
    ),
  ).toBe("\0");
});

test.failing(
  "G601: isolate fatal UTF-8 decoder rejects overlong three-byte sequences",
  (): void => {
    expect((): string =>
      new shim.TextDecoder("utf-8", { fatal: true }).decode(
        new Uint8Array([0xe0, 0x80, 0x80]),
      ),
    ).toThrow();
  },
);

test("tenant identities: Lambda child and actual Worker loader keys differ", async (): Promise<void> => {
  const reuseKey = privateFunction<
    (event: { tenantId: string; expectedSha256: string }) => string
  >("apps/lambda/handler.mjs", "reuseKey", "", { process: { env: {} } });
  const digest = "a".repeat(64);
  expect(reuseKey({ tenantId: "account:a", expectedSha256: digest })).toBe(
    `account:a:${digest}`,
  );
  expect(reuseKey({ tenantId: "account:b", expectedSha256: digest })).toBe(
    `account:b:${digest}`,
  );
  const source = sourceFor("apps/cloudflare-mcp/src/index.ts")
    .replace(/^import .*;$/gm, "")
    .replace(
      "export default {\n  fetch: async function",
      "const router = {\n  fetch: async function",
    )
    .replace("export class TenantOutbound", "class TenantOutbound");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(
    source + "\nreturn router;",
  );
  // oxlint-disable-next-line typescript/no-implied-eval -- evaluates code taken from the real source on purpose
  const router = new Function("WorkerEntrypoint", "z", "bearerMatches", js)(
    class {},
    z,
    async (): Promise<boolean> => true,
  ) as {
    fetch: (
      request: Request,
      env: object,
      context: object,
    ) => Promise<Response>;
  };
  const keys: string[] = [];
  const work: Promise<unknown>[] = [];
  for (const tenant of ["account:a", "account:b"]) {
    const response = await router.fetch(
      new Request("https://runtime.test/mcp", {
        method: "POST",
        body: JSON.stringify({
          tenantId: tenant,
          expectedSha256: digest,
          bundleUrl: "https://bundle.test/source",
          requests: [
            {
              id: "1",
              mcpRequest: { method: "POST", headers: {}, body: "{}" },
            },
          ],
        }),
      }),
      {
        MCP_API_KEY: "test",
        BUNDLE_ORIGIN: "https://bundle.test",
        BUNDLES: {},
        LOADER: {
          get: (key: string): object => {
            keys.push(key);

            return {
              getEntrypoint: (): object => ({
                ping: (): void => {},
                fetch: async (): Promise<Response> => new Response("ok"),
              }),
            };
          },
        },
      },
      {
        waitUntil: (promise: Promise<unknown>): void => {
          work.push(promise);
        },
      },
    );
    expect(response.status).toBe(200);
    const lines = (await response.text())
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(lines.at(-1)).toEqual({ t: "end" });
  }
  await Promise.all(work);
  expect(keys).toEqual([`account:a:${digest}`, `account:b:${digest}`]);
});
