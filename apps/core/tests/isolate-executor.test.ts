/**
 * V8 isolate custom-tool tier tests.
 * Real isolated-vm runner tests run when BROODS_TEST_ISOLATE_RUNNER_PATH points
 * at a runner.mjs whose directory has node_modules/isolated-vm installed.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountToolRecord } from "../src/shared/domain/account-tools.ts";

const bundle =
  "export default { name: 'test_tool', async execute(input, options) { return { echo: input, config: options.context.config }; } };";

describe("custom tool runtime defaulting", () => {
  it("defaults pure bundles to isolate and Node-shaped bundles to sandbox", async () => {
    const { normalizeAccountToolUpload } =
      await import("../src/shared/domain/account-tools.ts");

    expect(
      normalizeAccountToolUpload(
        {
          name: "pure",
          description: "Pure.",
          inputSchema: { type: "object" },
          bundle: "export default { execute() { return 1; } };",
        },
        { requireBundle: true },
      ).runtime,
    ).toBe("isolate");

    expect(
      normalizeAccountToolUpload(
        {
          name: "nodey",
          description: "Node.",
          inputSchema: { type: "object" },
          bundle:
            "import fs from 'node:fs'; export default { execute() { return fs; } };",
        },
        { requireBundle: true },
      ).runtime,
    ).toBe("sandbox");

    expect(
      normalizeAccountToolUpload(
        {
          name: "dep",
          description: "Dep.",
          inputSchema: { type: "object" },
          bundle:
            "import leftPad from 'left-pad'; export default { execute() { return leftPad; } };",
        },
        { requireBundle: true },
      ).runtime,
    ).toBe("sandbox");
  });

  it("lets an explicit runtime override the scan", async () => {
    const { normalizeAccountToolUpload } =
      await import("../src/shared/domain/account-tools.ts");

    expect(
      normalizeAccountToolUpload(
        {
          name: "explicit",
          description: "Explicit.",
          inputSchema: { type: "object" },
          runtime: "isolate",
          bundle:
            "const fs = require('node:fs'); export default { execute() { return fs; } };",
        },
        { requireBundle: true },
      ).runtime,
    ).toBe("isolate");
  });
});

describe("streamAccountTool dispatcher", () => {
  async function drain(
    gen: AsyncGenerator<unknown, void, void>,
  ): Promise<void> {
    for await (const _ of gen) {
      /* drain */
    }
  }

  it("routes isolate tools to the isolate path", async () => {
    const isolateExecutor = mock(async function* () {
      yield { isolate: true };
    });
    const { streamAccountTool } =
      await import("../src/harness/tools/custom-tool-executor.ts");
    const outputs: unknown[] = [];
    for await (const output of streamAccountTool({
      accountId: "acct_test",
      tool: accountToolRecord("isolate"),
      input: {},
      config: {},
      isolateExecutor,
    })) {
      outputs.push(output);
    }

    expect(outputs).toEqual([{ isolate: true }]);
    expect(isolateExecutor).toHaveBeenCalledTimes(1);
  });

  it("rejects sandbox-runtime tools with a deferred (#82) error", async () => {
    const isolateExecutor = mock(async function* () {
      yield { isolate: true };
    });
    const { streamAccountTool } =
      await import("../src/harness/tools/custom-tool-executor.ts");

    await expect(
      drain(
        streamAccountTool({
          accountId: "acct_test",
          tool: accountToolRecord("sandbox"),
          input: {},
          config: {},
          isolateExecutor,
        }),
      ),
    ).rejects.toThrow(/not yet supported off Lambda/);
    expect(isolateExecutor).not.toHaveBeenCalled();
  });

  it("rejects detached-async tools with a deferred (#82) error", async () => {
    const isolateExecutor = mock(async function* () {
      yield { isolate: true };
    });
    const { streamAccountTool } =
      await import("../src/harness/tools/custom-tool-executor.ts");

    await expect(
      drain(
        streamAccountTool({
          accountId: "acct_test",
          tool: accountToolRecord("isolate"),
          input: {},
          config: {},
          options: {
            asyncTool: {
              resultId: "async_tool_1",
              detached: true,
              completePath: "/async-tools/async_tool_1/complete",
              completionToken: "tok_123",
            },
          },
          isolateExecutor,
        }),
      ),
    ).rejects.toThrow(/not yet supported off Lambda/);
    expect(isolateExecutor).not.toHaveBeenCalled();
  });
});

