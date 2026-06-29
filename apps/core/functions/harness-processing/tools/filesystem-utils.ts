/**
 * Shared helpers for the sandbox tool set
 * (bash/read/write/edit/glob/grep). Keep run plumbing, workspace selection,
 * path normalization, quoting, approval policy, and result formatting here.
 *
 * Each workspace carries its own effective sandbox (see ResolvedWorkspace): a
 * sandbox-backed workspace compiles tools to a bash `code` string run through
 * its provider; a sandbox-less workspace is read-only and served directly from
 * S3 (read/glob only — no mount, no Lambda cold start).
 */

import type { JSONObject } from "@ai-sdk/provider";
import type { Tool } from "ai";
import { isPlainObject } from "../../_shared/object.ts";
import { workspaceSandboxLimits } from "../../_shared/sandbox.ts";
import { isMissingS3Error, listS3Prefix, readS3Text } from "../../_shared/s3.ts";
import { resolveS3ReadTarget, workspaceReadContext } from "../sandbox/s3-mount.ts";
import { createSandboxExecutor } from "../sandbox/index.ts";
import type { SandboxCpuSample, SandboxExecutorConfig, SandboxJobCallback, SandboxJobHandle, SandboxRunResult, SandboxRuntime } from "../sandbox/types.ts";
import type { ResolvedWorkspace } from "../../_shared/workspaces.ts";
import type { SandboxPermissionMode } from "../../_shared/storage/index.ts";
import type { AsyncToolDelivery } from "../async-tool-result.ts";

export const DEFAULT_WORKSPACE_ROOT = "/mnt/workspaces";

// Model-facing tool result shape (matches the AI SDK toModelOutput contract).
export type ToolModelResult = Awaited<ReturnType<NonNullable<Tool<Record<string, unknown>, unknown>["toModelOutput"]>>>;
export const toolText = (value: string): ToolModelResult => ({ type: "text", value });
export const toolError = (value: string): ToolModelResult => ({ type: "error-text", value });
export const toolJson = (value: JSONObject): ToolModelResult => ({ type: "json", value });

// Per-tool runtime context. `workspaces` is the (registry-filtered) set this tool
// may operate on. `statelessSandbox` is only set for `bash` when there are no
// workspaces, so it runs ephemerally on the agent-level sandbox.
export interface SandboxToolContext {
  workspaces: ResolvedWorkspace[];
  statelessSandbox?: SandboxExecutorConfig;
  statelessPermissionMode?: SandboxPermissionMode;
  // Set when the parent session can track background jobs: bash exposes a
  // `background` flag for persistent workspaces and records each job as an
  // AsyncToolResult keyed by these ids so `async_status` can find it. `delivery`
  // carries the originating channel/WebSocket so a finished job is pushed back
  // there; absent => the result is only retrievable by polling.
  background?: { eventId: string; conversationKey: string; delivery?: AsyncToolDelivery };
  // Reports each sandbox exec's CPU so the harness can attribute usage per
  // sandbox type. The agent's bash/fs tools always report role "agent".
  onSandboxCpu?: (sample: SandboxCpuSample) => void;
}

export function workspaceRootFor(config: SandboxExecutorConfig): string {
  const options = isPlainObject(config.options) ? config.options : {};
  return typeof options.workspaceRoot === "string" && options.workspaceRoot.trim()
    ? options.workspaceRoot.trim()
    : DEFAULT_WORKSPACE_ROOT;
}

function statelessReservationKeyFor(config: SandboxExecutorConfig): string | undefined {
  const options = isPlainObject(config.options) ? config.options : {};
  const reservationKey = options.reservationKey;

  return typeof reservationKey === "string" && reservationKey.trim() ? reservationKey.trim() : undefined;
}

export function sandboxSupportsBackgroundJobs(config: SandboxExecutorConfig | undefined): boolean {
  return config?.persistent === true;
}

export function sandboxSupportsJobControls(config: SandboxExecutorConfig | undefined): boolean {
  return sandboxSupportsBackgroundJobs(config) && config?.provider !== "e2b";
}

