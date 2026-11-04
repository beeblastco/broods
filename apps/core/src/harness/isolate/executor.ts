// Bun cannot load isolated-vm, so account code (hooks) runs in a Node runner speaking ../frames.ts.
// Default: a capped pool of warm tenant-keyed workers, reaped idle; ISOLATE_POOL=0 is one-shot.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { optionalEnv, positiveIntegerEnv } from "../../shared/env.ts";
import { logDebug, logError, logInfo, logWarn } from "../../shared/log.ts";
import { FrameQueue } from "../frames.ts";

const DEFAULT_TIMEOUT_SECONDS = 30;
// Ready lands ~80 ms after spawn; a hung start must not burn the run timeout on each retry.
const WORKER_READY_TIMEOUT_MS = 5_000;
const RUNNER_ENV_KEYS = new Set([
  "PATH",
  "ISOLATE_MEMORY_LIMIT_MB",
  "ISOLATE_RUNNER_TIMEOUT_SECONDS",
  "ISOLATE_TENANT_CACHE_PER_WORKER",
]);
// The runner hosts tenant code: it gets only what it reads, never core's secrets.
const RUNNER_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]): boolean =>
    RUNNER_ENV_KEYS.has(key),
  ),
);
// Added to the request size: a hook may hand back its whole input plus a result.
const RUNNER_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export async function* streamIsolatePayload(
  accountId: string | undefined,
  runPayload: Record<string, unknown>,
  options: { abortSignal?: AbortSignal } = {},
): AsyncGenerator<unknown, void, void> {
  if (isolatePoolEnabled()) {
    yield* streamViaPool(accountId, runPayload, options.abortSignal);

    return;
  }
  yield* streamViaOneShot(accountId, runPayload, options.abortSignal);
}

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

