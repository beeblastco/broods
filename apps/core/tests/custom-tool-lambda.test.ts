/**
 * Sandbox-tier Lambda invoker tests.
 * Mock S3 (bundle bytes) and inject a fake LambdaClient whose EventStream stands
 * in for InvokeWithResponseStream, so incremental frame delivery, chunk
 * reassembly, error surfacing, and abort forwarding are covered without AWS.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { LambdaClient } from "@aws-sdk/client-lambda";
import type { AccountToolRecord } from "../src/shared/domain/account-tools.ts";
import type { ExecuteAccountToolOptions } from "../src/harness/custom-tools/payload.ts";
import * as realS3 from "../src/shared/s3.ts";

const bundle =
  "export default { name: 'sandbox_tool', execute(input) { return { echo: input }; } };";

// Spread the real module: mock.module replaces it process-wide, so overriding
// only these two would strip every other export for later test files.
mock.module("../src/shared/s3.ts", () => ({
  ...realS3,
  readS3Bytes: async () => new TextEncoder().encode(bundle),
  getS3ObjectUrl: async () => "https://tool-bundles.s3.amazonaws.com/signed",
}));

beforeEach(() => {
  process.env.TOOL_BUNDLES_BUCKET_NAME = "tool-bundles";
  process.env.TOOL_RUNNER_FUNCTION_NAME = "tool-runner";
});

describe("streamInLambda", () => {
  it("replays chunk frames then the final result", async () => {
    const client = fakeClient([
      frame({ t: "chunk", output: { step: 1 } }),
      frame({ t: "chunk", output: { step: 2 } }),
      frame({ t: "final", result: { step: 2 } }),
    ]);
    const outputs = await collect(client);

    expect(outputs).toEqual([{ step: 1 }, { step: 2 }, { step: 2 }]);
  });

  it("yields each frame before the Lambda has sent the next one", async () => {
    // The point of response streaming: a buffered invoker cannot pass this,
    // because it only yields once the whole payload has arrived.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = fakeClient([
      frame({ t: "chunk", output: { step: 1 } }),
      gate.then(() => frame({ t: "final", result: { step: 2 } })),
    ]);

    const stream = streamOf(client);
    const first = await stream.next();

    expect(first.value).toEqual({ step: 1 });

    release();

    expect((await stream.next()).value).toEqual({ step: 2 });
  });

  it("reassembles a frame split across payload chunks", async () => {
    const line = frame({ t: "final", result: { ok: true } });
    const client = fakeClient([line.slice(0, 9), line.slice(9)]);

    expect(await collect(client)).toEqual([{ ok: true }]);
  });

  it("returns the sole final result for a non-streaming tool", async () => {
    const client = fakeClient([frame({ t: "final", result: { ok: true } })]);

    expect(await collect(client)).toEqual([{ ok: true }]);
  });

  it("throws when the child emitted an error frame", async () => {
    const client = fakeClient([frame({ t: "error", error: "tool blew up" })]);

    await expect(collect(client)).rejects.toThrow("tool blew up");
  });

  it("throws on a Lambda-side failure reported by InvokeComplete", async () => {
    const client = {
      send: mock(async () => ({
        EventStream: (async function* () {
          yield {
            InvokeComplete: {
              ErrorCode: "Unhandled",
              ErrorDetails: "boom in handler",
            },
          };
        })(),
      })),
    } as unknown as LambdaClient;

    await expect(collect(client)).rejects.toThrow("boom in handler");
  });

  it("throws when the runner returns no terminal frame", async () => {
    const client = fakeClient([]);

    await expect(collect(client)).rejects.toThrow(/did not return a result/);
  });

  it("sends a presigned URL rather than the bundle bytes", async () => {
    // Inlining the bundle spends the 6 MB invoke-payload quota on it, which caps
    // uploads near 4.4 MB after base64. The payload must stay metadata-sized.
    let sent: Record<string, unknown> | undefined;
    const client = {
      send: mock(async (command: { input: { Payload: Uint8Array } }) => {
        sent = JSON.parse(new TextDecoder().decode(command.input.Payload));
        return {
          EventStream: (async function* () {
            yield payloadChunk(frame({ t: "final", result: 1 }));
          })(),
        };
      }),
    } as unknown as LambdaClient;
    await collect(client);

    expect(sent?.bundleUrl).toBe(
      "https://tool-bundles.s3.amazonaws.com/signed",
    );
    expect(sent).not.toHaveProperty("bundleSourceB64");
  });

  it("forwards the AI SDK abortSignal to the Lambda send call", async () => {
    let seen: AbortSignal | undefined;
    const client = {
      send: mock(
        async (_command: unknown, options?: { abortSignal?: AbortSignal }) => {
          seen = options?.abortSignal;
          return {
            EventStream: (async function* () {
              yield payloadChunk(frame({ t: "final", result: 1 }));
            })(),
          };
        },
      ),
    } as unknown as LambdaClient;
    const controller = new AbortController();
    await collect(client, { abortSignal: controller.signal });

    expect(seen).toBe(controller.signal);
  });
});

describe("streamAccountTool tier dispatch", () => {
  it("routes a sandbox tool to the sandbox executor and forwards every frame", async () => {
    const { streamAccountTool } =
      await import("../src/harness/custom-tools/executor.ts");
    let seen: ExecuteAccountToolOptions | undefined;
    const options: ExecuteAccountToolOptions = {
      accountId: "acct_test",
      tool: toolRecord(),
      input: { message: "hi" },
      config: {},
      sandboxExecutor: async function* (received) {
        seen = received;
        yield { step: 1 };
        yield { step: 2 };
      },
    };

    const outputs: unknown[] = [];
    for await (const output of streamAccountTool(options)) outputs.push(output);

    expect(seen).toBe(options);
    expect(outputs).toEqual([{ step: 1 }, { step: 2 }]);
  });

  it("keeps an isolate tool off the Lambda", async () => {
    const { streamAccountTool } =
      await import("../src/harness/custom-tools/executor.ts");
    const sandboxExecutor = mock(async function* () {
      yield { unreachable: true };
    });
    const outputs: unknown[] = [];
    for await (const output of streamAccountTool({
      accountId: "acct_test",
      tool: { ...toolRecord(), runtime: "isolate" },
      input: { message: "hi" },
      config: {},
      sandboxExecutor,
      isolateExecutor: async function* () {
        yield { fromIsolate: true };
      },
    })) {
      outputs.push(output);
    }

    expect(sandboxExecutor).not.toHaveBeenCalled();
    expect(outputs).toEqual([{ fromIsolate: true }]);
  });
});

async function collect(
  client: LambdaClient,
  options?: unknown,
): Promise<unknown[]> {
  const outputs: unknown[] = [];
  for await (const output of streamOf(client, options)) outputs.push(output);

  return outputs;
}

// Each entry is one PayloadChunk; a promise entry lets a test hold the stream
// open and prove the invoker is not waiting for the whole response.
function fakeClient(chunks: Array<string | Promise<string>>): LambdaClient {
  return {
    send: mock(async () => ({
      EventStream: (async function* () {
        for (const chunk of chunks) yield payloadChunk(await chunk);
        yield { InvokeComplete: {} };
      })(),
    })),
  } as unknown as LambdaClient;
}

function frame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function payloadChunk(text: string): {
  PayloadChunk: { Payload: Uint8Array };
} {
  return { PayloadChunk: { Payload: new TextEncoder().encode(text) } };
}

async function* streamOf(
  client: LambdaClient,
  options?: unknown,
): AsyncGenerator<unknown, void, void> {
  const { streamInLambda } =
    await import("../src/harness/custom-tools/executor.ts");
  yield* streamInLambda(
    {
      accountId: "acct_test",
      tool: toolRecord(),
      input: { message: "hi" },
      config: {},
      ...(options !== undefined ? { options } : {}),
    },
    client,
  );
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
