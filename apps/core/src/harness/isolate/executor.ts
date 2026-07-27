/**
 * Node-hosted V8 isolate execution for account-uploaded user code (custom tools
 * and hooks). Bun cannot load isolated-vm, so core spawns a Node runner
 * (./runner/runner.mjs) and speaks the NDJSON frame protocol from ../bundles/payload.ts.
 *
 * Two paths share this file. The default is a pool of long-lived hardened
 * workers keeping a tenant-keyed warm isolate cache (Convex-Funrun style) —
 * reuse the isolate within a tenant, fresh context per call, so cold starts and
 * per-call process spawns disappear. It grows on demand and reaps idle workers,
 * because core's pod budgets memory for one process, not a standing fleet.
 * ISOLATE_POOL=0 falls back to the one-shot spawner, a fresh runner per call.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { optionalEnv, positiveIntegerEnv } from "../../shared/env.ts";
import { logInfo } from "../../shared/log.ts";
import {
  FrameQueue,
  abortSignalFromOptions,
  createRunnerPayload,
  experimentalContextFromOptions,
  messagesFromOptions,
  toolBundlesBucket,
  toolCallIdFromOptions,
  type ExecuteAccountToolOptions,
} from "../bundles/payload.ts";

const DEFAULT_TIMEOUT_SECONDS = 30;
const RUNNER_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export async function* streamAccountToolInIsolate(
  options: ExecuteAccountToolOptions,
): AsyncGenerator<unknown, void, void> {
  const runPayload = await buildRunPayload(options);
  yield* streamIsolatePayload(options.accountId, runPayload, {
    abortSignal: abortSignalFromOptions(options.options),
  });
}

/**
 * Run a pre-built runner payload (tool or hook) in the isolate, tenant-scoped by
 * accountId, and stream its frames. Tool bundles run execute(ctx, input); hook
 * bundles (payload.hookEvent set) run the matching event handler. Used by the
 * custom-tool path above and by harness/hook-runner.ts.
 */
export async function* streamIsolatePayload(
  accountId: string | undefined,
  runPayload: Record<string, unknown>,
  options: { abortSignal?: AbortSignal } = {},
): AsyncGenerator<unknown, void, void> {
  if (isolatePoolEnabled()) {
    yield* streamViaPool(accountId, runPayload, options.abortSignal);
    return;
  }
  yield* streamViaOneShot(runPayload, options.abortSignal);
}

// Pooled by default. The one-shot path pays a Node spawn plus a cold isolate on
// every call, which is most of what an isolate-tier tool costs; ISOLATE_POOL=0
// is the way back to it.
function isolatePoolEnabled(): boolean {
  return optionalEnv("ISOLATE_POOL") !== "0";
}

function runnerTimeoutMs(): number {
  return (
    positiveIntegerEnv(
      "ISOLATE_RUNNER_TIMEOUT_SECONDS",
      DEFAULT_TIMEOUT_SECONDS,
    ) * 1000
  );
}

async function buildRunPayload({
  tool,
  input,
  config,
  options,
}: ExecuteAccountToolOptions): Promise<Record<string, unknown>> {
  const payload = await createRunnerPayload({
    bucket: toolBundlesBucket(),
    tool,
    input,
    config,
    toolCallId: toolCallIdFromOptions(options),
    messages: messagesFromOptions(options),
    experimentalContext: experimentalContextFromOptions(options),
    bundleTransport: "inline",
  });
  return { ...payload };
}

// Bridges the AI SDK abortSignal into the runner process: SIGUSR2 trips the
// run's in-isolate AbortController without killing the (possibly shared) worker.
// Returns a detach function, or undefined when there is nothing to forward.
function forwardAbortSignal(
  child: ChildProcessWithoutNullStreams,
  abortSignal: AbortSignal | undefined,
): (() => void) | undefined {
  if (!abortSignal) return undefined;
  const onAbort = () => {
    try {
      child.kill("SIGUSR2");
    } catch {}
  };
  if (abortSignal.aborted) {
    onAbort();
    return undefined;
  }
  abortSignal.addEventListener("abort", onAbort, { once: true });

  return () => abortSignal.removeEventListener("abort", onAbort);
}

// --- One-shot fallback path (ISOLATE_POOL=0) ----------------------------------

let activeIsolateRuns = 0;
const isolateWaiters: Array<() => void> = [];