// SIGUSR2 aborts the run inside the isolate without killing the (possibly shared) worker.
function forwardAbortSignal(
  child: ChildProcessWithoutNullStreams,
  abortSignal: AbortSignal | undefined,
): (() => void) | undefined {
  if (!abortSignal) return undefined;
  const onAbort = (): void => {
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

let activeIsolateRuns = 0;
const isolateWaiters: Array<() => void> = [];

async function* streamViaOneShot(
  accountId: string | undefined,
  runPayload: Record<string, unknown>,
  abortSignal?: AbortSignal,
): AsyncGenerator<unknown, void, void> {
  const release = await acquireIsolateSlot();
  let child: ChildProcessWithoutNullStreams | undefined;
  let detachAbort: (() => void) | undefined;
  try {
    child = spawn(isolateRunnerNode(), [isolateRunnerPath()], {
      stdio: ["pipe", "pipe", "pipe"],
      env: RUNNER_ENV,
    });
    detachAbort = forwardAbortSignal(child, abortSignal);

    const queue = new FrameQueue();
    const request = JSON.stringify(runPayload) + "\n";
    const outputLimit = RUNNER_OUTPUT_LIMIT_BYTES + Buffer.byteLength(request);
    let stderr = "";
    let stdoutBytes = 0;
    let sawFrame = false;
    const timeoutMs = runnerTimeoutMs();
    const timeout = setTimeout(() => {
      queue.push(
        JSON.stringify({
          t: "error",
          error: "isolate execution timed out",
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
      child!.once("exit", (code, signal) =>
        resolve({ code: code, signal: signal }),
      );
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > outputLimit) {
        queue.push(
          JSON.stringify({
            t: "error",
            error: "isolate output exceeded limit",
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

    child.stdin.end(request);

    for await (const frame of queue.frames()) {
      // Not a result: a runner that logged and then died still gets the no-result diagnostic.
      if (frame.t === "log") {
        emitIsolateLog(accountId, runPayload.toolName, frame);
        continue;
      }
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
      if (frame.t !== "error") continue;

      throw new Error(frame.error || "isolate execution failed");
    }

    const exit = await exited;
    if (!sawFrame) {
      const detail =
        stderr.trim() ||
        (exit.signal
          ? `signal ${exit.signal}`
          : `exit ${exit.code ?? "unknown"}`);
      throw new Error(`isolate runner did not return a result: ${detail}`);
    }
  } finally {
    detachAbort?.();
    child?.kill();
    release();
  }
}

// Call inside the run's frame loop: its observability context routes the line to NATS.
export function emitIsolateLog(
  accountId: string | undefined,
  toolName: unknown,
  frame: IsolateFrame,
): void {
  const record = isolateLogRecord(accountId, toolName, frame);
  const emit = {
    debug: logDebug,
    info: logInfo,
    warn: logWarn,
    error: logError,
  }[record.level];
  emit(record.message, record.data);
}

export function isolateLogRecord(
  accountId: string | undefined,
  toolName: unknown,
  frame: IsolateFrame,
): {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data: Record<string, unknown>;
} {
  const level =
    frame.level === "error" || frame.level === "warn" || frame.level === "debug"
      ? frame.level
      : "info";

  return {
    level: level,
    message: frame.message ?? "",
    data: {
      accountId: accountId,
      ...(typeof toolName === "string" ? { toolName: toolName } : {}),
      source: "user-code",
    },
  };
}

async function acquireIsolateSlot(): Promise<() => void> {
  const limit = positiveIntegerEnv("ISOLATE_RUNNER_CONCURRENCY", 8);
  if (activeIsolateRuns < limit) {
    activeIsolateRuns += 1;

    return releaseIsolateSlot;
  }
  // A release hands its slot straight to a waiter, so a fast-path acquire cannot overshoot.
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

type IsolateFrame = {
  t: string;
  callId?: string;
  output?: unknown;
  result?: unknown;
  error?: string;
  toolName?: string;
  cpuMs?: number;
  level?: string;
  message?: string;
};

class IsolateWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly tenants = new Set<string>();
  busy = false;
  alive = true;
  idleSince = Date.now();
  readonly #ready = Promise.withResolvers<void>();
  readonly ready = this.#ready.promise;

  #buffer = "";
  #stdoutBytes = 0;
  #stdoutLimit = RUNNER_OUTPUT_LIMIT_BYTES;
  #sink: {
    push: (frame: IsolateFrame) => void;
    fail: (error: Error) => void;
  } | null = null;
  readonly #startup = setTimeout(() => {
    this.#ready.reject(new Error("isolate worker did not become ready"));
    this.kill();
  }, workerReadyTimeoutMs());

  constructor() {
    // A start prewarm drops must not be an unhandled rejection; acquireWorker reads it.
    this.ready.catch(() => {});
    this.child = spawn(isolateRunnerNode(), [isolateRunnerPath(), "--pool"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: RUNNER_ENV,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", () => {});
    const die = (error: Error): void => {
      this.alive = false;
      clearTimeout(this.#startup);
      this.#ready.reject(error);
      this.#sink?.fail(error);
    };
    this.child.once("error", (error) =>
      die(error instanceof Error ? error : new Error(String(error))),
    );
    this.child.once("exit", (code, signal) =>
      die(new Error(`isolate worker exited (${signal ?? code})`)),
    );
    this.child.stdin.once("error", (error) =>
      die(error instanceof Error ? error : new Error(String(error))),
    );
  }

  #onData(chunk: string): void {
    this.#stdoutBytes += Buffer.byteLength(chunk);
    if (this.#stdoutBytes > this.#stdoutLimit) {
      this.kill();
      this.#sink?.fail(new Error("isolate output exceeded limit"));

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
        clearTimeout(this.#startup);
        this.#ready.resolve();
        continue;
      }
      this.#sink?.push(frame);
    }
  }

  async *runCall(
    request: Record<string, unknown>,
  ): AsyncGenerator<IsolateFrame, void, void> {
    const body = JSON.stringify(request) + "\n";
    this.#stdoutBytes = 0;
    this.#stdoutLimit = RUNNER_OUTPUT_LIMIT_BYTES + Buffer.byteLength(body);
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
      this.child.stdin.write(body);
      for (;;) {
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
const WORKER_START_ATTEMPTS = 3;
const WORKER_START_BACKOFF_MS = 100;
const poolWaiters: Array<() => void> = [];
let reaper: ReturnType<typeof setInterval> | undefined;

// A cap, not a resting size: each worker is ~54 MB resident. Past it, calls queue.
function poolSize(): number {
  return positiveIntegerEnv("ISOLATE_WORKER_POOL_SIZE", 4);
}

function workerIdleTtlMs(): number {
  return positiveIntegerEnv("ISOLATE_WORKER_IDLE_SECONDS", 120) * 1000;
}

function workerReadyTimeoutMs(): number {
  return Math.min(
    positiveIntegerEnv(
      "ISOLATE_WORKER_READY_TIMEOUT_MS",
      WORKER_READY_TIMEOUT_MS,
    ),
    runnerTimeoutMs(),
  );
}

export async function prewarmIsolatePool(): Promise<void> {
  if (!isolatePoolEnabled() || pool.length > 0) return;
  await spawnWorker().ready.catch(() => {});
}

export function shutdownIsolatePool(): void {
  if (reaper) {
    clearInterval(reaper);
    reaper = undefined;
  }
  for (const worker of pool.splice(0)) worker.kill();
}

async function acquireWorker(tenantId: string): Promise<IsolateWorker> {
  for (let startFailures = 0; ;) {
    dropDeadWorkers();
    const worker =
      pool.find(
        (candidate) =>
          !candidate.busy && candidate.alive && candidate.tenants.has(tenantId),
      ) ??
      pool.find((candidate) => !candidate.busy && candidate.alive) ??
      (pool.length < poolSize() ? spawnWorker() : undefined);
    if (worker) {
      worker.busy = true;
      const startFailure = await worker.ready.then(
        () => undefined,
        (error: Error) => error,
      );
      if (worker.alive) return worker;
      worker.busy = false;
      // Died after ready: replace it now. Never started: likely broken, so back off, then fail.
      if (startFailure === undefined) continue;
      startFailures += 1;
      if (startFailures >= WORKER_START_ATTEMPTS) {
        // A queued call waits on a release this failed slot never sends.
        poolWaiters.shift()?.();
        throw new Error(
          `isolate worker failed to start: ${startFailure.message}`,
        );
      }
      await Bun.sleep(WORKER_START_BACKOFF_MS * 2 ** (startFailures - 1));
      continue;
    }
    await new Promise<void>((resolve) => poolWaiters.push(resolve));
  }
}

function dropDeadWorkers(): void {
  for (let index = pool.length - 1; index >= 0; index -= 1) {
    if (!pool[index]!.alive) pool.splice(index, 1);
  }
}

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
  const request = {
    t: "run",
    callId: callId,
    tenantId: tenantId,
    payload: runPayload,
  };
  const detachAbort = forwardAbortSignal(worker.child, abortSignal);

  let terminalReceived = false;
  const guard = setTimeout(() => {
    if (!terminalReceived) worker.kill();
  }, runnerTimeoutMs() + 2_000);
  try {
    for await (const frame of worker.runCall(request)) {
      // A frame written around the previous call's terminal frame can land here; emitting it
      // would publish one tenant's log line to another tenant's NATS subject.
      if (frame.callId !== undefined && frame.callId !== callId) continue;
      if (frame.t === "log") {
        emitIsolateLog(tenantId, runPayload.toolName, frame);
        continue;
      }
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
        throw new Error(frame.error || "isolate execution failed");
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
