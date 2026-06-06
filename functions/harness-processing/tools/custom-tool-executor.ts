/**
 * Kubernetes-backed execution for account-uploaded tool bundles.
 * Harness resolves metadata; uploaded code is fetched and executed in the sandbox.
 * Keep bundle loading and user-code execution out of harness-processing.
 */

import { requireEnv } from "../../_shared/env.ts";
import { getS3ObjectUrl } from "../../_shared/s3.ts";
import type { AccountToolRecord, AgentToolConfig } from "../../_shared/storage/index.ts";
import { createSandboxExecutor } from "../sandbox/index.ts";

interface ExecuteAccountToolOptions {
  accountId: string;
  tool: AccountToolRecord;
  input: unknown;
  config: AgentToolConfig;
  options?: unknown;
  createExecutor?: typeof createSandboxExecutor;
}

const RESULT_MARKER = "__CUSTOM_TOOL_RESULT__";

export async function executeAccountToolInSandbox({
  accountId,
  tool,
  input,
  config,
  options,
  createExecutor = createSandboxExecutor,
}: ExecuteAccountToolOptions): Promise<unknown> {
  const bucket = requireEnv("TOOL_BUNDLES_BUCKET_NAME");
  const bundleUrl = await getS3ObjectUrl(bucket, tool.bundleStorageKey);
  const runtimeConfig = mergeToolConfig(tool.defaultConfig, config.config);
  const asyncTool = extractAsyncToolMetadata(options);
  // The sandbox executor currently accepts shell snippets. This heredoc starts a
  // short Node process inside the already-reserved pod; it is not executed in
  // harness-processing.
  const code = nodeHeredoc(runnerCode({
    bundleUrl,
    expectedSha256: tool.sha256,
    toolName: tool.name,
    input,
    config: runtimeConfig,
    asyncTool,
  }));

  // Kubernetes persistence is selected by two values together:
  //  - persistent=true: use the reserved Sandbox path in the executor.
  //  - reservationKey: stable account/tool identity that becomes the
  //    deterministic Sandbox name.
  const reservationKey = customToolReservationKey(accountId, tool.toolId);
  // createSandboxExecutor only creates a local client object; the pod lookup,
  // first-use creation, and idle resume happen inside executor.run().
  const executor = createExecutor({
    provider: "kubernetes",
    persistent: true,
    internet: true,
    timeout: 120,
    outputLimitBytes: 1024 * 1024,
    lifecycle: {
      idleTimeoutSeconds: 300,
      maxLifetimeSeconds: 3600,
    },
  });
  const result = await executor.run({
    runtime: "bash",
    code,
    reservationKey,
    timeoutSeconds: 120,
    outputLimitBytes: 1024 * 1024,
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

function runnerCode(payload: {
  bundleUrl: string;
  expectedSha256: string;
  toolName: string;
  input: unknown;
  config: Record<string, unknown>;
  asyncTool: unknown;
}): string {
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

main().catch((error) => {
  process.stdout.write("\\n" + marker + JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }) + "\\n");
  process.exitCode = 1;
});
`;
}

function nodeHeredoc(code: string): string {
  return `node <<'__CUSTOM_TOOL_RUNNER__'\n${code}\n__CUSTOM_TOOL_RUNNER__`;
}

function parseRunnerOutput(stdout: string): { ok: boolean; result?: unknown; error?: unknown } | null {
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

function customToolReservationKey(accountId: string, toolId: string): string {
  return `custom-tool-${accountId}-${toolId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
}