async function* streamViaOneShot(
  runPayload: Record<string, unknown>,
  abortSignal?: AbortSignal,
): AsyncGenerator<unknown, void, void> {
  const release = await acquireIsolateSlot();
  let child: ChildProcessWithoutNullStreams | undefined;
  let detachAbort: (() => void) | undefined;
  try {
    child = spawn(isolateRunnerNode(), [isolateRunnerPath()], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    detachAbort = forwardAbortSignal(child, abortSignal);

    const queue = new FrameQueue();
    let stderr = "";
    let stdoutBytes = 0;
    let sawFrame = false;
    const timeoutMs = runnerTimeoutMs();
    const timeout = setTimeout(() => {
      queue.push(
        JSON.stringify({
          t: "error",
          error: "custom tool isolate execution timed out",
        }) + "\n",
      );
      queue.close();
      child?.kill("SIGKILL");
    }, timeoutMs);

    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code, signal) => resolve({ code, signal }));
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > RUNNER_OUTPUT_LIMIT_BYTES) {
        queue.push(
          JSON.stringify({
            t: "error",
            error: "custom tool isolate output exceeded limit",
          }) + "\n",
        );
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
    void exited
      .then(() => {
        clearTimeout(timeout);
        queue.close();
      })
      .catch((error) => {
        clearTimeout(timeout);
        queue.push(
          JSON.stringify({
            t: "error",
            error: error instanceof Error ? error.message : String(error),
          }) + "\n",
        );
        queue.close();
      });

    child.stdin.end(JSON.stringify(runPayload) + "\n");

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
      const detail =
        stderr.trim() ||
        (exit.signal
          ? `signal ${exit.signal}`
          : `exit ${exit.code ?? "unknown"}`);
      throw new Error(
        `custom tool isolate runner did not return a result: ${detail}`,
      );
    }
  } finally {
    detachAbort?.();
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
  // The releasing run hands its slot to the woken waiter directly (no decrement),
  // so a concurrent fast-path acquire cannot sneak in and exceed the cap.
  await new Promise<void>((resolve) => isolateWaiters.push(resolve));
  return releaseIsolateSlot;
}

function releaseIsolateSlot(): void {
  const next = isolateWaiters.shift();
  if (next) {
    next();
    return;
  }
  activeIsolateRuns = Math.max(0, activeIsolateRuns - 1);
}

// --- Pooled path (default): long-lived tenant-scoped warm workers -------------

type IsolateFrame = {
  t: string;
  callId?: string;
  output?: unknown;
  result?: unknown;
  error?: string;
  toolName?: string;
  cpuMs?: number;
};

/**
 * One long-lived runner process. Serves a single call at a time; between calls
 * it keeps its tenant-keyed isolate cache warm. Frames from stdout route to the
 * active call's sink; a `ready` frame resolves startup.
 */
class IsolateWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly tenants = new Set<string>();
  busy = false;
  alive = true;
  idleSince = Date.now();
  ready: Promise<void>;

  #buffer = "";
  #stdoutBytes = 0;
  #sink: {
    push: (frame: IsolateFrame) => void;
    fail: (error: Error) => void;
  } | null = null;
  #resolveReady!: () => void;

  constructor() {
    this.ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
    this.child = spawn(isolateRunnerNode(), [isolateRunnerPath(), "--pool"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", () => {});
    const die = (error: Error) => {
      this.alive = false;
      this.#resolveReady();
      this.#sink?.fail(error);
    };
    this.child.once("error", (error) =>
      die(error instanceof Error ? error : new Error(String(error))),
    );
    this.child.once("exit", () =>
      die(new Error("custom tool isolate worker exited")),
    );
    this.child.stdin.once("error", (error) =>
      die(error instanceof Error ? error : new Error(String(error))),
    );
  }

  #onData(chunk: string): void {
    this.#stdoutBytes += Buffer.byteLength(chunk);
    if (this.#stdoutBytes > RUNNER_OUTPUT_LIMIT_BYTES) {
      this.kill();
      this.#sink?.fail(new Error("custom tool isolate output exceeded limit"));
      return;
    }
    this.#buffer += chunk;
    let index: number;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line.trim()) continue;
      let frame: IsolateFrame;
      try {
        frame = JSON.parse(line) as IsolateFrame;
      } catch {
        continue;
      }
      if (frame.t === "ready") {
        this.#resolveReady();
        continue;
      }
      this.#sink?.push(frame);
    }
  }

  async *runCall(
    request: Record<string, unknown>,
  ): AsyncGenerator<IsolateFrame, void, void> {
    this.#stdoutBytes = 0;
    const frames: IsolateFrame[] = [];
    let done = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    this.#sink = {
      push: (frame) => {
        frames.push(frame);
        if (frame.t === "final" || frame.t === "error" || frame.t === "end")
          done = true;
        wake?.();
        wake = null;
      },
      fail: (error) => {
        failure = error;
        done = true;
        wake?.();
        wake = null;
      },
    };
    try {
      this.child.stdin.write(JSON.stringify(request) + "\n");
      while (true) {
        if (frames.length) {
          yield frames.shift()!;
          continue;
        }
        if (failure) throw failure;
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      this.#sink = null;
    }
  }

  kill(): void {
    this.alive = false;
    try {
      this.child.kill("SIGKILL");
    } catch {}
  }
}

const pool: IsolateWorker[] = [];
const poolWaiters: Array<() => void> = [];
let reaper: ReturnType<typeof setInterval> | undefined;

