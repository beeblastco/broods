/**
 * Core-owned Workdir port for the runtime-unwired AI SDK Harness adapter.
 * Provider selection and reservations stay in the existing sandbox executor;
 * live HarnessAgent selection belongs in the later run-loop integration.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path/posix";
import type {
  BroodsSandboxCommandOptions,
  BroodsSandboxDriver,
  BroodsSandboxDriverCreateOptions,
  BroodsSandboxDriverCreateResult,
  BroodsSandboxDriverResumeOptions,
  BroodsSandboxDriverSession,
  BroodsSandboxFileOptions,
  BroodsSandboxWriteFileOptions,
} from "@broods/ai-sdk-sandbox";
import type { Sandbox } from "@mv37/workdir";
import { createSandboxExecutor } from "./index.ts";
import type { SandboxExecutorConfig, SandboxReservationRef } from "./types.ts";
import { shellQuote, stringRecord } from "./utils.ts";
import type { WorkdirHarnessReservation } from "./workdir-executor.ts";

const DEFAULT_WORKING_DIRECTORY = "/workspace";
const PROCESS_POLL_INTERVAL_MS = 25;
const PROCESS_CHUNK_BYTES = 64 * 1024;

export interface WorkdirHarnessDriverOptions {
  /** Existing core reservation identity, already scoped to its account/agent. */
  reservationKey: string;
  /** Harness bootstrap identity bound to this reservation, when bootstrap is used. */
  bootstrapIdentity?: string;
  config: SandboxExecutorConfig & { provider: "sandbox"; persistent: true };
  defaultWorkingDirectory?: string;
  ports?: ReadonlyArray<number>;
}

interface WorkdirHarnessExecutor {
  acquireHarnessReservation(request: {
    reservationKey: string;
    abortSignal?: AbortSignal;
  }): Promise<WorkdirHarnessReservation>;
  resumeHarnessReservation(request: {
    reservationKey: string;
    abortSignal?: AbortSignal;
  }): Promise<Sandbox>;
  suspend?(request: SandboxReservationRef): Promise<void>;
  release?(request: SandboxReservationRef): Promise<void>;
}

export function createWorkdirHarnessDriver(
  options: WorkdirHarnessDriverOptions,
): BroodsSandboxDriver {
  const executor = createSandboxExecutor(options.config);
  if (!isWorkdirHarnessExecutor(executor)) {
    throw new Error(
      "Workdir Harness driver requires the core sandbox executor",
    );
  }
  return new WorkdirHarnessDriver(options, executor);
}

export class WorkdirHarnessDriver implements BroodsSandboxDriver {
  readonly #options: WorkdirHarnessDriverOptions;
  readonly #executor: WorkdirHarnessExecutor;

  constructor(
    options: WorkdirHarnessDriverOptions,
    executor: WorkdirHarnessExecutor,
  ) {
    if (!options.reservationKey.trim()) {
      throw new Error("Workdir Harness driver requires a reservationKey");
    }
    if (
      options.config.provider !== "sandbox" ||
      options.config.persistent !== true
    ) {
      throw new Error(
        "Workdir Harness driver requires a persistent sandbox provider config",
      );
    }
    this.#options = options;
    this.#executor = executor;
  }

  async createSession(
    options: BroodsSandboxDriverCreateOptions,
  ): Promise<BroodsSandboxDriverCreateResult> {
    this.#assertBootstrapIdentity(options.identity);
    options.abortSignal?.throwIfAborted();

    let reservation: WorkdirHarnessReservation | undefined;
    try {
      reservation = await this.#executor.acquireHarnessReservation({
        reservationKey: this.#options.reservationKey,
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
      options.abortSignal?.throwIfAborted();
    } catch (error) {
      if (reservation?.isFirstCreate) {
        await this.#executor
          .release?.({ reservationKey: this.#options.reservationKey })
          .catch(() => {});
      }
      throw error;
    }

    return {
      session: this.#session(reservation.sandbox),
      isFirstCreate: reservation.isFirstCreate,
    };
  }

  async resumeSession(
    options: BroodsSandboxDriverResumeOptions,
  ): Promise<BroodsSandboxDriverSession> {
    options.abortSignal?.throwIfAborted();
    const sandbox = await this.#executor.resumeHarnessReservation({
      reservationKey: this.#options.reservationKey,
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
    options.abortSignal?.throwIfAborted();
    return this.#session(sandbox);
  }

  #assertBootstrapIdentity(identity: string | undefined): void {
    if (identity === undefined) return;
    if (this.#options.bootstrapIdentity === undefined) {
      throw new Error(
        "Workdir Harness bootstrap requires a reservation-scoped bootstrapIdentity",
      );
    }
    if (identity !== this.#options.bootstrapIdentity) {
      throw new Error(
        "Workdir Harness bootstrap identity does not match this reservation",
      );
    }
  }

  #session(sandbox: Sandbox): BroodsSandboxDriverSession {
    return new WorkdirHarnessSession({
      sandbox,
      executor: this.#executor,
      reservationKey: this.#options.reservationKey,
      description: `Broods Workdir sandbox ${sandbox.id}`,
      defaultWorkingDirectory:
        this.#options.defaultWorkingDirectory ?? DEFAULT_WORKING_DIRECTORY,
      env: stringRecord(this.#options.config.envVars),
      ports: this.#options.ports ?? [],
    });
  }
}

interface WorkdirHarnessSessionOptions {
  sandbox: Sandbox;
  executor: WorkdirHarnessExecutor;
  reservationKey: string;
  description: string;
  defaultWorkingDirectory: string;
  env: Record<string, string>;
  ports: ReadonlyArray<number>;
}

class WorkdirHarnessSession implements BroodsSandboxDriverSession {
  readonly #sandbox: Sandbox;
  readonly #executor: WorkdirHarnessExecutor;
  readonly #reservationKey: string;
  readonly #defaultWorkingDirectory: string;
  readonly #env: Record<string, string>;

