/**
 * Sandbox-backed execution for account-uploaded tool bundles.
 * Harness resolves metadata; uploaded code is fetched and executed in the `sandbox`
 * (workdir Firecracker) provider. Keep bundle loading and user-code execution out
 * of harness-processing.
 */

import { Readable } from "node:stream";
import { optionalEnv, requireEnv } from "../../_shared/env.ts";
import { getS3ObjectUrl, readS3Bytes } from "../../_shared/s3.ts";
import { logWarn } from "../../_shared/log.ts";
import type { AccountToolRecord, AgentToolConfig } from "../../_shared/storage/index.ts";
import { createSandboxExecutor } from "../sandbox/index.ts";
import type { SandboxCpuSample } from "../sandbox/types.ts";
import { generateJobId } from "../sandbox/jobs.ts";
import { getHarnessPublicUrl } from "../self-url.ts";
import { buildWorkerEnsureCommand, buildWorkerInvokeCommand, parseWorkerFrame, type WorkerFrame } from "./custom-tool-worker.ts";

// The marker lets the foreground path find the one structured JSON result line
// reliably instead of accidentally parsing user logs as protocol.
// Detached/background tools skip the marker and report via HTTP callback instead.
const RESULT_MARKER = "__CUSTOM_TOOL_RESULT__";
const RUNNER_HEREDOC_TAG = "__CUSTOM_TOOL_RUNNER__";

// Timeout for foreground (synchronous) execution only. The sandbox executor
// does not enforce timeoutSeconds for runBackground — detached jobs run as
// setsid processes and are only bounded by the reserved sandbox's idle/lifetime
// lifecycle. The field is required by SandboxRunRequest so we still pass it for background.
const FOREGROUND_TIMEOUT_SECONDS = 120;
const RUNNER_OUTPUT_LIMIT_BYTES = 1024 * 1024;
// Inline the bundle into the exec payload when it fits, so the sandbox skips the
// cross-cloud S3 fetch entirely (it reads the inlined source directly). The
// runner ships as one `bash -lc` arg, capped by the kernel's MAX_ARG_STRLEN
// (128 KB); 64 KB raw (~85 KB base64) stays safely under it. Larger (e.g.
// npm-bundled) tools fall back to the signed URL the sandbox fetches itself.
const MAX_INLINE_BUNDLE_BYTES = 64 * 1024;

interface ExecuteAccountToolOptions {
  accountId: string;
  tool: AccountToolRecord;
  input: unknown;
  config: AgentToolConfig;
  options?: unknown;
  createExecutor?: typeof createSandboxExecutor;
  // Reports the tool sandbox's CPU (role "tool") for usage metering. Only the
  // one-shot runner path carries a cgroup CPU figure; the resident-worker fast
  // path does not, so it is not metered.
  onSandboxCpu?: (sample: SandboxCpuSample) => void;
}

interface DetachedAsyncToolMetadata {
  resultId: string;
  completePath: string;
  completionToken: string;
  detached: true;
  [key: string]: unknown;
}

interface RunnerPayload {
  // Exactly one source is set: bundleSourceB64 for inlined small bundles,
  // bundleUrl for large ones the sandbox downloads via the signed URL.
  bundleSourceB64?: string;
  bundleUrl?: string;
  expectedSha256: string;
  toolName: string;
  input: unknown;
  config: Record<string, unknown>;
  asyncTool: unknown;
  detachedCompletion?: {
    url: string;
    token: string;
  };
}

interface RunnerResult {
  ok: boolean;
  result?: unknown;
  error?: unknown;
}

/**
 * Buffered entry: run the tool and return its final output. Drains the streaming
 * generator to the last value, so the detached launch ack, the one-shot fallback,
 * and tests all get a plain value regardless of whether the tool streamed.
 */
export async function executeAccountToolInSandbox(options: ExecuteAccountToolOptions): Promise<unknown> {
  let last: unknown;
  for await (const output of streamAccountToolInSandbox(options)) {
    last = output;
  }
  return last;
}

