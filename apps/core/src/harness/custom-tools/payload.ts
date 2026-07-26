/**
 * Shared isolate runtime plumbing: the runner payload shape, the NDJSON frame
 * protocol, and the AI SDK option extractors. Leaf of the isolate plane — depends
 * only on shared/domain, so both the custom-tool dispatch and the hook runner can
 * build payloads without reaching into tools/. Spawning lives in executor.ts.
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
  sandboxExecutor?: (
    options: ExecuteAccountToolOptions,
  ) => AsyncGenerator<unknown, void, void>;
}

// Payload the isolate runner reads on stdin. The bundle is always inlined
// (base64); toolCallId is the AI SDK call id surfaced via options.toolCallId.
export interface RunnerPayload {
  bundleSourceB64: string;
  expectedSha256: string;
  toolName: string;
  input: unknown;
  config: Record<string, unknown>;
  toolCallId?: string;
}

// One NDJSON frame per stdout line: chunk = streamed output, final = a
// non-streaming result, end = closed stream, error = tool failure.
export type ToolRunnerFrame =
  | { t: "chunk"; output: unknown }
  | { t: "final"; result: unknown }
  | { t: "end" }
  | { t: "error"; error: string };

// Push/pull buffer that parses incoming NDJSON text into frames as whole lines
// arrive, letting a consumer await the next frame until the stream closes.
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

/** Loads the uploaded bundle from S3 and inlines it into the isolate payload. */
export async function createRunnerPayload(options: {
  bucket: string;
  tool: AccountToolRecord;
  input: unknown;
  config: AgentToolConfig;
  toolCallId?: string;
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
    ...(options.toolCallId !== undefined
      ? { toolCallId: options.toolCallId }
      : {}),
  };
}

/** Reads the AI SDK ToolExecutionOptions.abortSignal when present. */
export function abortSignalFromOptions(
  options: unknown,
): AbortSignal | undefined {
  if (!isPlainObject(options)) return undefined;
  const signal = options.abortSignal;

  return signal instanceof AbortSignal ? signal : undefined;
}

// Parse one NDJSON line into a frame; null for blank or non-protocol lines so a
// caller can tell "no frames" from a real error.
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

/** Convenience for callers that only need the bundle bucket name. */
export function toolBundlesBucket(): string {
  return requireEnv("TOOL_BUNDLES_BUCKET_NAME");
}

/** Reads the AI SDK ToolExecutionOptions.toolCallId when present. */
export function toolCallIdFromOptions(options: unknown): string | undefined {
  if (!isPlainObject(options)) return undefined;

  return typeof options.toolCallId === "string"
    ? options.toolCallId
    : undefined;
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
