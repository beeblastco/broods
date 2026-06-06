/**
 * Uploaded custom tool executor tests.
 * Mock S3 and Kubernetes so the test stays local and deterministic.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AccountToolRecord } from "../functions/_shared/storage/index.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxRunResult,
} from "../functions/harness-processing/sandbox/types.ts";

const bundle = "export default { name: 'test_async', async execute() { return { ok: true }; } };";
const getS3ObjectUrlMock = mock(async () => "https://tool-bundles.example/account-tools/acct_test/bundles/hash.mjs?sig=test");
const runMock = mock(async (): Promise<SandboxRunResult> => ({
  ok: true,
  runtime: "bash",
  exitCode: 0,
  stdout: '\n__CUSTOM_TOOL_RESULT__{"ok":true,"result":{"type":"text","value":"done"}}\n',
  stderr: "",
  durationMs: 10,
  provider: "kubernetes",
}));
const createSandboxExecutorMock = mock((_config: SandboxExecutorConfig): SandboxExecutor => ({ run: runMock }));

mock.module("../functions/_shared/s3.ts", () => ({
  getS3ObjectUrl: getS3ObjectUrlMock,
  readS3Text: mock(async () => ""),
  s3ObjectExists: mock(async () => false),
  listS3Prefix: mock(async () => []),
  writeS3Object: mock(async () => 0),
  deleteS3Prefix: mock(async () => 0),
  isMissingS3Error: mock(() => false),
}));

beforeEach(() => {
  process.env.TOOL_BUNDLES_BUCKET_NAME = "tool-bundles";
  getS3ObjectUrlMock.mockClear();
  runMock.mockClear();
  createSandboxExecutorMock.mockClear();
});

describe("executeAccountToolInSandbox", () => {
  it("loads a bundle, verifies its hash, and delegates execution to Kubernetes", async () => {
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
    expect(getS3ObjectUrlMock).toHaveBeenCalledWith("tool-bundles", "account-tools/acct_test/bundles/hash.mjs");
    expect(createSandboxExecutorMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: "kubernetes",
      persistent: true,
      internet: true,
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
    expect(code).toContain("https://tool-bundles.example/account-tools/acct_test/bundles/hash.mjs?sig=test");
  });

  it("fails cleanly when the runner reports a missing or corrupt bundle", async () => {
    runMock.mockImplementationOnce(async () => ({
      ok: false,
      runtime: "bash",
      exitCode: 1,
      stdout: '\n__CUSTOM_TOOL_RESULT__{"ok":false,"error":"custom tool bundle hash mismatch inside runner"}\n',
      stderr: "",
      durationMs: 10,
      provider: "kubernetes",
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