/**
 * Resolve the workspace a call targets. Returns undefined when no workspace is
 * configured (stateless / ephemeral run). The first workspace is the default.
 * Throws when a requested workspace name is unknown.
 */
export function resolveWorkspace(workspaces: ResolvedWorkspace[], requested?: string): ResolvedWorkspace | undefined {
  if (workspaces.length === 0) {
    return undefined;
  }
  if (!requested) {
    return workspaces[0]!;
  }
  const workspace = workspaces.find((w) => w.name === requested);
  if (!workspace) {
    throw new Error(`unknown workspace ${requested}`);
  }
  return workspace;
}

export function workspaceParamSchema(workspaces: ResolvedWorkspace[]) {
  // Only expose the selector when there is a genuine choice.
  if (workspaces.length <= 1) {
    return undefined;
  }
  return {
    type: "string" as const,
    enum: workspaces.map((w) => w.name),
    description: "Named workspace to operate in. Omit to use the default workspace.",
  };
}

export async function runSandbox(
  config: SandboxExecutorConfig,
  namespace: string | undefined,
  code: string,
  options?: { onSandboxCpu?: (sample: SandboxCpuSample) => void },
): Promise<SandboxRunResult> {
  const executor = createSandboxExecutor(config);
  const limits = workspaceSandboxLimits(config.provider);
  const reservationKey = !namespace && config.persistent === true ? statelessReservationKeyFor(config) : undefined;
  const result = await executor.run({
    code,
    ...(namespace ? { namespace, workspaceRoot: workspaceRootFor(config) } : {}),
    ...(reservationKey ? { reservationKey, workspaceRoot: workspaceRootFor(config) } : {}),
    timeoutSeconds: boundedInteger(config.timeout, limits.defaultTimeoutSeconds, limits.maxTimeoutSeconds),
    outputLimitBytes: boundedInteger(config.outputLimitBytes, limits.defaultOutputLimitBytes, limits.maxOutputLimitBytes),
  });
  if (result.cpuUsec !== undefined && result.cpuUsec > 0) {
    options?.onSandboxCpu?.({ type: result.provider, role: "agent", cpuUsec: result.cpuUsec });
  }
  return result;
}

/**
 * Launch a detached background job in a persistent sandbox and return its handle.
 * The work runs inside the sandbox (not the harness), so it survives the request.
 * The caller supplies the jobId (so the tracking row exists before the job can
 * finish) and an optional completion callback the job POSTs when it exits.
 */
export async function runSandboxBackground(
  config: SandboxExecutorConfig,
  namespace: string,
  code: string,
  options: { jobId: string; callback?: SandboxJobCallback },
): Promise<SandboxJobHandle> {
  const executor = createSandboxExecutor(config);
  if (!executor.runBackground) {
    throw new Error("this sandbox provider does not support background jobs");
  }
  const limits = workspaceSandboxLimits(config.provider);
  return executor.runBackground({
    code,
    namespace,
    jobId: options.jobId,
    ...(options.callback ? { callback: options.callback } : {}),
    workspaceRoot: workspaceRootFor(config),
    timeoutSeconds: boundedInteger(config.timeout, limits.defaultTimeoutSeconds, limits.maxTimeoutSeconds),
    outputLimitBytes: boundedInteger(config.outputLimitBytes, limits.defaultOutputLimitBytes, limits.maxOutputLimitBytes),
  });
}

// Approval policy is evaluated per call so workspaces with different
// sandboxes/permissionModes resolve independently:
//   - read/glob/grep: always auto (handled by omitting needsApproval).
//   - write/edit: auto in edit/bypass, ASK in ask.
//   - bash: ASK in ask + edit, auto only in bypass.
export function editNeedsApproval(workspaces: ResolvedWorkspace[], requested?: string): boolean {
  try {
    const workspace = resolveWorkspace(workspaces, requested);
    // Read-only workspace (no sandbox): nothing to approve. Skip the gate so the
    // call falls through to the tool's clean "workspace is read-only" rejection
    // instead of prompting for an approval it can never satisfy.
    if (workspace && !workspace.sandbox) {
      return false;
    }
    return permissionModeFor(workspace) === "ask";
  } catch {
    return true;
  }
}