/**
 * Streaming entry used by the AI SDK tool adapter (account-tool.tool.ts). A bundle
 * whose execute is an async generator streams each yield (surfaced as a preliminary
 * tool result on the sync SSE path); a normal bundle yields exactly once — its
 * result. The function is a sync-returning async generator so the SDK detects the
 * async-iterable and streams it (an async function would resolve to the iterator
 * and the SDK would not stream). Detached async tools are launched, not streamed.
 */
export async function* streamAccountToolInSandbox({
  accountId,
  tool,
  input,
  config,
  options,
  createExecutor = createSandboxExecutor,
  onSandboxCpu,
}: ExecuteAccountToolOptions): AsyncGenerator<unknown, void, void> {
  const asyncTool = extractAsyncToolMetadata(options);
  if (isDetachedAsyncTool(asyncTool)) {
    yield await startAccountToolInSandboxBackground({ accountId, tool, input, config, asyncTool, createExecutor });
    return;
  }
  yield* streamAccountToolForeground({ accountId, tool, input, config, asyncTool, createExecutor, onSandboxCpu });
}

async function* streamAccountToolForeground({
  accountId,
  tool,
  input,
  config,
  asyncTool,
  createExecutor,
  onSandboxCpu,
}: ExecuteAccountToolOptions & { asyncTool: unknown; createExecutor: typeof createSandboxExecutor }): AsyncGenerator<unknown, void, void> {
  const bucket = requireEnv("TOOL_BUNDLES_BUCKET_NAME");
  const payload = await createRunnerPayload({ bucket, tool, input, config, asyncTool });
  const executor = createExecutor(customToolExecutorConfig());
  const reservationKey = customToolReservationKey(accountId, tool.toolId);

  // Fast path: the resident in-sandbox worker (no per-call node startup), streaming
  // NDJSON frames. Zero frames means the worker was unreachable — fall through to
  // the one-shot runner; an `error` frame is a real tool error surfaced as-is.
  if (executor.execInReservedPod) {
    let sawFrame = false;
    for await (const frame of streamWorkerInvoke(executor, reservationKey, payload, tool.name, onSandboxCpu)) {
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
      throw new Error(frame.error || "custom tool execution failed");
    }
    if (sawFrame) {
      return;
    }
  }
  yield await runOneShotRunner(executor, reservationKey, payload, tool.name, onSandboxCpu);
}

// Bridge the worker's NDJSON output (delivered live via onStdout, or all at once
// by buffered executors) into a stream of frames. An exec failure is treated like
// an unreachable worker (no frames -> caller falls back to the one-shot runner).
async function* streamWorkerInvoke(
  executor: ReturnType<typeof createSandboxExecutor>,
  reservationKey: string,
  payload: RunnerPayload,
  toolName: string,
  onSandboxCpu?: (sample: SandboxCpuSample) => void,
): AsyncGenerator<WorkerFrame, void, void> {
  const queue = new FrameQueue();
  let fed = 0;
  const done = executor.execInReservedPod!({ reservationKey }, buildWorkerInvokeCommand(), {
    stdin: Readable.from(JSON.stringify(payload)),
    timeoutSeconds: FOREGROUND_TIMEOUT_SECONDS,
    outputLimitBytes: RUNNER_OUTPUT_LIMIT_BYTES,
    onStdout: (chunk) => {
      fed += chunk.length;
      queue.push(chunk);
    },
  }).then((result) => {
    if (result.cpuUsec !== undefined && result.cpuUsec > 0) {
      onSandboxCpu?.({ type: "sandbox", role: "tool", toolName, cpuUsec: result.cpuUsec });
    }
    // Buffered executors (and the test mock) surface the whole body only here;
    // feed whatever onStdout did not already deliver, then close.
    if (result.stdout.length > fed) queue.push(result.stdout.slice(fed));
    queue.close();
  }).catch((error) => {
    logWarn("custom tool worker exec failed; falling back to one-shot runner", {
      reservationKey,
      error: error instanceof Error ? error.message : String(error),
    });
    queue.close();
  });

  yield* queue.frames();
  await done;
}

// Push/pull buffer that parses incoming NDJSON text into worker frames as whole
// lines arrive, and lets a consumer await the next frame until the stream closes.
class FrameQueue {
  #buffer = "";
  #frames: WorkerFrame[] = [];
  #waiters: Array<() => void> = [];
  #closed = false;

