/**
 * The NDJSON frame protocol every runner of uploaded account code shares, plus
 * the ToolBundles bucket name they all read from. The runners are the isolate
 * pool (hooks), the hook S3 loader, and the hosted-MCP Lambda. Depends only on
 * shared/, never on tools/ or a specific runner.
 */

import { requireEnv } from "../shared/env.ts";

/**
 * One NDJSON frame per stdout line: chunk = streamed output, final = a
 * non-streaming result, end = closed stream, error = run failure. cpuUsec is
 * stamped by a runner that can measure itself. `id` names one request of a
 * multi-request run: a final or error carrying it settles that request only,
 * `end` closes the run, and an error without an id fails the whole run.
 */
export type RunnerFrame =
  | { t: "chunk"; output: unknown }
  | { t: "final"; id?: string; result: unknown; cpuUsec?: number }
  | { t: "end"; cpuUsec?: number }
  | { t: "error"; id?: string; error: string; cpuUsec?: number }
  // A `console.*` line from the bundle. The host re-emits it through its own
  // logger; only the isolate tier produces these today.
  | { t: "log"; level: string; message: string };

/**
 * Push/pull buffer that parses incoming NDJSON text into frames as whole lines
 * arrive. The isolate executor and the hosted-MCP client push runner output in
 * and drain it with `frames()`.
 */
export class FrameQueue {
  #buffer = "";
  #frames: RunnerFrame[] = [];
  #waiters: Array<() => void> = [];
  #closed = false;

  /** Appends raw stdout text and queues every complete line as a frame. */
  push(text: string): void {
    this.#buffer += text;
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const frame = parseRunnerFrame(line);
      if (frame) this.#frames.push(frame);
    }
    this.#wake();
  }

  /** Parses any trailing partial line and ends the stream for `frames()`. */
  close(): void {
    const frame = parseRunnerFrame(this.#buffer);
    this.#buffer = "";
    if (frame) this.#frames.push(frame);
    this.#closed = true;
    this.#wake();
  }

  /** Yields frames as they arrive until the queue is closed and drained. */
  async *frames(): AsyncGenerator<RunnerFrame, void, void> {
    while (true) {
      while (this.#frames.length > 0) {
        yield this.#frames.shift()!;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  /** Resolves every consumer waiting for the next frame. */
  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter();
  }
}

/** Parses one NDJSON line into a frame; null for blank or non-protocol lines, which callers skip. */
export function parseRunnerFrame(line: string): RunnerFrame | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as RunnerFrame;
    if (
      parsed &&
      (parsed.t === "chunk" ||
        parsed.t === "final" ||
        parsed.t === "end" ||
        parsed.t === "error" ||
        parsed.t === "log")
    ) {
      return parsed;
    }

    return null;
  } catch {
    return null;
  }
}

/** The ToolBundles bucket that hook and hosted-MCP bundles are read from. */
export function toolBundlesBucket(): string {
  return requireEnv("TOOL_BUNDLES_BUCKET_NAME");
}
