/**
 * The NDJSON frame protocol every runner of uploaded account code shares —
 * the isolate pool (hooks), the hook S3 loader, and the hosted-MCP Lambda —
 * plus the ToolBundles bucket name they all read from. Depends only on
 * shared/, never on tools/ or a specific runner.
 */

import { requireEnv } from "../shared/env.ts";

// One NDJSON frame per stdout line: chunk = streamed output, final = a
// non-streaming result, end = closed stream, error = run failure. cpuUsec is
// stamped by a runner that can measure itself. `id` names one request of a
// multi-request run: a final or error carrying it settles that request only,
// `end` closes the run, and an error without an id fails the whole run.
export type RunnerFrame =
  | { t: "chunk"; output: unknown }
  | { t: "final"; id?: string; result: unknown; cpuUsec?: number }
  | { t: "end"; cpuUsec?: number }
  | { t: "error"; id?: string; error: string; cpuUsec?: number }
  // A `console.*` line from the bundle. The host re-emits it through its own
  // logger; only the isolate tier produces these today.
  | { t: "log"; level: string; message: string };

// Push/pull buffer that parses incoming NDJSON text into frames as whole lines
// arrive, letting a consumer await the next frame until the stream closes.
export class FrameQueue {
  #buffer = "";
  #frames: RunnerFrame[] = [];
  #waiters: Array<() => void> = [];
  #closed = false;

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

  close(): void {
    const frame = parseRunnerFrame(this.#buffer);
    this.#buffer = "";
    if (frame) this.#frames.push(frame);
    this.#closed = true;
    this.#wake();
  }

  async *frames(): AsyncGenerator<RunnerFrame, void, void> {
    while (true) {
      while (this.#frames.length > 0) {
        yield this.#frames.shift()!;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter();
  }
}

// Parse one NDJSON line into a frame; null for blank or non-protocol lines so a
// caller can tell "no frames" from a real error.
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

/** Convenience for callers that only need the bundle bucket name. */
export function toolBundlesBucket(): string {
  return requireEnv("TOOL_BUNDLES_BUCKET_NAME");
}
