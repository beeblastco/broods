/**
 * Uploaded custom tool executor tests.
 * Mock S3 and the sandbox executor so the test stays local and deterministic.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AccountToolRecord } from "../functions/_shared/storage/index.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxJobHandle,
  SandboxRunResult,
} from "../functions/harness-processing/sandbox/types.ts";

const bundle = "export default { name: 'test_async', async execute() { return { ok: true }; } };";
const getS3ObjectUrlMock = mock(async () => "https://tool-bundles.example/account-tools/acct_test/bundles/hash.mjs?sig=test");
const readS3BytesMock = mock(async () => new TextEncoder().encode(bundle) as Uint8Array);
const runMock = mock(async (): Promise<SandboxRunResult> => ({
  ok: true,
  runtime: "bash",
  exitCode: 0,
  stdout: '\n__CUSTOM_TOOL_RESULT__{"ok":true,"result":{"type":"text","value":"done"}}\n',
  stderr: "",
  durationMs: 10,
  provider: "sandbox",
}));
const runBackgroundMock = mock(async (): Promise<SandboxJobHandle> => ({ jobId: "job_test" }));
const execInReservedPodMock = mock(async () => ({
  stdout: JSON.stringify({ t: "final", result: { type: "text", value: "worker done" } }) + "\n",
  stderr: "",
  exitCode: 0,
}));
const createSandboxExecutorMock = mock((_config: SandboxExecutorConfig): SandboxExecutor => ({
  run: runMock,
  runBackground: runBackgroundMock,
}));
// A separate factory whose executor also exposes the resident-worker exec path.
const createWorkerExecutorMock = mock((_config: SandboxExecutorConfig): SandboxExecutor => ({
  run: runMock,
  runBackground: runBackgroundMock,
  execInReservedPod: execInReservedPodMock as unknown as SandboxExecutor["execInReservedPod"],
}));

mock.module("../functions/_shared/s3.ts", () => ({
  getS3ObjectUrl: getS3ObjectUrlMock,
  readS3Bytes: readS3BytesMock,
  readS3Text: mock(async () => ""),
  s3ObjectExists: mock(async () => false),
  listS3Prefix: mock(async () => []),
  writeS3Object: mock(async () => 0),
  deleteS3Prefix: mock(async () => 0),
  isMissingS3Error: mock(() => false),
}));

mock.module("../functions/harness-processing/self-url.ts", () => ({
  getHarnessPublicUrl: mock(async () => "https://agent.example"),
}));

beforeEach(() => {
  process.env.TOOL_BUNDLES_BUCKET_NAME = "tool-bundles";
  getS3ObjectUrlMock.mockClear();
  readS3BytesMock.mockClear();
  execInReservedPodMock.mockClear();
  createWorkerExecutorMock.mockClear();
  runMock.mockClear();
  runBackgroundMock.mockClear();
  createSandboxExecutorMock.mockClear();
});

describe("executeAccountToolInSandbox", () => {
  it("loads a bundle, verifies its hash, and delegates execution to the sandbox executor", async () => {
    const { executeAccountToolInSandbox } = await import("../functions/harness-processing/tools/custom-tool-executor.ts");

    const result = await executeAccountToolInSandbox({
      accountId: "acct_test",
      tool: accountToolRecord(sha256(bundle)),
      input: { message: "hi" },
      config: { config: { fromAgent: true } },
      options: { asyncTool: { resultId: "async_tool_1" } },
      createExecutor: createSandboxExecutorMock,
    });

    expect(result).toEqual({ type: "text", value: "done" });
    // Small bundle is inlined: read in-region, never fetched cross-cloud by the sandbox.
    expect(readS3BytesMock).toHaveBeenCalledWith("tool-bundles", "account-tools/acct_test/bundles/hash.mjs");
    expect(getS3ObjectUrlMock).not.toHaveBeenCalled();
    expect(createSandboxExecutorMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: "sandbox",
      persistent: true,
      // Public internet only: uploaded tool code must not reach the host,
      // node metadata service, or other private ranges.
      network: expect.objectContaining({
        mode: "restricted",
        allowCidrs: ["0.0.0.0/0"],
        denyCidrs: expect.arrayContaining(["169.254.0.0/16", "10.0.0.0/8"]),
      }),
      lifecycle: expect.objectContaining({
        idleTimeoutSeconds: 300,
      }),
    }));
    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({
      runtime: "bash",
      reservationKey: "custom-tool-acct-test-tool-abc123",
    }));
    const [runRequest] = runMock.mock.calls[0] as unknown as [{ code: string }];
    const code = runRequest.code;
    expect(code).toContain("node <<'__CUSTOM_TOOL_RUNNER__'");
    expect(code).toContain(Buffer.from(bundle).toString("base64"));
    expect(runBackgroundMock).not.toHaveBeenCalled();
  });

  it("falls back to a signed URL for bundles too large to inline", async () => {
    readS3BytesMock.mockImplementationOnce(async () => new Uint8Array(65 * 1024));
    const { executeAccountToolInSandbox } = await import("../functions/harness-processing/tools/custom-tool-executor.ts");

    await executeAccountToolInSandbox({
      accountId: "acct_test",
      tool: accountToolRecord(sha256(bundle)),
      input: {},
      config: {},
      options: { asyncTool: { resultId: "async_tool_1" } },
      createExecutor: createSandboxExecutorMock,
    });

    expect(getS3ObjectUrlMock).toHaveBeenCalledWith("tool-bundles", "account-tools/acct_test/bundles/hash.mjs");
    const [runRequest] = runMock.mock.calls[0] as unknown as [{ code: string }];
    expect(runRequest.code).toContain("https://tool-bundles.example/account-tools/acct_test/bundles/hash.mjs?sig=test");
  });

  it("uses the resident worker when the executor exposes execInReservedPod", async () => {
    const { executeAccountToolInSandbox } = await import("../functions/harness-processing/tools/custom-tool-executor.ts");

    const result = await executeAccountToolInSandbox({
      accountId: "acct_test",
      tool: accountToolRecord(sha256(bundle)),
      input: { message: "hi" },
      config: {},
      options: { asyncTool: { resultId: "async_tool_1" } },
      createExecutor: createWorkerExecutorMock,
    });

    expect(result).toEqual({ type: "text", value: "worker done" });
    expect(execInReservedPodMock).toHaveBeenCalledTimes(1);
    expect(runMock).not.toHaveBeenCalled();
    const [, command] = execInReservedPodMock.mock.calls[0] as unknown as [unknown, string[]];
    expect(command[0]).toBe("bash");
    expect(command[2]).toContain("http://localhost/invoke");
  });

  it("falls back to the one-shot runner when the worker is unreachable", async () => {
    execInReservedPodMock.mockImplementationOnce(async () => ({ stdout: "", stderr: "connection refused", exitCode: 7 }));
    const { executeAccountToolInSandbox } = await import("../functions/harness-processing/tools/custom-tool-executor.ts");

    const result = await executeAccountToolInSandbox({
      accountId: "acct_test",
      tool: accountToolRecord(sha256(bundle)),
      input: {},
      config: {},
      options: { asyncTool: { resultId: "async_tool_1" } },
      createExecutor: createWorkerExecutorMock,
    });

    expect(result).toEqual({ type: "text", value: "done" });
    expect(execInReservedPodMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a worker tool error without falling back", async () => {
    execInReservedPodMock.mockImplementationOnce(async () => ({ stdout: JSON.stringify({ t: "error", error: "boom" }) + "\n", stderr: "", exitCode: 0 }));
    const { executeAccountToolInSandbox } = await import("../functions/harness-processing/tools/custom-tool-executor.ts");

    await expect(executeAccountToolInSandbox({
      accountId: "acct_test",
      tool: accountToolRecord(sha256(bundle)),
      input: {},
      config: {},
      options: { asyncTool: { resultId: "async_tool_1" } },
      createExecutor: createWorkerExecutorMock,
    })).rejects.toThrow("boom");
    expect(runMock).not.toHaveBeenCalled();
  });

  it("starts uploaded async tools as sandbox background work when completion metadata is detached", async () => {
    const { executeAccountToolInSandbox } = await import("../functions/harness-processing/tools/custom-tool-executor.ts");

    const result = await executeAccountToolInSandbox({
      accountId: "acct_test",
      tool: accountToolRecord(sha256(bundle)),
      input: { message: "hi" },
      config: { config: { fromAgent: true } },
      options: {
        asyncTool: {
          resultId: "async_tool_1",
          detached: true,
          completePath: "/sandbox-jobs/async_tool_1/complete",
          completionToken: "tok_123",
        },
      },
      createExecutor: createSandboxExecutorMock,
    });

    expect(result).toEqual({ type: "text", value: "Started async tool async_tool_1" });
    expect(runMock).not.toHaveBeenCalled();
    expect(runBackgroundMock).toHaveBeenCalledWith(expect.objectContaining({
      runtime: "bash",
      reservationKey: "custom-tool-acct-test-tool-abc123",
      workspaceRoot: "/tmp",
    }));
    const [runRequest] = runBackgroundMock.mock.calls[0] as unknown as [{ code: string }];
    expect(runRequest.code).toContain("https://agent.example/sandbox-jobs/async_tool_1/complete");
    expect(runRequest.code).toContain('"completionToken":"tok_123"');
    expect(runRequest.code).toContain('"x-job-token"');
  });

  it("fails cleanly when the runner reports a missing or corrupt bundle", async () => {
    runMock.mockImplementationOnce(async () => ({
      ok: false,
      runtime: "bash",
      exitCode: 1,
      stdout: '\n__CUSTOM_TOOL_RESULT__{"ok":false,"error":"custom tool bundle hash mismatch inside runner"}\n',
      stderr: "",
      durationMs: 10,
      provider: "sandbox",
    }));
    const { executeAccountToolInSandbox } = await import("../functions/harness-processing/tools/custom-tool-executor.ts");

    await expect(executeAccountToolInSandbox({
      accountId: "acct_test",
      tool: accountToolRecord("b".repeat(64)),
      input: {},
      config: {},
      createExecutor: createSandboxExecutorMock,
    })).rejects.toThrow("custom tool bundle hash mismatch inside runner");
    expect(runMock).toHaveBeenCalled();
  });
});

describe("custom tool worker helpers", () => {
  it("builds an ensure-and-invoke command over the unix socket", async () => {
    const { buildWorkerInvokeCommand } = await import("../functions/harness-processing/tools/custom-tool-worker.ts");
    const [bin, flag, script] = buildWorkerInvokeCommand();
    expect(bin).toBe("bash");
    expect(flag).toBe("-lc");
    expect(script).toContain("/health");
    expect(script).toContain("setsid node");
    expect(script).toContain("--data-binary @-");
    expect(script).toContain("http://localhost/invoke");
  });

  it("parses NDJSON worker frames and rejects non-protocol output", async () => {
    const { parseWorkerFrame } = await import("../functions/harness-processing/tools/custom-tool-worker.ts");
    expect(parseWorkerFrame('{"t":"chunk","output":1}')).toEqual({ t: "chunk", output: 1 });
    expect(parseWorkerFrame('  {"t":"final","result":2}\n')).toEqual({ t: "final", result: 2 });
    expect(parseWorkerFrame('{"t":"end"}')).toEqual({ t: "end" });
    expect(parseWorkerFrame('{"t":"error","error":"x"}')).toEqual({ t: "error", error: "x" });
    expect(parseWorkerFrame("")).toBeNull();
    expect(parseWorkerFrame("curl: (7) connection refused")).toBeNull();
    expect(parseWorkerFrame('{"foo":1}')).toBeNull();
  });
});

describe("streamAccountToolInSandbox", () => {
  it("streams each worker chunk frame as a separate yield (last is the final output)", async () => {
    const frames = [
      JSON.stringify({ t: "chunk", output: { type: "text", value: "par" } }),
      JSON.stringify({ t: "chunk", output: { type: "text", value: "partial" } }),
      JSON.stringify({ t: "chunk", output: { type: "text", value: "partial done" } }),
      JSON.stringify({ t: "end" }),
    ].join("\n") + "\n";
    execInReservedPodMock.mockImplementationOnce(((_req: unknown, _cmd: unknown, opts?: { onStdout?: (c: string) => void }) => {
      opts?.onStdout?.(frames);
      return Promise.resolve({ stdout: frames, stderr: "", exitCode: 0 });
    }) as never);
    const { streamAccountToolInSandbox } = await import("../functions/harness-processing/tools/custom-tool-executor.ts");

    const outputs: unknown[] = [];
    for await (const output of streamAccountToolInSandbox({
      accountId: "acct_test",
      tool: accountToolRecord(sha256(bundle)),
      input: {},
      config: {},
      options: {},
      createExecutor: createWorkerExecutorMock,
    })) {
      outputs.push(output);
    }

    expect(outputs).toEqual([
      { type: "text", value: "par" },
      { type: "text", value: "partial" },
      { type: "text", value: "partial done" },
    ]);
    expect(runMock).not.toHaveBeenCalled();
  });
});

function accountToolRecord(hash: string): AccountToolRecord {
  return {
    accountId: "acct_test",
    toolId: "tool_abc123",
    name: "test_async",
    description: "Uploaded tool.",
    inputSchema: { type: "object", properties: {} },
    bundleStorageKey: "account-tools/acct_test/bundles/hash.mjs",
    sha256: hash,
    defaultConfig: { fromDefault: true },
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
