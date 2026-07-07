/**
 * V8 isolate custom-tool tier tests.
 * Real isolated-vm runner tests run when BROODS_TEST_ISOLATE_RUNNER_PATH points
 * at a runner.mjs whose directory has node_modules/isolated-vm installed.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { spawn } from "node:child_process";
import type { AccountToolRecord } from "../src/shared/storage/index.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxJobHandle,
  SandboxRunResult,
} from "../src/harness/sandbox/types.ts";

const bundle = "export default { name: 'test_tool', async execute(ctx, input) { return { echo: input, config: ctx.config }; } };";
const readS3BytesMock = mock(async () => new TextEncoder().encode(bundle) as Uint8Array);
const getS3ObjectUrlMock = mock(async () => "https://tool-bundles.example/tool.mjs");
const runMock = mock(async (): Promise<SandboxRunResult> => ({
  ok: true,
  runtime: "bash",
  exitCode: 0,
  stdout: '\n__CUSTOM_TOOL_RESULT__{"ok":true,"result":{"sandbox":true}}\n',
  stderr: "",
  durationMs: 10,
  provider: "sandbox",
}));
const runBackgroundMock = mock(async (): Promise<SandboxJobHandle> => ({ jobId: "job_test" }));
const createSandboxExecutorMock = mock((_config: SandboxExecutorConfig): SandboxExecutor => ({
  run: runMock,
  runBackground: runBackgroundMock,
}));

mock.module("../src/shared/s3.ts", () => ({
  getS3ObjectUrl: getS3ObjectUrlMock,
  readS3Bytes: readS3BytesMock,
  readS3Text: mock(async () => ""),
  s3ObjectExists: mock(async () => false),
  listS3Prefix: mock(async () => []),
  writeS3Object: mock(async () => 0),
  deleteS3Prefix: mock(async () => 0),
  isMissingS3Error: mock(() => false),
}));

mock.module("../src/harness/self-url.ts", () => ({
  getHarnessPublicUrl: mock(() => "https://agent.example"),
}));

beforeEach(() => {
  process.env.TOOL_BUNDLES_BUCKET_NAME = "tool-bundles";
  readS3BytesMock.mockClear();
  getS3ObjectUrlMock.mockClear();
  runMock.mockClear();
  runBackgroundMock.mockClear();
  createSandboxExecutorMock.mockClear();
});

describe("custom tool runtime defaulting", () => {
  it("defaults pure bundles to isolate and Node-shaped bundles to sandbox", async () => {
    const { normalizeAccountToolUpload } = await import("../src/shared/storage/account-tools.ts");

    expect(normalizeAccountToolUpload({
      name: "pure",
      description: "Pure.",
      inputSchema: { type: "object" },
      bundle: "export default { execute() { return 1; } };",
    }, { requireBundle: true }).runtime).toBe("isolate");

    expect(normalizeAccountToolUpload({
      name: "nodey",
      description: "Node.",
      inputSchema: { type: "object" },
      bundle: "import fs from 'node:fs'; export default { execute() { return fs; } };",
    }, { requireBundle: true }).runtime).toBe("sandbox");

    expect(normalizeAccountToolUpload({
      name: "dep",
      description: "Dep.",
      inputSchema: { type: "object" },
      bundle: "import leftPad from 'left-pad'; export default { execute() { return leftPad; } };",
    }, { requireBundle: true }).runtime).toBe("sandbox");
  });

  it("lets an explicit runtime override the scan", async () => {
    const { normalizeAccountToolUpload } = await import("../src/shared/storage/account-tools.ts");

    expect(normalizeAccountToolUpload({
      name: "explicit",
      description: "Explicit.",
      inputSchema: { type: "object" },
      runtime: "isolate",
      bundle: "const fs = require('node:fs'); export default { execute() { return fs; } };",
    }, { requireBundle: true }).runtime).toBe("isolate");
  });
});

describe("streamAccountTool dispatcher", () => {
  it("routes sandbox tools to the sandbox path", async () => {
    const { streamAccountTool } = await import("../src/harness/tools/custom-tool-executor.ts");
    const outputs: unknown[] = [];
    for await (const output of streamAccountTool({
      accountId: "acct_test",
      tool: accountToolRecord("sandbox"),
      input: {},
      config: {},
      createExecutor: createSandboxExecutorMock,
    })) {
      outputs.push(output);
    }

    expect(outputs).toEqual([{ sandbox: true }]);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("routes isolate tools to the isolate path", async () => {
    const isolateExecutor = mock(async function* () {
      yield { isolate: true };
    });
    const { streamAccountTool } = await import("../src/harness/tools/custom-tool-executor.ts");
    const outputs: unknown[] = [];
    for await (const output of streamAccountTool({
      accountId: "acct_test",
      tool: accountToolRecord("isolate"),
      input: {},
      config: {},
      createExecutor: createSandboxExecutorMock,
      isolateExecutor,
    })) {
      outputs.push(output);
    }

    expect(outputs).toEqual([{ isolate: true }]);
    expect(isolateExecutor).toHaveBeenCalledTimes(1);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("keeps detached async tools on the sandbox background path", async () => {
    const isolateExecutor = mock(async function* () {
      yield { isolate: true };
    });
    const { streamAccountTool } = await import("../src/harness/tools/custom-tool-executor.ts");
    const outputs: unknown[] = [];
    for await (const output of streamAccountTool({
      accountId: "acct_test",
      tool: accountToolRecord("isolate"),
      input: {},
      config: {},
      options: {
        asyncTool: {
          resultId: "async_tool_1",
          detached: true,
          completePath: "/sandbox-jobs/async_tool_1/complete",
          completionToken: "tok_123",
        },
      },
      createExecutor: createSandboxExecutorMock,
      isolateExecutor,
    })) {
      outputs.push(output);
    }

    expect(outputs).toEqual([{ type: "text", value: "Started async tool async_tool_1" }]);
    expect(runBackgroundMock).toHaveBeenCalledTimes(1);
    expect(isolateExecutor).not.toHaveBeenCalled();
  });
});

const runnerPath = process.env.BROODS_TEST_ISOLATE_RUNNER_PATH;
const realRunnerIt = runnerPath ? it : it.skip;

describe("isolate runner", () => {
  realRunnerIt("runs a trivial bundle and returns the final result", async () => {
    const result = await runRealRunner("export default { name: 'echo', execute(ctx, input) { return { echo: input }; } };", {
      toolName: "echo",
      input: { message: "hi" },
    });

    expect(result.frames).toEqual([{ t: "final", result: { echo: { message: "hi" } } }]);
  });

  realRunnerIt("streams async-generator chunks and repeats the last chunk as final", async () => {
    const result = await runRealRunner("export default { name: 'streamer', async *execute() { yield { step: 1 }; yield { step: 2 }; } };", {
      toolName: "streamer",
    });

    expect(result.frames).toEqual([
      { t: "chunk", output: { step: 1 } },
      { t: "chunk", output: { step: 2 } },
      { t: "final", result: { step: 2 } },
    ]);
  });

  realRunnerIt("surfaces thrown tool errors", async () => {
    const result = await runRealRunner("export default { name: 'boom', execute() { throw new Error('boom'); } };", {
      toolName: "boom",
    });

    expect(result.frames).toEqual([{ t: "error", error: "boom" }]);
    expect(result.exitCode).toBe(1);
  });

  realRunnerIt("rejects sha256 mismatches", async () => {
    const result = await runRealRunner("export default { name: 'bad', execute() { return 1; } };", {
      toolName: "bad",
      expectedSha256: "b".repeat(64),
    });

    expect(result.frames).toEqual([{ t: "error", error: "custom tool bundle hash mismatch inside isolate runner" }]);
    expect(result.exitCode).toBe(1);
  });

  realRunnerIt("enforces timeout", async () => {
    const result = await runRealRunner("export default { name: 'slow', execute() { while (true) {} } };", {
      toolName: "slow",
      env: { ISOLATE_RUNNER_TIMEOUT_SECONDS: "1" },
    });

    expect(result.frames.at(-1)).toEqual({ t: "error", error: "custom tool isolate execution timed out" });
    expect(result.exitCode).toBe(1);
  });

  realRunnerIt("provides timers, console, and a global fetch to the bundle", async () => {
    const result = await runRealRunner(
      `export default { name: "runtime_surface", async *execute(ctx, input) {
        console.log("hello from the isolate");
        const started = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield { waitedMs: Date.now() - started >= 10 };
        const cancelled = setTimeout(() => { throw new Error("should not fire"); }, 5);
        clearTimeout(cancelled);
        await new Promise((resolve) => setTimeout(resolve, 15));
        yield {
          waited: true,
          hasFetch: typeof fetch === "function",
          fetchIsCtxFetch: fetch === ctx.fetch,
          hasMicrotask: typeof queueMicrotask === "function",
        };
      } };`,
      { toolName: "runtime_surface", input: {} },
    );

    expect(result.frames).toEqual([
      { t: "chunk", output: { waitedMs: true } },
      {
        t: "chunk",
        output: { waited: true, hasFetch: true, fetchIsCtxFetch: true, hasMicrotask: true },
      },
      {
        t: "final",
        result: { waited: true, hasFetch: true, fetchIsCtxFetch: true, hasMicrotask: true },
      },
    ]);
    expect(result.stderr).toContain("[tool:log] hello from the isolate");
  });

  realRunnerIt("supports setInterval with clearInterval", async () => {
    const result = await runRealRunner(
      `export default { name: "interval_tool", async execute() {
        let ticks = 0;
        await new Promise((resolve) => {
          const id = setInterval(() => {
            ticks += 1;
            if (ticks >= 3) { clearInterval(id); resolve(); }
          }, 5);
        });
        return { ticks };
      } };`,
      { toolName: "interval_tool", input: {} },
    );

    expect(result.frames).toEqual([{ t: "final", result: { ticks: 3 } }]);
  });
});

async function runRealRunner(
  source: string,
  options: {
    toolName: string;
    input?: unknown;
    expectedSha256?: string;
    env?: Record<string, string>;
  },
): Promise<{ frames: unknown[]; exitCode: number | null; stderr: string }> {
  const expectedSha256 = options.expectedSha256 ?? sha256(source);
  const child = spawn("node", [runnerPath!], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...options.env,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(JSON.stringify({
    bundleSourceB64: Buffer.from(source).toString("base64"),
    expectedSha256,
    toolName: options.toolName,
    input: options.input ?? {},
    config: {},
  }) + "\n");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });

  return {
    frames: stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)),
    exitCode,
    stderr,
  };
}

function accountToolRecord(runtime: AccountToolRecord["runtime"]): AccountToolRecord {
  return {
    accountId: "acct_test",
    toolId: "tool_abc123",
    name: "test_tool",
    description: "Uploaded tool.",
    inputSchema: { type: "object", properties: {} },
    bundleStorageKey: "account-tools/acct_test/bundles/hash.mjs",
    sha256: sha256(bundle),
    runtime,
    defaultConfig: { fromDefault: true },
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
