/**
 * Custom (account-uploaded) tool dispatch + payload/frame plumbing.
 * Uploaded bundles run in the in-core V8 isolate tier (isolate-executor.ts).
 * Bundles that need node/npm/native (runtime "sandbox") or detached-async
 * execution are not yet supported off Lambda — that external/Firecracker path is
 * deferred to #82. Keep bundle loading and the runner frame protocol here; the
 * actual isolate execution lives in isolate-executor.ts.
 */

import type { AccountToolRecord } from "../../shared/domain/account-tools.ts";
import type { AgentToolConfig } from "../../shared/domain/agent-config.ts";
import { requireEnv } from "../../shared/env.ts";
import { isPlainObject } from "../../shared/object.ts";
import { readS3Bytes } from "../../shared/s3.ts";

export interface ExecuteAccountToolOptions {
  accountId: string;
  tool: AccountToolRecord;
  input: unknown;
  config: AgentToolConfig;
  options?: unknown;
  isolateExecutor?: (
    options: ExecuteAccountToolOptions,
  ) => AsyncGenerator<unknown, void, void>;
}

// Payload the isolate runner reads on stdin. The bundle is always inlined
// (base64) — the isolate runner does not fetch from S3 itself.
export interface RunnerPayload {
  bundleSourceB64: string;
  expectedSha256: string;
  toolName: string;
  input: unknown;
  config: Record<string, unknown>;
}

interface DetachedAsyncToolMetadata {
  resultId: string;
  completePath: string;
  completionToken: string;
  detached: true;
  [key: string]: unknown;
}

/**
 * Streaming entry used by the AI SDK tool adapter (account-tool.tool.ts). Isolate
 * bundles run in the in-core V8 isolate: an async-generator execute streams each
 * yield (surfaced as a preliminary tool result on the sync SSE path); a normal
 * bundle yields exactly once (its result). A sync-returning async generator lets
 * the SDK detect the async-iterable and stream it.
 *
 * Tools classified `runtime: "sandbox"` (node/npm/native) or launched as
 * detached-async need the external Firecracker execution plane, which is not yet
 * wired off Lambda — reject them clearly (tracked in #82) rather than trying to
 * run node code in a V8 isolate.
 */
export async function* streamAccountTool(
  options: ExecuteAccountToolOptions,
): AsyncGenerator<unknown, void, void> {
  if (options.tool.runtime === "sandbox") {
    throw new Error(
      sandboxUnsupportedMessage(
        options.tool.name,
        "needs the sandbox runtime (node/npm or native modules)",
      ),
    );
  }
  if (isDetachedAsyncTool(extractAsyncToolMetadata(options.options))) {
    throw new Error(
      sandboxUnsupportedMessage(
        options.tool.name,
        "runs as a detached-async job",
      ),
    );
  }

  const isolateExecutor =
    options.isolateExecutor ??
    (await import("./isolate-executor.ts")).streamAccountToolInIsolate;
  yield* isolateExecutor(options);
}

function sandboxUnsupportedMessage(toolName: string, reason: string): string {
  return `Custom tool "${toolName}" ${reason}, which is not yet supported off Lambda (tracked in #82). Rewrite it as a pure-compute (isolate) tool, or wait for the sandbox execution tier.`;
}

/** Loads the uploaded bundle from S3 and inlines it into the isolate payload. */
export async function createRunnerPayload(options: {
  bucket: string;
  tool: AccountToolRecord;
  input: unknown;
  config: AgentToolConfig;
}): Promise<RunnerPayload> {
  const bytes = await readS3Bytes(
    options.bucket,
    options.tool.bundleStorageKey,
  );
  return {
    bundleSourceB64: Buffer.from(bytes).toString("base64"),
    expectedSha256: options.tool.sha256,
    toolName: options.tool.name,
    input: options.input,
    config: mergeToolConfig(options.tool.defaultConfig, options.config.config),
  };
}

/** Convenience for callers that only need the bundle bucket name. */
export function toolBundlesBucket(): string {
  return requireEnv("TOOL_BUNDLES_BUCKET_NAME");
}

function mergeToolConfig(
  defaultConfig: Record<string, unknown> | undefined,
  agentConfig: unknown,
): Record<string, unknown> {
  return {
    ...(defaultConfig ?? {}),
    ...(isPlainObject(agentConfig) ? agentConfig : {}),
  };
}

function extractAsyncToolMetadata(options: unknown): unknown {
  return isPlainObject(options) ? options.asyncTool : undefined;
}

function isDetachedAsyncTool(
  value: unknown,
): value is DetachedAsyncToolMetadata {
  return (
    isPlainObject(value) &&
    value.detached === true &&
    typeof value.resultId === "string" &&
    typeof value.completePath === "string" &&
    typeof value.completionToken === "string"
  );
}

// --- Runner frame protocol (NDJSON) -------------------------------------------
// The isolate runner emits one JSON frame per line: `chunk` is an intermediate
// streamed output; `final` carries a non-streaming tool's whole result; `end`
// closes a streamed tool (its last chunk was the final output); `error` is a
// tool failure. FrameQueue lets the one-shot isolate path parse whole lines as
// they arrive and await the next frame until the stream closes.

export type ToolRunnerFrame =
  | { t: "chunk"; output: unknown }
  | { t: "final"; result: unknown }
  | { t: "end" }
  | { t: "error"; error: string };

// Parse one NDJSON line into a frame. Returns null for blank or non-protocol
// lines so a caller can tell "no frames" from a real error.
export function parseToolRunnerFrame(line: string): ToolRunnerFrame | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as ToolRunnerFrame;
    if (
      parsed &&
      (parsed.t === "chunk" ||
        parsed.t === "final" ||
        parsed.t === "end" ||
        parsed.t === "error")
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// Push/pull buffer that parses incoming NDJSON text into frames as whole lines
// arrive, and lets a consumer await the next frame until the stream closes.
export class FrameQueue {
  #buffer = "";
  #frames: ToolRunnerFrame[] = [];
  #waiters: Array<() => void> = [];
  #closed = false;

  push(text: string): void {
    this.#buffer += text;
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const frame = parseToolRunnerFrame(line);
      if (frame) this.#frames.push(frame);
    }
    this.#wake();
  }

  close(): void {
    const frame = parseToolRunnerFrame(this.#buffer);
    this.#buffer = "";
    if (frame) this.#frames.push(frame);
    this.#closed = true;
    this.#wake();
  }

  async *frames(): AsyncGenerator<ToolRunnerFrame, void, void> {
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