  push(text: string): void {
    this.#buffer += text;
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const frame = parseWorkerFrame(line);
      if (frame) this.#frames.push(frame);
    }
    this.#wake();
  }

  close(): void {
    const frame = parseWorkerFrame(this.#buffer);
    this.#buffer = "";
    if (frame) this.#frames.push(frame);
    this.#closed = true;
    this.#wake();
  }

  async *frames(): AsyncGenerator<WorkerFrame, void, void> {
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

async function runOneShotRunner(
  executor: ReturnType<typeof createSandboxExecutor>,
  reservationKey: string,
  payload: RunnerPayload,
  toolName: string,
  onSandboxCpu?: (sample: SandboxCpuSample) => void,
): Promise<unknown> {
  const result = await executor.run({
    runtime: "bash",
    code: nodeHeredoc(runnerCode(payload)),
    reservationKey,
    timeoutSeconds: FOREGROUND_TIMEOUT_SECONDS,
    outputLimitBytes: RUNNER_OUTPUT_LIMIT_BYTES,
  });

  if (result.cpuUsec !== undefined && result.cpuUsec > 0) {
    onSandboxCpu?.({ type: result.provider, role: "tool", toolName: toolName, cpuUsec: result.cpuUsec });
  }

  const parsed = parseRunnerOutput(result.stdout);
  if (!result.ok) {
    const message = parsed?.ok === false && typeof parsed.error === "string"
      ? parsed.error
      : (result.stderr || result.stdout || "custom tool execution failed");
    throw new Error(message);
  }
  if (!parsed) {
    throw new Error("custom tool runner did not return a result");
  }
  if (parsed.ok === false) {
    throw new Error(typeof parsed.error === "string" ? parsed.error : "custom tool execution failed");
  }
  return parsed.result;
}

async function startAccountToolInSandboxBackground({
  accountId,
  tool,
  input,
  config,
  asyncTool,
  createExecutor,
}: ExecuteAccountToolOptions & { asyncTool: DetachedAsyncToolMetadata; createExecutor: typeof createSandboxExecutor }): Promise<unknown> {
  const bucket = requireEnv("TOOL_BUNDLES_BUCKET_NAME");
  const completionUrl = await sandboxJobCompletionUrl(asyncTool.completePath);
  const payload = await createRunnerPayload({
    bucket,
    tool,
    input,
    config,
    asyncTool: {
      ...asyncTool,
      completeUrl: completionUrl,
    },
    detachedCompletion: {
      url: completionUrl,
      token: asyncTool.completionToken,
    },
  });

  const executor = createExecutor(customToolExecutorConfig());
  if (!executor.runBackground) {
    throw new Error("custom async tools require a sandbox executor with background support");
  }
  await executor.runBackground({
    runtime: "bash",
    code: nodeHeredoc(runnerCode(payload)),
    reservationKey: customToolReservationKey(accountId, tool.toolId),
    workspaceRoot: "/tmp",
    jobId: generateJobId(),
    timeoutSeconds: FOREGROUND_TIMEOUT_SECONDS,
    outputLimitBytes: RUNNER_OUTPUT_LIMIT_BYTES,
  });
  return { type: "text", value: `Started async tool ${asyncTool.resultId}` }; // statusId (model-facing) === resultId; this text is overridden by the async wrapper's toModelOutput
}

async function createRunnerPayload(options: {
  bucket: string;
  tool: AccountToolRecord;
  input: unknown;
  config: AgentToolConfig;
  asyncTool: unknown;
  detachedCompletion?: RunnerPayload["detachedCompletion"];
}): Promise<RunnerPayload> {
  const base: RunnerPayload = {
    expectedSha256: options.tool.sha256,
    toolName: options.tool.name,
    input: options.input,
    config: mergeToolConfig(options.tool.defaultConfig, options.config.config),
    asyncTool: options.asyncTool,
    ...(options.detachedCompletion ? { detachedCompletion: options.detachedCompletion } : {}),
  };
  const bytes = await readS3Bytes(options.bucket, options.tool.bundleStorageKey);
  if (bytes.byteLength <= MAX_INLINE_BUNDLE_BYTES) {
    return { ...base, bundleSourceB64: Buffer.from(bytes).toString("base64") };
  }
  return { ...base, bundleUrl: await getS3ObjectUrl(options.bucket, options.tool.bundleStorageKey) };
}

async function sandboxJobCompletionUrl(completePath: string): Promise<string> {
  const baseUrl = await getHarnessPublicUrl();
  if (!baseUrl) {
    throw new Error("custom async tool completion requires AGENT_SERVICE_URL or Lambda Function URL");
  }
  return new URL(completePath, ensureTrailingSlash(baseUrl)).toString();
}

function runnerCode(payload: RunnerPayload): string {
  return `
const { createHash } = await import("node:crypto");
const { mkdir, writeFile, readFile, rename } = await import("node:fs/promises");
const { pathToFileURL } = await import("node:url");
const path = await import("node:path");

const marker = ${JSON.stringify(RESULT_MARKER)};
const payload = ${JSON.stringify(payload)};

async function main() {
  const toolDir = await cacheDir(payload.expectedSha256);
  const bundlePath = path.join(toolDir, "tool.mjs");
  // Warm sandbox path: if this sha is already cached, skip S3 entirely and import
  // the local module. Cache misses download through the short-lived signed URL.
  await ensureBundle(bundlePath);
  const mod = await import(pathToFileURL(bundlePath).href + "?sha=" + payload.expectedSha256);
  const exported = mod.default;
  const definition = typeof exported === "function" ? await exported() : exported;
  if (!definition || typeof definition.execute !== "function") {
    throw new Error("custom tool bundle default export must expose execute(ctx, input)");
  }
  if (definition.name && definition.name !== payload.toolName) {
    throw new Error("custom tool bundle name does not match uploaded manifest");
  }
  const ctx = {
    config: payload.config,
    asyncTool: payload.asyncTool,
    env: {},
  };
  // This is the uploaded tool's execute function. The source text lives in this
  // repo only as runner code, but the call happens inside the sandbox.
  // The one-shot runner does not stream, so an async-generator execute is drained
  // to its last yielded value (the final result), matching the SDK's convention.
  let result = definition.execute(ctx, payload.input);
  if (result != null && typeof result[Symbol.asyncIterator] === "function") {
    let last;
    for await (const chunk of result) last = chunk;
    result = last;
  } else {
    result = await result;
  }
  if (payload.detachedCompletion) {
    await completeAsyncTool("completed", result);
    return;
  }
  process.stdout.write("\\n" + marker + JSON.stringify({ ok: true, result }) + "\\n");
}

async function cacheDir(sha256) {
  const roots = [
    "/cache/tools",
    process.env.HOME ? path.join(process.env.HOME, ".cache/tools") : undefined,
    "/tmp/cache/tools",
  ].filter(Boolean);
  let lastError;
  for (const root of roots) {
    const dir = path.join(root, sha256);
    try {
      await mkdir(dir, { recursive: true });
      return dir;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("failed to create custom tool cache directory");
}

async function ensureBundle(bundlePath) {
  const cached = await fileHash(bundlePath);
  if (cached === payload.expectedSha256) {
    return;
  }
  const source = payload.bundleSourceB64 !== undefined
    ? Buffer.from(payload.bundleSourceB64, "base64")
    : await downloadBundle(payload.bundleUrl);
  const tempPath = bundlePath + "." + process.pid + ".tmp";
  await writeFile(tempPath, source);
  const tempHash = await fileHash(tempPath);
  if (tempHash !== payload.expectedSha256) {
    throw new Error("custom tool bundle hash mismatch inside runner");
  }
  await rename(tempPath, bundlePath);
}

async function downloadBundle(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("failed to download custom tool bundle: " + response.status + " " + response.statusText);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fileHash(filePath) {
  try {
    return createHash("sha256").update(await readFile(filePath)).digest("hex");
  } catch {
    return null;
  }
}

main().catch(async (error) => {
  if (payload.detachedCompletion) {
    try {
      await completeAsyncTool("failed", undefined, error instanceof Error ? error.message : String(error));
    } catch {}
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\\n" + marker + JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }) + "\\n");
  process.exitCode = 1;
});

async function completeAsyncTool(status, response, error) {
  const body = status === "completed"
    ? { status, response }
    : { status, error: error || "custom async tool failed" };
  const result = await fetch(payload.detachedCompletion.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-job-token": payload.detachedCompletion.token,
    },
    body: JSON.stringify(body),
  });
  if (!result.ok) {
    throw new Error("custom async tool completion failed: " + result.status + " " + await result.text());
  }
}
`;
}

function nodeHeredoc(code: string): string {
  return `node <<'${RUNNER_HEREDOC_TAG}'\n${code}\n${RUNNER_HEREDOC_TAG}`;
}

function parseRunnerOutput(stdout: string): RunnerResult | null {
  // Uploaded tools may log arbitrary stdout. The marker lets the Lambda find the
  // runner's final structured JSON line without treating user logs as protocol.
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((entry) => entry.startsWith(RESULT_MARKER));
  if (!line) return null;
  return JSON.parse(line.slice(RESULT_MARKER.length));
}

function mergeToolConfig(
  defaultConfig: Record<string, unknown> | undefined,
  agentConfig: unknown,
): Record<string, unknown> {
  return {
    ...(defaultConfig ?? {}),
    ...(agentConfig && typeof agentConfig === "object" && !Array.isArray(agentConfig)
      ? agentConfig as Record<string, unknown>
      : {}),
  };
}

function extractAsyncToolMetadata(options: unknown): unknown {
  if (!options || typeof options !== "object") return undefined;
  return (options as { asyncTool?: unknown }).asyncTool;
}

function isDetachedAsyncTool(value: unknown): value is DetachedAsyncToolMetadata {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { detached?: unknown }).detached === true &&
    typeof (value as { resultId?: unknown }).resultId === "string" &&
    typeof (value as { completePath?: unknown }).completePath === "string" &&
    typeof (value as { completionToken?: unknown }).completionToken === "string",
  );
}

