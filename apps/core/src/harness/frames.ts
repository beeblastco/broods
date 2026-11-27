import { requireEnv } from "../shared/env.ts";

// A final or error carrying `id` settles that request of a multi-request run only;
// an error without one fails the whole run.
export type RunnerFrame =
  | { t: "chunk"; output: unknown }
  | { t: "final"; id?: string; result: unknown; cpuUsec?: number }
  | { t: "end"; cpuUsec?: number }
  | { t: "error"; id?: string; error: string; cpuUsec?: number }
  | { t: "log"; level: string; message: string };

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

/** Only `t` is checked; the other fields are trusted. */
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

export function toolBundlesBucket(): string {
  return requireEnv("TOOL_BUNDLES_BUCKET_NAME");
}