  readonly id: string;
  readonly description: string;
  readonly ports: ReadonlyArray<number>;

  constructor(options: WorkdirHarnessSessionOptions) {
    this.#sandbox = options.sandbox;
    this.#executor = options.executor;
    this.#reservationKey = options.reservationKey;
    this.#defaultWorkingDirectory = options.defaultWorkingDirectory;
    this.#env = options.env;
    this.id = options.sandbox.id;
    this.description = options.description;
    this.ports = [...options.ports];
  }

  get defaultWorkingDirectory(): string {
    return this.#defaultWorkingDirectory;
  }

  async runCommand(options: BroodsSandboxCommandOptions): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    options.abortSignal?.throwIfAborted();
    const process = await this.spawnCommand(options);
    const completion = Promise.all([
      readStreamText(process.stdout),
      readStreamText(process.stderr),
      process.wait(),
    ]).then(([stdout, stderr, result]) => ({
      exitCode: result.exitCode,
      stdout,
      stderr,
    }));
    return await completion;
  }

  async spawnCommand(
    options: BroodsSandboxCommandOptions,
  ): Promise<WorkdirHarnessProcess> {
    options.abortSignal?.throwIfAborted();
    return await WorkdirHarnessProcess.start({
      sandbox: this.#sandbox,
      command: options.command,
      workingDirectory:
        options.workingDirectory ?? this.#defaultWorkingDirectory,
      env: { ...this.#env, ...(options.env ?? {}) },
      abortSignal: options.abortSignal,
    });
  }

  async readFile(
    options: BroodsSandboxFileOptions,
  ): Promise<Uint8Array | null> {
    options.abortSignal?.throwIfAborted();
    const path = shellQuote(options.path);
    const result = await this.#sandbox.exec(
      `if [ -f ${path} ]; then base64 < ${path} | tr -d '\\n'; elif [ ! -e ${path} ]; then exit 44; else exit 45; fi`,
    );
    options.abortSignal?.throwIfAborted();
    if (result.exit_code === 44) return null;
    if (result.exit_code !== 0) throw workdirError("read file", result);
    return new Uint8Array(Buffer.from(result.stdout.trim(), "base64"));
  }

  async writeFile(options: BroodsSandboxWriteFileOptions): Promise<void> {
    options.abortSignal?.throwIfAborted();
    const temporaryPath = `/tmp/broods-harness-upload-${randomUUID()}`;
    try {
      await this.#sandbox.writeFile(
        temporaryPath,
        Buffer.from(options.content).toString("base64"),
      );
      options.abortSignal?.throwIfAborted();
      const result = await this.#sandbox.exec(
        [
          `mkdir -p ${shellQuote(dirname(options.path))}`,
          `base64 -d ${shellQuote(temporaryPath)} > ${shellQuote(options.path)}`,
        ].join(" && "),
      );
      options.abortSignal?.throwIfAborted();
      if (result.exit_code !== 0) throw workdirError("write file", result);
    } finally {
      await this.#sandbox
        .exec(`rm -f ${shellQuote(temporaryPath)}`)
        .catch(() => {});
    }
  }

  async getPortUrl(options: {
    port: number;
    protocol?: "http" | "https" | "ws";
  }): Promise<string> {
    const exposed = new URL(await this.#sandbox.exposePort(options.port));
    if (options.protocol === "ws") {
      exposed.protocol = exposed.protocol === "https:" ? "wss:" : "ws:";
    } else if (options.protocol) {
      exposed.protocol = `${options.protocol}:`;
    }
    return exposed.toString();
  }

  async stop(): Promise<void> {
    if (!this.#executor.suspend) {
      throw new Error("Workdir Harness reservation cannot be suspended");
    }
    await this.#executor.suspend({ reservationKey: this.#reservationKey });
  }

  async destroy(): Promise<void> {
    if (!this.#executor.release) {
      throw new Error("Workdir Harness reservation cannot be released");
    }
    await this.#executor.release({ reservationKey: this.#reservationKey });
  }
}

