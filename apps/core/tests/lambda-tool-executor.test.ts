/**
 * Sandbox-tier Lambda invoker tests.
 * Mock S3 (bundle bytes) and inject a fake LambdaClient so the frame-replay,
 * error surfacing, and abort forwarding are covered without invoking real AWS.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { LambdaClient } from "@aws-sdk/client-lambda";
import type { AccountToolRecord } from "../src/shared/domain/account-tools.ts";

const bundle =
  "export default { name: 'sandbox_tool', execute(input) { return { echo: input }; } };";

mock.module("../src/shared/s3.ts", () => ({
  readS3Bytes: async () => new TextEncoder().encode(bundle),
}));

beforeEach(() => {
  process.env.TOOL_BUNDLES_BUCKET_NAME = "tool-bundles";
  process.env.TOOL_RUNNER_FUNCTION_NAME = "tool-runner";
});

describe("streamAccountToolInLambda", () => {
  it("replays chunk frames then the final result", async () => {
    const client = fakeClient(
      response({
        stdout:
          frame({ t: "chunk", output: { step: 1 } }) +
          frame({ t: "chunk", output: { step: 2 } }) +
          frame({ t: "final", result: { step: 2 } }),
      }),
    );
    const outputs = await collect(client);

    expect(outputs).toEqual([{ step: 1 }, { step: 2 }, { step: 2 }]);
  });

  it("returns the sole final result for a non-streaming tool", async () => {
    const client = fakeClient(
      response({ stdout: frame({ t: "final", result: { ok: true } }) }),
    );

    expect(await collect(client)).toEqual([{ ok: true }]);
  });

  it("throws when the child emitted an error frame", async () => {
    const client = fakeClient(
      response({ stdout: frame({ t: "error", error: "tool blew up" }) }),
    );

    await expect(collect(client)).rejects.toThrow("tool blew up");
  });

  it("throws when the handler reports an error (no frames)", async () => {
    const client = fakeClient(response({ error: "child exited: signal SIGKILL" }));

    await expect(collect(client)).rejects.toThrow("child exited: signal SIGKILL");
  });

  it("throws on a Lambda FunctionError, surfacing errorMessage", async () => {
    const client = {
      send: mock(async () => ({
        FunctionError: "Unhandled",
        Payload: new TextEncoder().encode(
          JSON.stringify({ errorMessage: "boom in handler" }),
        ),
      })),
    } as unknown as LambdaClient;

    await expect(collect(client)).rejects.toThrow("boom in handler");
  });

  it("throws when the runner returns no terminal frame", async () => {
    const client = fakeClient(response({ stdout: "" }));

    await expect(collect(client)).rejects.toThrow(/did not return a result/);
  });

  it("forwards the AI SDK abortSignal to the Lambda send call", async () => {
    let seen: AbortSignal | undefined;
    const client = {
      send: mock(async (_command: unknown, options?: { abortSignal?: AbortSignal }) => {
        seen = options?.abortSignal;
        return response({ stdout: frame({ t: "final", result: 1 }) });
      }),
    } as unknown as LambdaClient;
    const controller = new AbortController();
    await collect(client, { abortSignal: controller.signal });

    expect(seen).toBe(controller.signal);
  });
});

async function collect(
  client: LambdaClient,
  options?: unknown,
): Promise<unknown[]> {
  const { streamAccountToolInLambda } =
    await import("../src/harness/sandbox/lambda-tool-executor.ts");
  const outputs: unknown[] = [];
  for await (const output of streamAccountToolInLambda(
    {
      accountId: "acct_test",
      tool: toolRecord(),
      input: { message: "hi" },
      config: {},
      ...(options !== undefined ? { options } : {}),
    },
    client,
  )) {
    outputs.push(output);
  }
  return outputs;
}

function fakeClient(payload: { Payload: Uint8Array }): LambdaClient {
  return { send: mock(async () => payload) } as unknown as LambdaClient;
}

function frame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function response(body: unknown): { Payload: Uint8Array } {
  return { Payload: new TextEncoder().encode(JSON.stringify(body)) };
}

function toolRecord(): AccountToolRecord {
  return {
    accountId: "acct_test",
    toolId: "qs78zwc4z4q5ysxm74fgrhd13s88xxt",
    name: "sandbox_tool",
    description: "Uploaded sandbox tool.",
    inputSchema: { type: "object", properties: {} },
    bundleStorageKey: "account-tools/acct_test/bundles/hash.mjs",
    sha256: new Bun.CryptoHasher("sha256").update(bundle).digest("hex"),
    runtime: "sandbox",
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
}
