/**
 * Kubernetes-backed execution for account-uploaded tool bundles.
 * Harness resolves metadata; uploaded code is fetched and executed in the sandbox.
 * Keep bundle loading and user-code execution out of harness-processing.
 */

import { requireEnv } from "../../_shared/env.ts";
import { getS3ObjectUrl } from "../../_shared/s3.ts";
import type { AccountToolRecord, AgentToolConfig } from "../../_shared/storage/index.ts";
import { createSandboxExecutor } from "../sandbox/index.ts";
import { generateJobId } from "../sandbox/jobs.ts";
import { getHarnessPublicUrl } from "../self-url.ts";

// The marker lets the foreground path find the one structured JSON result line
// reliably instead of accidentally parsing user logs as protocol.
// Detached/background tools skip the marker and report via HTTP callback instead.
const RESULT_MARKER = "__CUSTOM_TOOL_RESULT__";
const RUNNER_HEREDOC_TAG = "__CUSTOM_TOOL_RUNNER__";

// Timeout for foreground (synchronous) execution only. The kubernetes executor
// does not enforce timeoutSeconds for runBackground — detached jobs run as
// setsid processes and are only bounded by the pod's shutdownTime lifecycle.
// The field is required by SandboxRunRequest so we still pass it for background.
const FOREGROUND_TIMEOUT_SECONDS = 120;
const RUNNER_OUTPUT_LIMIT_BYTES = 1024 * 1024;

interface ExecuteAccountToolOptions {
  accountId: string;
  tool: AccountToolRecord;
  input: unknown;
  config: AgentToolConfig;
  options?: unknown;
  createExecutor?: typeof createSandboxExecutor;
}

interface DetachedAsyncToolMetadata {
  resultId: string;
  completePath: string;
  completionToken: string;
  detached: true;
  [key: string]: unknown;
}

interface RunnerPayload {
  bundleUrl: string;
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

export async function executeAccountToolInSandbox({
  accountId,
  tool,
  input,
  config,
  options,
  createExecutor = createSandboxExecutor,
}: ExecuteAccountToolOptions): Promise<unknown> {
  const asyncTool = extractAsyncToolMetadata(options);
  if (isDetachedAsyncTool(asyncTool)) {
    return startAccountToolInSandboxBackground({
      accountId,
      tool,
      input,
      config,
      asyncTool,
      createExecutor,
    });
  }

  return runAccountToolInSandboxForeground({
    accountId,
    tool,
    input,
    config,
    asyncTool,
    createExecutor,
  });
}

async function runAccountToolInSandboxForeground({
  accountId,
  tool,
  input,
  config,
  asyncTool,
  createExecutor,
}: ExecuteAccountToolOptions & { asyncTool: unknown; createExecutor: typeof createSandboxExecutor }): Promise<unknown> {
  const bucket = requireEnv("TOOL_BUNDLES_BUCKET_NAME");
  const payload = await createRunnerPayload({
    bucket,
    tool,
    input,
    config,
    asyncTool,
  });

  const executor = createExecutor(customToolExecutorConfig());
  const result = await executor.run({
    runtime: "bash",
    code: nodeHeredoc(runnerCode(payload)),
    reservationKey: customToolReservationKey(accountId, tool.toolId),
    timeoutSeconds: FOREGROUND_TIMEOUT_SECONDS,
    outputLimitBytes: RUNNER_OUTPUT_LIMIT_BYTES,
  });

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
  return { type: "text", value: `Started async tool ${asyncTool.resultId}` };
}

async function createRunnerPayload(options: {
  bucket: string;
  tool: AccountToolRecord;
  input: unknown;
  config: AgentToolConfig;
  asyncTool: unknown;
  detachedCompletion?: RunnerPayload["detachedCompletion"];
}): Promise<RunnerPayload> {
  return {
    bundleUrl: await getS3ObjectUrl(options.bucket, options.tool.bundleStorageKey),
    expectedSha256: options.tool.sha256,
    toolName: options.tool.name,
    input: options.input,
    config: mergeToolConfig(options.tool.defaultConfig, options.config.config),
    asyncTool: options.asyncTool,
    ...(options.detachedCompletion ? { detachedCompletion: options.detachedCompletion } : {}),
  };
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
  // Warm pod path: if this sha is already cached, skip S3 entirely and import
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
  // repo only as runner code, but the call happens inside the Kubernetes pod.
  const result = await definition.execute(ctx, payload.input);
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
  const source = await downloadBundle(payload.bundleUrl);
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
  // createSandboxExecutor only creates a local client object. Pod lookup,
  // first-use creation, and idle resume happen inside executor.run/runBackground.
  return {
    provider: "kubernetes",
    persistent: true,
    // Uploaded tools return results via HTTP callback, never via durable disk, so
    // skip the home PVC: the pod still outlives the request for detached jobs, but
    // cold-start drops from ~22s to ~5s (no cloud-volume create+attach).
    ephemeralHome: true,
    internet: true,
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