const runnerPath = process.env.BROODS_TEST_ISOLATE_RUNNER_PATH;
const realRunnerIt = runnerPath ? it : it.skip;

describe("isolate runner", () => {
  realRunnerIt(
    "runs a trivial bundle and returns the final result",
    async () => {
      const result = await runRealRunner(
        "export default { name: 'echo', execute(input, options) { return { echo: input }; } };",
        {
          toolName: "echo",
          input: { message: "hi" },
        },
      );

      expect(result.frames).toEqual([
        { t: "final", result: { echo: { message: "hi" } } },
      ]);
    },
  );

  realRunnerIt(
    "streams async-generator chunks and repeats the last chunk as final",
    async () => {
      const result = await runRealRunner(
        "export default { name: 'streamer', async *execute() { yield { step: 1 }; yield { step: 2 }; } };",
        {
          toolName: "streamer",
        },
      );

      expect(result.frames).toEqual([
        { t: "chunk", output: { step: 1 } },
        { t: "chunk", output: { step: 2 } },
        { t: "final", result: { step: 2 } },
      ]);
    },
  );

  realRunnerIt("surfaces thrown tool errors", async () => {
    const result = await runRealRunner(
      "export default { name: 'boom', execute() { throw new Error('boom'); } };",
      {
        toolName: "boom",
      },
    );

    expect(result.frames).toEqual([{ t: "error", error: "boom" }]);
    expect(result.exitCode).toBe(1);
  });

  realRunnerIt("rejects sha256 mismatches", async () => {
    const result = await runRealRunner(
      "export default { name: 'bad', execute() { return 1; } };",
      {
        toolName: "bad",
        expectedSha256: "b".repeat(64),
      },
    );

    expect(result.frames).toEqual([
      {
        t: "error",
        error: "custom tool bundle hash mismatch inside isolate runner",
      },
    ]);
    expect(result.exitCode).toBe(1);
  });

  realRunnerIt("enforces timeout", async () => {
    const result = await runRealRunner(
      "export default { name: 'slow', execute() { while (true) {} } };",
      {
        toolName: "slow",
        env: { ISOLATE_RUNNER_TIMEOUT_SECONDS: "1" },
      },
    );

    expect(result.frames.at(-1)).toEqual({
      t: "error",
      error: "custom tool isolate execution timed out",
    });
    expect(result.exitCode).toBe(1);
  });

  realRunnerIt(
    "provides timers, console, and a global fetch to the bundle",
    async () => {
      const result = await runRealRunner(
        `export default { name: "runtime_surface", async *execute(input, options) {
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
          fetchIsCtxFetch: fetch === options.context.fetch,
          hasMicrotask: typeof queueMicrotask === "function",
        };
      } };`,
        { toolName: "runtime_surface", input: {} },
      );

      expect(result.frames).toEqual([
        { t: "chunk", output: { waitedMs: true } },
        {
          t: "chunk",
          output: {
            waited: true,
            hasFetch: true,
            fetchIsCtxFetch: true,
            hasMicrotask: true,
          },
        },
        {
          t: "final",
          result: {
            waited: true,
            hasFetch: true,
            fetchIsCtxFetch: true,
            hasMicrotask: true,
          },
        },
      ]);
      expect(result.stderr).toContain("[tool:log] hello from the isolate");
    },
  );

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

  realRunnerIt(
    "passes SDK execution options (context, toolCallId, abortSignal) to the tool",
    async () => {
      const result = await runRealRunner(
        `export default { name: "opts", execute(input, options) {
          return {
            echo: input,
            cfg: options.context.config,
            callId: options.toolCallId,
            signalOk: options.abortSignal != null && options.abortSignal.aborted === false,
          };
        } };`,
        {
          toolName: "opts",
          input: { q: "hi" },
          config: { k: "v" },
          toolCallId: "call_123",
        },
      );

      expect(result.frames).toEqual([
        {
          t: "final",
          result: {
            echo: { q: "hi" },
            cfg: { k: "v" },
            callId: "call_123",
            signalOk: true,
          },
        },
      ]);
    },
  );

  realRunnerIt(
    "trips the in-isolate abortSignal when the host sends SIGUSR2",
    async () => {
      const result = await runRealRunner(
        `export default { name: "abortable", async execute(input, options) {
          return await new Promise((resolve) => {
            options.abortSignal.addEventListener("abort", () => resolve({ aborted: true }));
          });
        } };`,
        { toolName: "abortable", input: {}, abortAfterMs: 300 },
      );

      expect(result.frames.at(-1)).toEqual({
        t: "final",
        result: { aborted: true },
      });
    },
  );
});