export function bashNeedsApproval(context: SandboxToolContext, requested?: string): boolean {
  try {
    if (context.workspaces.length > 0) {
      const workspace = resolveWorkspace(context.workspaces, requested);
      // Read-only workspace (no sandbox): nothing to approve. Skip the gate so the
      // call falls through to the tool's clean "no sandbox available" rejection.
      if (workspace && !workspace.sandbox) {
        return false;
      }
      return permissionModeFor(workspace) !== "bypass";
    }
    return (context.statelessPermissionMode ?? "ask") !== "bypass";
  } catch {
    return true;
  }
}

function permissionModeFor(workspace: ResolvedWorkspace | undefined): SandboxPermissionMode {
  return workspace?.sandbox?.permissionMode ?? "ask";
}

// S3-direct read-only path (workspaces with no sandbox). Reads/lists straight from
// the workspace's storage bucket under the same prefix the mount uses, so it sees
// exactly what a sandbox-backed run would. A bring-your-own bucket resolves its own
// bucket/prefix and short-lived assume-role credentials; the managed bucket reads on
// the harness's own role (no per-read STS) under `<namespace>/`.
const READ_DEFAULT_LIMIT = 2000;

export async function s3ReadNumbered(
  ws: ResolvedWorkspace,
  rel: string,
  offset?: number,
  limit?: number,
): Promise<ToolModelResult> {
  const target = await resolveS3ReadTarget(workspaceReadContext(ws.config.storage, ws.namespace));
  const key = `${target.prefix}${rel}`;
  let text: string;
  try {
    text = target.access
      ? await readS3Text(target.bucket, key, target.access)
      : await readS3Text(target.bucket, key);
  } catch (cause) {
    if (isMissingS3Error(cause)) {
      return toolError(`Error: file not found: ${rel}`);
    }
    return toolError(cause instanceof Error ? cause.message : String(cause));
  }

  const lines = text.split("\n");
  if (text.endsWith("\n")) {
    lines.pop();
  }
  const start = typeof offset === "number" && offset > 0 ? offset : 1;
  const count = typeof limit === "number" && limit > 0 ? limit : READ_DEFAULT_LIMIT;
  const selected = lines.slice(start - 1, start - 1 + count);
  const numbered = selected
    .map((line, index) => `${String(start + index).padStart(6, " ")}\t${line}`)
    .join("\n");
  return toolText(numbered.length > 0 ? `${numbered}\n` : "");
}

export async function s3Glob(ws: ResolvedWorkspace, pattern: string, path?: string): Promise<ToolModelResult> {
  const target = await resolveS3ReadTarget(workspaceReadContext(ws.config.storage, ws.namespace));
  const rootRel = path ? toWorkspaceRelative(path) : ".";
  const searchPrefix = rootRel === "." ? target.prefix : `${target.prefix}${rootRel}/`;

  let objects: Awaited<ReturnType<typeof listS3Prefix>>;
  try {
    objects = target.access
      ? await listS3Prefix(target.bucket, searchPrefix, target.access)
      : await listS3Prefix(target.bucket, searchPrefix);
  } catch (cause) {
    return toolError(cause instanceof Error ? cause.message : String(cause));
  }

  const matcher = new Bun.Glob(pattern);
  const matches = objects
    .map((object) => ({ rel: object.key.slice(searchPrefix.length), lastModified: object.lastModified }))
    .filter((entry) => entry.rel.length > 0 && !entry.rel.endsWith("/") && matcher.match(entry.rel))
    .sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""))
    .map((entry) => entry.rel);

  return toolText(matches.length > 0 ? `${matches.join("\n")}\n` : "No files found\n");
}

export function formatRunText(result: SandboxRunResult): string {
  return `${result.stdout}${result.stderr}`;
}