function customToolExecutorConfig(): Parameters<typeof createSandboxExecutor>[0] {
  // createSandboxExecutor only creates a local client object. Sandbox lookup,
  // first-use creation, and idle resume happen inside executor.run/runBackground.
  // Untrusted uploaded tool code runs in the self-hosted Firecracker `sandbox`
  // (workdir) provider, reserved per tool so detached jobs outlive the request.
  return {
    provider: "sandbox",
    persistent: true,
    // Uploaded tool code may call any external API, but never the sandbox host,
    // instance metadata service, or other private ranges.
    network: {
      mode: "restricted",
      allowCidrs: ["0.0.0.0/0"],
      denyCidrs: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "127.0.0.0/8", "100.64.0.0/10"],
    },
    timeout: 120,
    outputLimitBytes: 1024 * 1024,
    lifecycle: {
      idleTimeoutSeconds: 300,
      maxLifetimeSeconds: 3600,
    },
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function customToolReservationKey(accountId: string, toolId: string): string {
  return `custom-tool-${accountId}-${toolId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
}

/**
 * Best-effort sandbox warm-up. Fired when a request's toolset includes an async
 * uploaded tool, so the reserved sandbox is created/resumed and Ready while the
 * model is still producing its first response — the real call then lands on a
 * warm sandbox (~0.8s) instead of paying create-on-first-use. Fire-and-forget; only
 * runs in the deployed Lambda (it would otherwise hit a real sandbox host from tests/local).
 */
export function prewarmAccountTool(
  accountId: string,
  toolId: string,
  createExecutor: typeof createSandboxExecutor = createSandboxExecutor,
): void {
  if (!optionalEnv("AWS_LAMBDA_FUNCTION_NAME")) return;
  const executor = createExecutor(customToolExecutorConfig());
  if (!executor.prewarm) return;
  const reservationKey = customToolReservationKey(accountId, toolId);
  void (async () => {
    await executor.prewarm!({ reservationKey });
    // Also start the resident worker now, so the first real call skips both sandbox
    // create and worker startup.
    if (executor.execInReservedPod) {
      await executor.execInReservedPod({ reservationKey }, buildWorkerEnsureCommand(), { timeoutSeconds: 30 });
    }
  })().catch((error) => logWarn("custom tool prewarm failed", {
    toolId,
    error: error instanceof Error ? error.message : String(error),
  }));
}
