import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import type { McpRecord } from "../../../../apps/core/src/shared/domain/mcp.ts";
import { hostedMcpFetch } from "../../../../apps/core/src/harness/mcp/hosted.ts";
import { getStorage } from "../../../../apps/core/src/shared/storage.ts";

interface BridgeCase {
  name: string;
  answer: () => Promise<Response>;
  expected: string;
}

// Resolved from apps/core, which owns the dependency; formal/ has no node_modules of its own.
const CORE_ROOT = new URL("../../../../apps/core/", import.meta.url).pathname;
const { LambdaClient } = (await import(
  Bun.resolveSync("@aws-sdk/client-lambda", CORE_ROOT)
)) as typeof import("../../../../apps/core/node_modules/@aws-sdk/client-lambda");

const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;
const meter = spyOn(getStorage().budgets, "record");
const lambdaSend = spyOn(LambdaClient.prototype, "send");

function record(tenant: string): McpRecord {
  return {
    accountId: tenant,
    serverId: "k57hosted00000000000000000000000",
    projectId: "proj",
    stageId: "stage",
    name: "hosted",
    transport: "hosted",
    bundleStorageKey: "account-mcp/bundles/x.mjs",
    sha256: "b".repeat(64),
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    workersCompatible: true,
  };
}

function failing(error: Error): () => Promise<Response> {
  return (): Promise<Response> => Promise.reject(error);
}

function coded(message: string, code: string): Error {
  return Object.assign(new TypeError(message), { code: code });
}

function status(
  code: number,
  body: string,
  nothingRan = false,
): () => Promise<Response> {
  return (): Promise<Response> =>
    Promise.resolve(
      new Response(body, {
        status: code,
        headers: nothingRan ? { "x-broods-nothing-ran": "1" } : {},
      }),
    );
}

const CASES: BridgeCase[] = [
  {
    name: "plain 500",
    answer: status(500, "boom"),
    expected: "HTTP 500: boom",
  },
  { name: "empty 502", answer: status(502, ""), expected: "HTTP 502" },
  {
    name: "long 500",
    answer: status(500, "x".repeat(600)),
    expected: "x".repeat(512),
  },
  { name: "403", answer: status(403, "denied"), expected: "HTTP 403: denied" },
  {
    name: "429",
    answer: status(429, "slow down"),
    expected: "HTTP 429: slow down",
  },
  {
    name: "reset",
    answer: failing(coded("reset", "ECONNRESET")),
    expected: "reset",
  },
  {
    name: "timeout",
    answer: failing(new DOMException("timed out", "TimeoutError")),
    expected: "timed out",
  },
  {
    name: "abort",
    answer: failing(new DOMException("aborted", "AbortError")),
    expected: "aborted",
  },
  {
    name: "unknown",
    answer: failing(new Error("mystery")),
    expected: "mystery",
  },
  {
    name: "tagged empty",
    answer: status(503, "", true),
    expected: "lambda down",
  },
  {
    name: "tagged 500",
    answer: status(500, "not loaded", true),
    expected: "lambda down",
  },
  {
    name: "refused",
    answer: failing(coded("refused", "ConnectionRefused")),
    expected: "lambda down",
  },
];

beforeEach((): void => {
  delete process.env.AWS_PROFILE;
  process.env.AWS_REGION = "eu-west-1";
  process.env.AWS_ACCESS_KEY_ID = "test";
  process.env.AWS_SECRET_ACCESS_KEY = "test";
  process.env.TOOL_BUNDLES_BUCKET_NAME = "bundles";
  process.env.CLOUDFLARE_MCP_API_KEY = "bridge-key";
  process.env.CLOUDFLARE_MCP_URL = "https://mcp.example.workers.dev/mcp";
  process.env.TOOL_RUNNER_FUNCTION_NAME = "runner";
  process.env.MCP_BATCH_WINDOW_MS = "1";
  meter.mockImplementation(async (): Promise<void> => {});
  lambdaSend.mockImplementation((async (): Promise<never> => {
    throw new Error("lambda down");
  }) as never);
});

afterEach((): void => {
  globalThis.fetch = savedFetch;
  process.env = { ...savedEnv };
});

afterAll((): void => {
  meter.mockRestore();
  lambdaSend.mockRestore();
});

test.each(CASES)(
  "bridge failure: $name",
  async (bridgeCase: BridgeCase): Promise<void> => {
    globalThis.fetch = mock(bridgeCase.answer) as unknown as typeof fetch;
    const call = hostedMcpFetch({
      record: record(`acct_${bridgeCase.name.replace(" ", "_")}`),
    });

    const failure = await call("http://mcp-hosted.internal/mcp", {
      method: "POST",
      body: "{}",
    }).catch((error: unknown): Error => error as Error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(bridgeCase.expected);
  },
);