export function formatRunJson(result: SandboxRunResult): JSONObject {
  return {
    output: {
      stdout: result.stdout,
      stderr: result.stderr,
    },
    status: {
      ok: result.ok,
      runtime: result.runtime,
      provider: result.provider,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut === true,
      truncated: result.truncated === true,
    },
  };
}

export function runtimeList(config: SandboxExecutorConfig): SandboxRuntime[] {
  return config.runtimes && config.runtimes.length > 0 ? config.runtimes : ["bash", "python", "node"];
}

export function runtimeDescription(config: SandboxExecutorConfig | undefined): string {
  const runtimes = config ? runtimeList(config) : ["bash", "python", "node"];
  return `Allowed runtimes: ${runtimes.join(", ")}.`;
}

export function disallowedRuntimeCommand(config: SandboxExecutorConfig, command: string): string | undefined {
  const runtimes = new Set(runtimeList(config));
  if (!runtimes.has("bash")) {
    return "Error: this sandbox does not allow bash commands";
  }
  if (!runtimes.has("python") && invokesCommand(command, ["python", "python3"])) {
    return "Error: this sandbox does not allow python commands";
  }
  if (!runtimes.has("node") && invokesCommand(command, ["node", "npm", "npx"])) {
    return "Error: this sandbox does not allow node commands";
  }
  return undefined;
}

export function outsideWorkspaceCommand(command: string): string | undefined {
  const scanned = stripHereDocBodies(command);
  if (/(^|[\s;&|()])cd\s+(?:--\s+)?(?:\.\.(?:[\/\s;&|)]|$)|\/(?!dev\/null(?:\s|$)))/.test(scanned)) {
    return "Error: bash commands must stay in the workspace directory";
  }
  if (/(^|[\s;&|()])(?:pushd|popd)\b/.test(scanned)) {
    return "Error: bash commands must stay in the workspace directory";
  }
  if (/(^|[\s;&|()])(?:find|du|tree)\s+\/(?:\s|$)/.test(scanned)) {
    return "Error: bash commands must stay in the workspace directory";
  }
  if (/(^|[\s"'=:{([<>,])\.\.(?:[\/\s;&|)]|$)/.test(scanned)) {
    return "Error: parent directory traversal is not allowed";
  }

  // A leading `:` still flags `host:/abs/path`, but a `:` followed by `//` is a
  // URL scheme separator (https://...), not an absolute path, so it is exempt.
  const absolutePath = scanned.match(/(?:^|[\s"'={([<>,]|:(?!\/\/))\/(?!dev\/null(?:\s|$)|[>\s]|$)[^\s"'`;&|)]*/);
  if (absolutePath) {
    return `Error: absolute paths are not allowed in workspace bash commands: ${absolutePath[0].trim()}`;
  }
  return undefined;
}

/**
 * Normalize a model-supplied path to a workspace-relative path. The sandbox run
 * is rooted at the workspace directory, so a leading `/` means "workspace root",
 * not the container root. Directory traversal is rejected.
 */
export function toWorkspaceRelative(path: string): string {
  const trimmed = (path ?? "").trim();
  if (!trimmed || trimmed === "." || trimmed === "/") {
    return ".";
  }
  const parts = trimmed.replace(/^\/+/, "").split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === "..")) {
    throw new Error("Invalid path: directory traversal not allowed");
  }
  return parts.length === 0 ? "." : parts.join("/");
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function toBase64(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64");
}

export function boundedInteger(value: unknown, defaultValue: number, max: number): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`sandbox numeric option must be an integer from 1 to ${max}`);
  }
  return value;
}

function invokesCommand(command: string, names: string[]): boolean {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(^|[\\s;&|()])(${escaped})(\\s|$)`).test(command);
}

function stripHereDocBodies(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let marker: string | undefined;
  for (const line of lines) {
    if (marker) {
      if (line.trim() === marker) {
        marker = undefined;
      }
      continue;
    }
    kept.push(line);
    const match = line.match(/<<-?\s*["']?([A-Za-z_][A-Za-z0-9_-]*)["']?/);
    if (match) {
      marker = match[1];
    }
  }
  return kept.join("\n");
}