interface StartProcessOptions {
  sandbox: Sandbox;
  command: string;
  workingDirectory: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
}

class WorkdirHarnessProcess {
  readonly #sandbox: Sandbox;
  readonly #root: string;
  readonly #stdoutDone: Promise<void>;
  readonly #stderrDone: Promise<void>;
  readonly #abortSignal: AbortSignal | undefined;
  #waitPromise: Promise<{ exitCode: number }> | undefined;
  #killPromise: Promise<void> | undefined;

  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;

  private constructor(
    sandbox: Sandbox,
    root: string,
    abortSignal: AbortSignal | undefined,
  ) {
    this.#sandbox = sandbox;
    this.#root = root;
    this.#abortSignal = abortSignal;
    const stdout = processFileStream(sandbox, `${root}.stdout`, () =>
      this.#status(),
    );
    const stderr = processFileStream(sandbox, `${root}.stderr`, () =>
      this.#status(),
    );
    this.stdout = stdout.stream;
    this.stderr = stderr.stream;
    this.#stdoutDone = stdout.done;
    this.#stderrDone = stderr.done;
  }

  static async start(
    options: StartProcessOptions,
  ): Promise<WorkdirHarnessProcess> {
    const root = `/tmp/broods-harness-process-${randomUUID()}`;
    const q = shellQuote;
    const command = Buffer.from(options.command, "utf8").toString("base64");
    const wrapper = [
      `echo $$ > ${q(`${root}.pid`)}`,
      `exec > ${q(`${root}.stdout`)} 2> ${q(`${root}.stderr`)}`,
      `if ! cd ${q(options.workingDirectory)}; then echo 127 > ${q(`${root}.exit`)}; rm -f ${q(`${root}.running`)}; exit 127; fi`,
      `printf %s ${q(command)} | base64 -d | bash`,
      "__rc=$?",
      `echo "$__rc" > ${q(`${root}.exit`)}`,
      `rm -f ${q(`${root}.running`)}`,
      'exit "$__rc"',
    ].join("\n");
    const wrapperBase64 = Buffer.from(wrapper, "utf8").toString("base64");
    const launch = [
      `: > ${q(`${root}.stdout`)}`,
      `: > ${q(`${root}.stderr`)}`,
      `: > ${q(`${root}.running`)}`,
      `rm -f ${q(`${root}.exit`)} ${q(`${root}.pid`)}`,
      `setsid bash -c "$(printf %s ${q(wrapperBase64)} | base64 -d)" < /dev/null > /dev/null 2>&1 &`,
      "__attempt=0",
      `while [ ! -f ${q(`${root}.pid`)} ] && [ "$__attempt" -lt 100 ]; do sleep 0.01; __attempt=$((__attempt + 1)); done`,
      `[ -f ${q(`${root}.pid`)} ]`,
    ].join("; ");
    const result = await options.sandbox.exec(launch, { env: options.env });
    if (result.exit_code !== 0) throw workdirError("spawn command", result);

    const process = new WorkdirHarnessProcess(
      options.sandbox,
      root,
      options.abortSignal,
    );
    if (options.abortSignal) {
      // Start monitoring immediately so abort still terminates the process when
      // the caller does not invoke wait() until later (or at all).
      void process.wait().catch(() => {});
    }
    return process;
  }

