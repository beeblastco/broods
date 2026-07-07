/**
 * Node-hosted V8 isolate execution for pure account-uploaded tool bundles.
 * Bun cannot load isolated-vm, so core spawns a Node runner and speaks the same
 * NDJSON frame protocol as the resident sandbox worker.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { optionalEnv, positiveIntegerEnv, requireEnv } from "../../shared/env.ts";
import { FrameQueue, createRunnerPayload, type ExecuteAccountToolOptions } from "./custom-tool-executor.ts";

const DEFAULT_TIMEOUT_SECONDS = 30;
const RUNNER_OUTPUT_LIMIT_BYTES = 1024 * 1024;

let activeIsolateRuns = 0;
const isolateWaiters: Array<() => void> = [];

export async function* streamAccountToolInIsolate({
  tool,
  input,
  config,
}: ExecuteAccountToolOptions): AsyncGenerator<unknown, void, void> {
  const release = await acquireIsolateSlot();
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const bucket = requireEnv("TOOL_BUNDLES_BUCKET_NAME");
    const payload = await createRunnerPayload({
      bucket,
      tool,
      input,
      config,
      asyncTool: null,
      forceInline: true,
    });
    child = spawn(isolateRunnerNode(), [isolateRunnerPath()], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const queue = new FrameQueue();
    let stderr = "";
    let stdoutBytes = 0;
    let sawFrame = false;
    const timeoutMs = positiveIntegerEnv("ISOLATE_RUNNER_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS) * 1000;
    const timeout = setTimeout(() => {
      queue.push(JSON.stringify({ t: "error", error: "custom tool isolate execution timed out" }) + "\n");
      queue.close();
      child?.kill("SIGKILL");
    }, timeoutMs);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code, signal) => resolve({ code, signal }));
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > RUNNER_OUTPUT_LIMIT_BYTES) {
        queue.push(JSON.stringify({ t: "error", error: "custom tool isolate output exceeded limit" }) + "\n");
        queue.close();
        child?.kill("SIGKILL");
        return;
      }
      queue.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 16 * 1024) stderr = stderr.slice(-16 * 1024);
    });
    void exited.then(() => {
      clearTimeout(timeout);
      queue.close();
    }).catch((error) => {
      clearTimeout(timeout);
      queue.push(JSON.stringify({
        t: "error",
        error: error instanceof Error ? error.message : String(error),
      }) + "\n");
      queue.close();
    });

    child.stdin.end(JSON.stringify({
      bundleSourceB64: payload.bundleSourceB64,
      expectedSha256: payload.expectedSha256,
      toolName: payload.toolName,
      input: payload.input,
      config: payload.config,
    }) + "\n");

    for await (const frame of queue.frames()) {
      sawFrame = true;
      if (frame.t === "chunk") {
        yield frame.output;
        continue;
      }
      if (frame.t === "final") {
        yield frame.result;
        return;
      }
      if (frame.t === "end") {
        return;
      }
      throw new Error(frame.error || "custom tool isolate execution failed");
    }

    const exit = await exited;
    if (!sawFrame) {
      const detail = stderr.trim() || (exit.signal ? `signal ${exit.signal}` : `exit ${exit.code ?? "unknown"}`);
      throw new Error(`custom tool isolate runner did not return a result: ${detail}`);
    }
  } finally {
    child?.kill();
    release();
  }
}

async function acquireIsolateSlot(): Promise<() => void> {
  const limit = positiveIntegerEnv("ISOLATE_RUNNER_CONCURRENCY", 8);
  if (activeIsolateRuns < limit) {
    activeIsolateRuns += 1;
    return releaseIsolateSlot;
  }
  await new Promise<void>((resolve) => isolateWaiters.push(resolve));
  activeIsolateRuns += 1;
  return releaseIsolateSlot;
}

function releaseIsolateSlot(): void {
  activeIsolateRuns = Math.max(0, activeIsolateRuns - 1);
  isolateWaiters.shift()?.();
}

function isolateRunnerNode(): string {
  return optionalEnv("ISOLATE_RUNNER_NODE") ?? "node";
}

function isolateRunnerPath(): string {
  return optionalEnv("ISOLATE_RUNNER_PATH") ??
    fileURLToPath(new URL("./isolate-runner/runner.mjs", import.meta.url));
}