describe("isolate pooled worker (--pool)", () => {
  realRunnerIt(
    "emits ready, streams chunks, meters, and returns final",
    async () => {
      const { byCall, ready } = await runPoolRunner([
        {
          callId: "1",
          tenantId: "acct_a",
          toolName: "streamer",
          source:
            "export default { name: 'streamer', async *execute() { yield { step: 1 }; yield { step: 2 }; } };",
        },
      ]);

      expect(ready).toEqual({ t: "ready" });
      const frames = byCall.get("1")!;
      expect(frames.filter((f) => f.t === "chunk")).toEqual([
        { t: "chunk", callId: "1", output: { step: 1 } },
        { t: "chunk", callId: "1", output: { step: 2 } },
      ]);
      expect(frames.find((f) => f.t === "final")).toEqual({
        t: "final",
        callId: "1",
        result: { step: 2 },
      });
      const meter = frames.find((f) => f.t === "meter");
      expect(meter?.tenantId).toBe("acct_a");
      expect(typeof meter?.cpuMs).toBe("number");
    },
  );

  realRunnerIt(
    "gives each call a fresh context on a reused tenant isolate (no state leak)",
    async () => {
      const source =
        "export default { name: 'counter', execute() { globalThis.__n = (globalThis.__n || 0) + 1; return { n: globalThis.__n }; } };";
      const { byCall } = await runPoolRunner([
        { callId: "1", tenantId: "acct_a", toolName: "counter", source },
        { callId: "2", tenantId: "acct_a", toolName: "counter", source },
      ]);

      // Same tenant reuses the isolate, but the fresh context resets globals, so
      // the second call must NOT observe the first call's write.
      expect(byCall.get("1")!.find((f) => f.t === "final")).toEqual({
        t: "final",
        callId: "1",
        result: { n: 1 },
      });
      expect(byCall.get("2")!.find((f) => f.t === "final")).toEqual({
        t: "final",
        callId: "2",
        result: { n: 1 },
      });
    },
  );

  realRunnerIt("does not leak globals across tenants", async () => {
    const writer =
      "export default { name: 'w', execute() { globalThis.__secret = 'A'; return { wrote: true }; } };";
    const reader =
      "export default { name: 'r', execute() { return { secret: globalThis.__secret ?? null }; } };";
    const { byCall } = await runPoolRunner([
      { callId: "1", tenantId: "acct_a", toolName: "w", source: writer },
      { callId: "2", tenantId: "acct_b", toolName: "r", source: reader },
    ]);

    expect(byCall.get("2")!.find((f) => f.t === "final")).toEqual({
      t: "final",
      callId: "2",
      result: { secret: null },
    });
  });

  realRunnerIt(
    "surfaces thrown errors and poisoned-isolate recovery on the next call",
    async () => {
      const { byCall } = await runPoolRunner([
        {
          callId: "1",
          tenantId: "acct_a",
          toolName: "boom",
          source:
            "export default { name: 'boom', execute() { throw new Error('boom'); } };",
        },
        {
          callId: "2",
          tenantId: "acct_a",
          toolName: "ok",
          source:
            "export default { name: 'ok', execute() { return { ok: true }; } };",
        },
      ]);

      expect(byCall.get("1")!.find((f) => f.t === "error")).toEqual({
        t: "error",
        callId: "1",
        error: "boom",
      });
      // The tripped isolate is disposed + evicted; the next same-tenant call still works.
      expect(byCall.get("2")!.find((f) => f.t === "final")).toEqual({
        t: "final",
        callId: "2",
        result: { ok: true },
      });
    },
  );
});