  wait(): Promise<{ exitCode: number }> {
    this.#waitPromise ??= raceWithAbort(
      this.#waitForExit(),
      this.#abortSignal,
      () => this.kill(),
    );
    return this.#waitPromise;
  }

  kill(): Promise<void> {
    this.#killPromise ??= this.#kill();
    return this.#killPromise;
  }

  async #waitForExit(): Promise<{ exitCode: number }> {
    while (true) {
      const status = await this.#status();
      if (status.state !== "running") {
        const result = {
          exitCode: status.state === "done" ? status.exitCode : 1,
        };
        await Promise.all([this.#stdoutDone, this.#stderrDone]);
        await this.#sandbox
          .exec(
            `rm -f ${["pid", "stdout", "stderr", "exit", "running"]
              .map((extension) => shellQuote(`${this.#root}.${extension}`))
              .join(" ")}`,
          )
          .catch(() => {});
        return result;
      }
      await delay(PROCESS_POLL_INTERVAL_MS);
    }
  }

  async #kill(): Promise<void> {
    const q = shellQuote;
    const result = await this.#sandbox.exec(
      [
        `if [ -f ${q(`${this.#root}.pid`)} ]; then kill -TERM -"$(cat ${q(`${this.#root}.pid`)})" 2>/dev/null || true; sleep 0.05; kill -KILL -"$(cat ${q(`${this.#root}.pid`)})" 2>/dev/null || true; fi`,
        `[ -f ${q(`${this.#root}.exit`)} ] || echo 143 > ${q(`${this.#root}.exit`)}`,
        `rm -f ${q(`${this.#root}.running`)}`,
      ].join("; "),
    );
    if (result.exit_code !== 0) throw workdirError("kill command", result);
  }

  async #status(): Promise<
    | { state: "running" }
    | { state: "done"; exitCode: number }
    | { state: "unknown" }
  > {
    const q = shellQuote;
    const result = await this.#sandbox.exec(
      [
        `if [ -f ${q(`${this.#root}.exit`)} ]; then echo "done $(cat ${q(`${this.#root}.exit`)})"`,
        `elif [ -f ${q(`${this.#root}.running`)} ] && { [ ! -f ${q(`${this.#root}.pid`)} ] || kill -0 "$(cat ${q(`${this.#root}.pid`)})" 2>/dev/null; }; then echo running`,
        "else echo unknown",
        "fi",
      ].join("; "),
    );
    if (result.exit_code !== 0) throw workdirError("inspect command", result);
    const status = result.stdout.trim();
    if (status === "running") return { state: "running" };
    if (status.startsWith("done ")) {
      const exitCode = Number(status.slice(5));
      return {
        state: "done",
        exitCode: Number.isFinite(exitCode) ? exitCode : 1,
      };
    }
    return { state: "unknown" };
  }
}

function isWorkdirHarnessExecutor(
  value: unknown,
): value is WorkdirHarnessExecutor {
  return (
    !!value &&
    typeof value === "object" &&
    "acquireHarnessReservation" in value &&
    typeof value.acquireHarnessReservation === "function" &&
    "resumeHarnessReservation" in value &&
    typeof value.resumeHarnessReservation === "function"
  );
}

function processFileStream(
  sandbox: Sandbox,
  path: string,
  status: () => Promise<
    { state: "running" | "unknown" } | { state: "done"; exitCode: number }
  >,
): { stream: ReadableStream<Uint8Array>; done: Promise<void> } {
  let cancelled = false;
  const completed = Promise.withResolvers<void>();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let offset = 0;
        try {
          while (!cancelled) {
            const chunk = await readProcessChunk(sandbox, path, offset);
            if (chunk.byteLength > 0) {
              controller.enqueue(chunk);
              offset += chunk.byteLength;
            }
            const current = await status();
            if (current.state !== "running") {
              while (true) {
                const finalChunk = await readProcessChunk(
                  sandbox,
                  path,
                  offset,
                );
                if (finalChunk.byteLength === 0) break;
                controller.enqueue(finalChunk);
                offset += finalChunk.byteLength;
              }
              controller.close();
              completed.resolve();
              return;
            }
            await delay(PROCESS_POLL_INTERVAL_MS);
          }
        } catch (error) {
          if (!cancelled) controller.error(error);
          completed.resolve();
        }
      })();
    },
    cancel() {
      cancelled = true;
      completed.resolve();
    },
  });
  return { stream, done: completed.promise };
}

async function readProcessChunk(
  sandbox: Sandbox,
  path: string,
  offset: number,
): Promise<Uint8Array> {
  const result = await sandbox.exec(
    `if [ -f ${shellQuote(path)} ]; then dd if=${shellQuote(path)} bs=1 skip=${offset} count=${PROCESS_CHUNK_BYTES} 2>/dev/null | base64 | tr -d '\\n'; fi`,
  );
  if (result.exit_code !== 0) throw workdirError("read process output", result);
  return new Uint8Array(Buffer.from(result.stdout.trim(), "base64"));
}

async function readStreamText(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(content);
}

function raceWithAbort<T>(
  promise: Promise<T>,
  abortSignal: AbortSignal | undefined,
  onAbort: () => PromiseLike<void>,
): Promise<T> {
  if (!abortSignal) return promise;
  if (abortSignal.aborted) {
    void Promise.resolve(onAbort()).catch(() => {});
    return Promise.reject(
      abortSignal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      void Promise.resolve(onAbort()).catch(() => {});
      reject(abortSignal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    abortSignal.addEventListener("abort", abort, { once: true });
    if (abortSignal.aborted) abort();
    promise
      .then(resolve, reject)
      .finally(() => abortSignal.removeEventListener("abort", abort));
  });
}

function workdirError(
  operation: string,
  result: { stdout?: string; stderr?: string; exit_code: number },
): Error {
  return new Error(
    result.stderr ||
      result.stdout ||
      `Workdir failed to ${operation} (exit ${result.exit_code})`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
