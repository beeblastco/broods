/**
 * What every runner of an uploaded bundle shares: the payload shape, the NDJSON
 * frame protocol, and the AI SDK option extractors. Read by all three runners
 * (isolate, sandbox Lambda, hooks), so it depends only on shared/domain and
 * never reaches into tools/. Dispatch and invocation live in executor.ts.
 */

import type { AccountToolRecord } from "../../shared/domain/account-tools.ts";
import type { AgentToolConfig } from "../../shared/domain/agent-config.ts";
import { requireEnv } from "../../shared/env.ts";
import { isPlainObject } from "../../shared/object.ts";
import { getS3ObjectUrl, readS3Bytes } from "../../shared/s3.ts";

// The runner fetches at the start of a 35s-bounded invocation, so the grant only
// has to outlive a cold start.
const BUNDLE_URL_TTL_SECONDS = 120;
// Inline bundles are keyed by sha256, so a hit is the same bytes by definition
// and there is nothing to invalidate — only a size bound to keep.
const BUNDLE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

// bytes stays 0 while the read is in flight, which is also what marks an entry
// as not yet evictable.
interface CachedBundle {
  bytes: number;
  encoded: Promise<string>;
}

const bundleCache = new Map<string, CachedBundle>();
let bundleCacheBytes = 0;

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

// The isolate tier inlines the bytes on a local child's stdin; the Lambda tier
// gets a presigned GET, since an inlined bundle spends its 6 MB invoke quota.
export type RunnerBundleSource =
  | { bundleSourceB64: string }
  | { bundleUrl: string };

// Payload a runner reads on stdin. toolCallId is the AI SDK call id surfaced
// via options.toolCallId.
export type RunnerPayload = RunnerBundleSource & {
  expectedSha256: string;
  toolName: string;
  input: unknown;
  config: Record<string, unknown>;
  toolCallId?: string;
};

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

/** Builds the runner payload, addressing the uploaded bundle per transport. */
export async function createRunnerPayload(options: {
  bucket: string;
  tool: AccountToolRecord;
  input: unknown;
  config: AgentToolConfig;
  toolCallId?: string;
  bundleTransport: "inline" | "presigned-url";
}): Promise<RunnerPayload> {
  return {
    ...(await bundleSource(
      options.bundleTransport,
      options.bucket,
      options.tool.bundleStorageKey,
      options.tool.sha256,
    )),
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

async function bundleSource(
  transport: "inline" | "presigned-url",
  bucket: string,
  key: string,
  sha256: string,
): Promise<RunnerBundleSource> {
  if (transport === "inline") {
    return { bundleSourceB64: await inlineBundle(bucket, key, sha256) };
  }

  return {
    bundleUrl: await getS3ObjectUrl(bucket, key, {
      expiresInSeconds: BUNDLE_URL_TTL_SECONDS,
    }),
  };
}

// Caches the read in flight, not just its result, so concurrent calls on one
// tool share a single S3 GET instead of both fetching and both charging bytes.
async function inlineBundle(
  bucket: string,
  key: string,
  sha256: string,
): Promise<string> {
  const cached = bundleCache.get(sha256);
  if (cached !== undefined) return await cached.encoded;

  const entry: CachedBundle = {
    bytes: 0,
    encoded: readS3Bytes(bucket, key).then((raw) =>
      Buffer.from(raw).toString("base64"),
    ),
  };
  bundleCache.set(sha256, entry);
  let encoded: string;
  try {
    encoded = await entry.encoded;
  } catch (error) {
    // A transient S3 failure must not become this key's cached answer.
    bundleCache.delete(sha256);
    throw error;
  }
  entry.bytes = encoded.length;
  bundleCacheBytes += encoded.length;
  evictOldestBundles();

  return encoded;
}

// Oldest first; the Map preserves insertion order. An in-flight read has no
// size yet and nothing to reclaim, so it is left alone.
function evictOldestBundles(): void {
  for (const [sha256, entry] of bundleCache) {
    if (bundleCacheBytes <= BUNDLE_CACHE_MAX_BYTES) return;
    if (entry.bytes === 0) continue;
    bundleCacheBytes -= entry.bytes;
    bundleCache.delete(sha256);
  }
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
