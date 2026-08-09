/**
 * File-spooled Harness process over a blocking sandbox shell transport.
 * The launcher detaches the real command, while short shell calls poll output,
 * status, and cancellation so providers without a native streaming process API
 * can still satisfy the AI SDK Harness process contract.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { shellQuote } from "./utils.ts";

const PROCESS_CHUNK_BYTES = 64 * 1024;
const PROCESS_POLL_INTERVAL_MS = 25;

export interface HarnessShellExecutor {
  exec(
    command: string,
    options?: {
      env?: Record<string, string>;
      abortSignal?: AbortSignal;
    },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

interface HarnessShellProcessOptions {
  executor: HarnessShellExecutor;
  command: string;
  workingDirectory: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
}

export class HarnessShellProcess {
  readonly #executor: HarnessShellExecutor;
  readonly #root: string;
  readonly #stdoutDone: Promise<void>;
  readonly #stderrDone: Promise<void>;
  readonly #abortSignal: AbortSignal | undefined;
  #waitPromise: Promise<{ exitCode: number }> | undefined;
  #killPromise: Promise<void> | undefined;

  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;

  private constructor(
    executor: HarnessShellExecutor,
    root: string,
    abortSignal: AbortSignal | undefined,
  ) {
    this.#executor = executor;
    this.#root = root;
    this.#abortSignal = abortSignal;
    const stdout = processFileStream(executor, `${root}.stdout`, () =>
      this.#status(),
    );
    const stderr = processFileStream(executor, `${root}.stderr`, () =>
      this.#status(),
    );
    this.stdout = stdout.stream;
    this.stderr = stderr.stream;
    this.#stdoutDone = stdout.done;
    this.#stderrDone = stderr.done;
  }

  static async start(
    options: HarnessShellProcessOptions,
  ): Promise<HarnessShellProcess> {
    options.abortSignal?.throwIfAborted();
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
    ].join("\n");
    const result = await options.executor.exec(launch, {
      ...(options.env ? { env: options.env } : {}),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
    if (result.exitCode !== 0) {
      throw shellProcessError("spawn command", result);
    }

    const process = new HarnessShellProcess(
      options.executor,
      root,
      options.abortSignal,
    );
    if (options.abortSignal) void process.wait().catch(() => {});

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
        await this.#executor
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
    const result = await this.#executor.exec(
      [
        `if [ -f ${q(`${this.#root}.pid`)} ]; then kill -TERM -"$(cat ${q(`${this.#root}.pid`)})" 2>/dev/null || true; sleep 0.05; kill -KILL -"$(cat ${q(`${this.#root}.pid`)})" 2>/dev/null || true; fi`,
        `[ -f ${q(`${this.#root}.exit`)} ] || echo 143 > ${q(`${this.#root}.exit`)}`,
        `rm -f ${q(`${this.#root}.running`)}`,
      ].join("; "),
    );
    if (result.exitCode !== 0) {
      throw shellProcessError("kill command", result);
    }
  }

  async #status(): Promise<
    | { state: "running" }
    | { state: "done"; exitCode: number }
    | { state: "unknown" }
  > {
    const q = shellQuote;
    const result = await this.#executor.exec(
      [
        `if [ -f ${q(`${this.#root}.exit`)} ]; then echo "done $(cat ${q(`${this.#root}.exit`)})"`,
        `elif [ -f ${q(`${this.#root}.running`)} ] && { [ ! -f ${q(`${this.#root}.pid`)} ] || kill -0 "$(cat ${q(`${this.#root}.pid`)})" 2>/dev/null; }; then echo running`,
        "else echo unknown",
        "fi",
      ].join("; "),
    );
    if (result.exitCode !== 0) {
      throw shellProcessError("inspect command", result);
    }
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

export async function readHarnessStream(
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

function processFileStream(
  executor: HarnessShellExecutor,
  path: string,
  status: () => Promise<
    { state: "running" | "unknown" } | { state: "done"; exitCode: number }
  >,
): { stream: ReadableStream<Uint8Array>; done: Promise<void> } {
  let cancelled = false;
  const completed = Promise.withResolvers<void>();
  const stream = new ReadableStream<Uint8Array>({
    start: function(controller) {
      void (async () => {
        let offset = 0;
        try {
          while (!cancelled) {
            const chunk = await readProcessChunk(executor, path, offset);
            if (chunk.byteLength > 0) {
              controller.enqueue(chunk);
              offset += chunk.byteLength;
            }
            const current = await status();
            if (current.state !== "running") {
              while (true) {
                const finalChunk = await readProcessChunk(
                  executor,
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
    cancel: function() {
      cancelled = true;
      completed.resolve();
    },
  });

  return { stream: stream, done: completed.promise };
}

async function readProcessChunk(
  executor: HarnessShellExecutor,
  path: string,
  offset: number,
): Promise<Uint8Array> {
  const result = await executor.exec(
    `if [ -f ${shellQuote(path)} ]; then dd if=${shellQuote(path)} bs=1 skip=${offset} count=${PROCESS_CHUNK_BYTES} 2>/dev/null | base64 | tr -d '\\n'; fi`,
  );
  if (result.exitCode !== 0) {
    throw shellProcessError("read process output", result);
  }

  return new Uint8Array(Buffer.from(result.stdout.trim(), "base64"));
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

function shellProcessError(
  operation: string,
  result: { stdout: string; stderr: string; exitCode: number },
): Error {
  return new Error(
    result.stderr ||
      result.stdout ||
      `Sandbox failed to ${operation} (exit ${result.exitCode})`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
