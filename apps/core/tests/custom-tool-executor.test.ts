/**
 * Custom-tool dispatch plumbing tests: isolate payload building, config merge,
 * and the NDJSON runner frame protocol. The dispatcher's runtime routing (isolate
 * vs. deferred sandbox rejection) and real isolate execution are covered in
 * isolate-executor.test.ts.
 */

import { describe, expect, it, mock } from "bun:test";
import type { AccountToolRecord } from "../src/shared/domain/account-tools.ts";
import * as realS3 from "../src/shared/s3.ts";

const bundleSource =
  "export default { name: 'echo', execute(input, options) { return input; } };";
const readS3BytesMock = mock(
  async () => new TextEncoder().encode(bundleSource) as Uint8Array,
);

// Spread the real module first: mock.module replaces it for the whole test
// process, so overriding only readS3Bytes strips every other export from the
// test files that load after this one — surfacing as an order-dependent
// "Export named 'readS3Text' not found in module".
mock.module("../src/shared/s3.ts", () => ({
  ...realS3,
  readS3Bytes: readS3BytesMock,
}));

describe("createRunnerPayload", () => {
  it("inlines the bundle and merges default + agent config", async () => {
    const { createRunnerPayload } =
      await import("../src/harness/tools/custom-tool-executor.ts");
    const payload = await createRunnerPayload({
      bucket: "tool-bundles",
      tool: accountToolRecord(),
      input: { message: "hi" },
      config: { config: { agentKey: "agent" } },
    });

    expect(payload).toEqual({
      bundleSourceB64: Buffer.from(bundleSource).toString("base64"),
      expectedSha256: "abc123",
      toolName: "echo",
      input: { message: "hi" },
      config: { fromDefault: true, agentKey: "agent" },
    });
  });

  it("lets agent config override the tool default config", async () => {
    const { createRunnerPayload } =
      await import("../src/harness/tools/custom-tool-executor.ts");
    const payload = await createRunnerPayload({
      bucket: "tool-bundles",
      tool: accountToolRecord(),
      input: {},
      config: { config: { fromDefault: "overridden" } },
    });

    expect(payload.config).toEqual({ fromDefault: "overridden" });
  });

  it("includes toolCallId only when the AI SDK options carry one", async () => {
    const { createRunnerPayload } =
      await import("../src/harness/tools/custom-tool-executor.ts");

    const withId = await createRunnerPayload({
      bucket: "tool-bundles",
      tool: accountToolRecord(),
      input: {},
      config: {},
      toolCallId: "call_abc",
    });
    expect(withId.toolCallId).toBe("call_abc");

    const withoutId = await createRunnerPayload({
      bucket: "tool-bundles",
      tool: accountToolRecord(),
      input: {},
      config: {},
    });
    expect("toolCallId" in withoutId).toBe(false);
  });
});

describe("AI SDK options extraction", () => {
  it("reads toolCallId and abortSignal, ignoring wrong shapes", async () => {
    const { toolCallIdFromOptions, abortSignalFromOptions } =
      await import("../src/harness/tools/custom-tool-executor.ts");
    const controller = new AbortController();

    expect(
      toolCallIdFromOptions({
        toolCallId: "c1",
        abortSignal: controller.signal,
      }),
    ).toBe("c1");
    expect(toolCallIdFromOptions({})).toBeUndefined();
    expect(toolCallIdFromOptions(undefined)).toBeUndefined();

    expect(abortSignalFromOptions({ abortSignal: controller.signal })).toBe(
      controller.signal,
    );
    expect(abortSignalFromOptions({ abortSignal: "nope" })).toBeUndefined();
    expect(abortSignalFromOptions(undefined)).toBeUndefined();
  });
});

describe("runner frame protocol", () => {
  it("parses NDJSON frames and rejects non-protocol lines", async () => {
    const { parseToolRunnerFrame } =
      await import("../src/harness/tools/custom-tool-executor.ts");

    expect(parseToolRunnerFrame('{"t":"chunk","output":{"n":1}}')).toEqual({
      t: "chunk",
      output: { n: 1 },
    });
    expect(parseToolRunnerFrame('{"t":"final","result":42}')).toEqual({
      t: "final",
      result: 42,
    });
    expect(parseToolRunnerFrame('{"t":"end"}')).toEqual({ t: "end" });
    expect(parseToolRunnerFrame("")).toBeNull();
    expect(parseToolRunnerFrame("curl: (7) connection refused")).toBeNull();
    expect(parseToolRunnerFrame('{"t":"bogus"}')).toBeNull();
  });

  it("FrameQueue yields whole frames as lines arrive, then flushes on close", async () => {
    const { FrameQueue } =
      await import("../src/harness/tools/custom-tool-executor.ts");
    const queue = new FrameQueue();
    const collected: unknown[] = [];
    const consume = (async () => {
      for await (const frame of queue.frames()) collected.push(frame);
    })();

    queue.push('{"t":"chunk","output":1}\n{"t":"chu');
    queue.push('nk","output":2}\n');
    queue.push('{"t":"final","result":3}'); // no trailing newline — flushed by close()
    queue.close();
    await consume;

    expect(collected).toEqual([
      { t: "chunk", output: 1 },
      { t: "chunk", output: 2 },
      { t: "final", result: 3 },
    ]);
  });
});

function accountToolRecord(): AccountToolRecord {
  return {
    accountId: "acct_test",
    toolId: "qs78zwc4z4q5ysxm74fgrhd13s88xxt",
    name: "echo",
    description: "Uploaded tool.",
    inputSchema: { type: "object", properties: {} },
    bundleStorageKey: "account-tools/acct_test/bundles/hash.mjs",
    sha256: "abc123",
    runtime: "isolate",
    defaultConfig: { fromDefault: true },
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
}