// Runs against a stub runner (no isolated-vm), so it exercises the core-side
// forwarding of the AI SDK abortSignal into the runner process on every CI run.
describe("streamIsolatePayload cross-process abort", () => {
  const created: string[] = [];
  const savedRunnerPath = process.env.ISOLATE_RUNNER_PATH;
  const savedPool = process.env.ISOLATE_POOL;

  afterEach(async () => {
    if (savedRunnerPath === undefined) delete process.env.ISOLATE_RUNNER_PATH;
    else process.env.ISOLATE_RUNNER_PATH = savedRunnerPath;
    if (savedPool === undefined) delete process.env.ISOLATE_POOL;
    else process.env.ISOLATE_POOL = savedPool;
    for (const dir of created.splice(0))
      await rm(dir, { recursive: true, force: true });
  });

  it("forwards the AI SDK abortSignal to the runner as SIGUSR2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "broods-runner-stub-"));
    created.push(dir);
    const stubPath = join(dir, "stub-runner.mjs");
    await writeFile(
      stubPath,
      [
        "process.stdin.resume();",
        "process.stdin.on('data', () => {});",
        "process.on('SIGUSR2', () => {",
        "  process.stdout.write(JSON.stringify({ t: 'final', result: { aborted: true } }) + '\\n');",
        "  process.exit(0);",
        "});",
        "setTimeout(() => process.exit(3), 5000);",
      ].join("\n"),
      "utf8",
    );
    delete process.env.ISOLATE_POOL; // exercise the one-shot path
    process.env.ISOLATE_RUNNER_PATH = stubPath;

    const { streamIsolatePayload } =
      await import("../src/harness/tools/isolate-executor.ts");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const outputs: unknown[] = [];
    for await (const output of streamIsolatePayload(
      "acct_test",
      {
        bundleSourceB64: Buffer.from("export default {};").toString("base64"),
        expectedSha256: sha256("export default {};"),
        toolName: "stub",
        input: {},
        config: {},
      },
      { abortSignal: controller.signal },
    )) {
      outputs.push(output);
    }

    expect(outputs).toEqual([{ aborted: true }]);
  });
});

async function runPoolRunner(
  requests: Array<{
    callId: string;
    tenantId: string;
    toolName: string;
    source: string;
    input?: unknown;
  }>,
  env?: Record<string, string>,
): Promise<{
  byCall: Map<string, Array<{ t: string; [key: string]: unknown }>>;
  ready: unknown;
  stderr: string;
}> {
  const child = spawn("node", [runnerPath!, "--pool"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const frames: Array<{ t: string; [key: string]: unknown }> = [];
  let wake: (() => void) | null = null;
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        continue; // ignore any non-protocol stdout noise instead of crashing the run
      }
      wake?.();
      wake = null;
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const next = async (): Promise<{ t: string; [key: string]: unknown }> => {
    while (!frames.length)
      await new Promise<void>((resolve) => (wake = resolve));
    return frames.shift()!;
  };

  try {
    const ready = await next();
    const byCall = new Map<
      string,
      Array<{ t: string; [key: string]: unknown }>
    >();
    for (const request of requests) {
      child.stdin.write(
        JSON.stringify({
          t: "run",
          callId: request.callId,
          tenantId: request.tenantId,
          payload: {
            bundleSourceB64: Buffer.from(request.source).toString("base64"),
            expectedSha256: sha256(request.source),
            toolName: request.toolName,
            input: request.input ?? {},
            config: {},
          },
        }) + "\n",
      );
      const collected: Array<{ t: string; [key: string]: unknown }> = [];
      while (true) {
        const frame = await next();
        collected.push(frame);
        if (frame.t === "final" || frame.t === "error" || frame.t === "end")
          break;
      }
      byCall.set(request.callId, collected);
    }
    return { byCall, ready, stderr };
  } finally {
    child.kill();
  }
}

async function runRealRunner(
  source: string,
  options: {
    toolName: string;
    input?: unknown;
    expectedSha256?: string;
    env?: Record<string, string>;
    config?: Record<string, unknown>;
    toolCallId?: string;
    abortAfterMs?: number;
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
  child.stdin.end(
    JSON.stringify({
      bundleSourceB64: Buffer.from(source).toString("base64"),
      expectedSha256,
      toolName: options.toolName,
      input: options.input ?? {},
      config: options.config ?? {},
      ...(options.toolCallId !== undefined
        ? { toolCallId: options.toolCallId }
        : {}),
    }) + "\n",
  );
  if (options.abortAfterMs !== undefined) {
    setTimeout(() => {
      try {
        child.kill("SIGUSR2");
      } catch {}
    }, options.abortAfterMs);
  }
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });

  return {
    frames: stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    exitCode,
    stderr,
  };
}

function accountToolRecord(
  runtime: AccountToolRecord["runtime"],
): AccountToolRecord {
  return {
    accountId: "acct_test",
    toolId: "qs78zwc4z4q5ysxm74fgrhd13s88xxt",
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