// The cap, not the resting size, and its own knob: a worker is ~54 MB resident
// where a one-shot process is transient. Past the cap, calls queue.
function poolSize(): number {
  return positiveIntegerEnv("ISOLATE_WORKER_POOL_SIZE", 4);
}

function workerIdleTtlMs(): number {
  return positiveIntegerEnv("ISOLATE_WORKER_IDLE_SECONDS", 120) * 1000;
}

/** Pre-spawn one worker so the first real call skips Node startup. */
export async function prewarmIsolatePool(): Promise<void> {
  if (!isolatePoolEnabled() || pool.length > 0) return;
  await spawnWorker().ready.catch(() => {});
}

/** Kills every worker. Workers outlive a request, so shutdown has to reap them. */
export function shutdownIsolatePool(): void {
  if (reaper) {
    clearInterval(reaper);
    reaper = undefined;
  }
  for (const worker of pool.splice(0)) worker.kill();
}

async function acquireWorker(tenantId: string): Promise<IsolateWorker> {
  while (true) {
    dropDeadWorkers();
    // Tenant affinity first: that worker already holds a warm isolate for this
    // account, which is the whole point of keeping the process around.
    const worker =
      pool.find(
        (candidate) =>
          !candidate.busy && candidate.alive && candidate.tenants.has(tenantId),
      ) ??
      pool.find((candidate) => !candidate.busy && candidate.alive) ??
      (pool.length < poolSize() ? spawnWorker() : undefined);
    if (worker) {
      worker.busy = true;
      await worker.ready.catch(() => {});
      if (!worker.alive) {
        worker.busy = false;
        continue;
      }
      return worker;
    }
    await new Promise<void>((resolve) => poolWaiters.push(resolve));
  }
}

function dropDeadWorkers(): void {
  for (let index = pool.length - 1; index >= 0; index -= 1) {
    if (!pool[index]!.alive) pool.splice(index, 1);
  }
}

// A burst grows the pool to the cap; without this it would stay there for the
// life of the process. One worker always survives so the next call stays warm.
function reapIdleWorkers(): void {
  const cutoff = Date.now() - workerIdleTtlMs();
  for (let index = pool.length - 1; index >= 0 && pool.length > 1; index -= 1) {
    const worker = pool[index]!;
    if (worker.busy || worker.idleSince > cutoff) continue;
    worker.kill();
    pool.splice(index, 1);
  }
}

function releaseWorker(worker: IsolateWorker, tenantId: string): void {
  worker.busy = false;
  worker.idleSince = Date.now();
  if (worker.alive) worker.tenants.add(tenantId);
  const next = poolWaiters.shift();
  if (next) next();
}

function spawnWorker(): IsolateWorker {
  const worker = new IsolateWorker();
  pool.push(worker);
  if (!reaper) {
    reaper = setInterval(reapIdleWorkers, 30_000);
    reaper.unref?.();
  }

  return worker;
}

let callCounter = 0;

async function* streamViaPool(
  accountId: string | undefined,
  runPayload: Record<string, unknown>,
  abortSignal?: AbortSignal,
): AsyncGenerator<unknown, void, void> {
  const tenantId = accountId ?? "anonymous";
  const worker = await acquireWorker(tenantId);
  const callId = String((callCounter += 1));
  const request = { t: "run", callId, tenantId, payload: runPayload };
  const detachAbort = forwardAbortSignal(worker.child, abortSignal);

  // Guard against a wedged worker: if no terminal frame lands within the run
  // deadline plus grace, kill it (its exit fails the call) and let the pool
  // respawn a replacement.
  let terminalReceived = false;
  const guard = setTimeout(() => {
    if (!terminalReceived) worker.kill();
  }, runnerTimeoutMs() + 2_000);
  try {
    for await (const frame of worker.runCall(request)) {
      if (frame.t === "meter") {
        logInfo("isolate.usage", {
          accountId: tenantId,
          toolName: frame.toolName,
          cpuMs: frame.cpuMs,
        });
        continue;
      }
      if (frame.t === "chunk") {
        yield frame.output;
        continue;
      }
      if (frame.t === "final") {
        terminalReceived = true;
        yield frame.result;
        return;
      }
      if (frame.t === "end") {
        terminalReceived = true;
        return;
      }
      if (frame.t === "error") {
        terminalReceived = true;
        throw new Error(frame.error || "custom tool isolate execution failed");
      }
    }
  } finally {
    detachAbort?.();
    clearTimeout(guard);
    releaseWorker(worker, tenantId);
  }
}

function isolateRunnerNode(): string {
  return optionalEnv("ISOLATE_RUNNER_NODE") ?? "node";
}

function isolateRunnerPath(): string {
  return (
    optionalEnv("ISOLATE_RUNNER_PATH") ??
    fileURLToPath(new URL("./runner/runner.mjs", import.meta.url))
  );
}
