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

import type { JSONSchema7 } from "ai";
import type { AgentConfig } from "../../shared/domain/agent-config.ts";
import type { SandboxPermissionMode } from "../../shared/domain/sandbox-config.ts";
import { isPlainObject } from "../../shared/object.ts";
import {
  isMissingS3Error,
  listS3Prefix,
  readS3Bytes,
  readS3Text,
  s3ObjectExists,
} from "../../shared/s3.ts";
import { getHarnessPublicUrl, requireEnv } from "../../shared/env.ts";
import {
  MEDIA_PATH_PREFIX,
  sealMediaTicket,
} from "../../shared/media-ticket.ts";
import type { SandboxRunMetadata } from "../../shared/sandbox-sizes.ts";
import { workspaceSandboxLimits } from "../../shared/sandbox.ts";
import type { ResolvedWorkspace } from "../../shared/workspaces.ts";
import type { AsyncToolDelivery } from "../async-tool-result.ts";
import { createSandboxExecutor } from "../sandbox/index.ts";
import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "../sandbox/s3-mount.ts";
import type {
  SandboxCpuSample,
  SandboxExecutorConfig,
  SandboxJobCallback,
  SandboxJobHandle,
  SandboxRunResult,
  SandboxRuntime,
} from "../sandbox/types.ts";
import { isFatalSandboxSetupError, toolError, toolText } from "./utils.ts";

export const DEFAULT_WORKSPACE_ROOT = "/mnt/workspaces";

// Writing here is a deliberate "this does not need to survive", so it is left alone.
// Everything else outside the workspace mount looks like work about to be lost.
const EPHEMERAL_WRITE_ROOTS = ["/tmp/", "/var/tmp/", "/dev/"];

// `..` as a whole path segment, in the literal text only (see outsideWorkspaceCommand
// for what that does not cover). The separator before it counts, so `a/../b` is caught
// as surely as `../b`; word characters do not, so `{1..10}` and `main..dev` are left alone.
const PARENT_TRAVERSAL = /(?:^|[\s"'=:{([<>,/])\.\.(?=[/\s;&|)"'\]}>,]|$)/;

// Absolute write targets, by construct: redirection, tee, dd, and the file-producing
// commands whose destination is an argument. `path` is the captured destination.
const ABSOLUTE_WRITE_PATTERNS = [
  /(?:^|[\s;&|()])\d*>>?\|?\s*(?<path>\/[^\s"'`;&|)<>]*)/g,
  /(?:^|[\s;&|()])tee\s+(?:-\S+\s+)*(?<path>\/[^\s"'`;&|)<>]*)/g,
  /(?:^|[\s;&|()])dd\s[^;&|]*\bof=(?<path>\/[^\s"'`;&|)<>]*)/g,
  /(?:^|[\s;&|()])(?:cp|mv|ln|install|rsync)\s[^;&|]*?\s(?<path>\/[^\s"'`;&|)<>]*)(?=\s*(?:$|[;&|]))/g,
  /(?:^|[\s;&|()])(?:mkdir|touch|rm|rmdir|truncate|unlink)\s+(?:-\S+\s+)*(?<path>\/[^\s"'`;&|)<>]*)/g,
  /(?:^|[\s;&|()])sed\s+[^;&|]*-i[^;&|]*?\s(?<path>\/[^\s"'`;&|)<>]*)/g,
  // Fetch and unpack: the destination is a flag argument, not a redirection.
  /(?:^|[\s;&|()])(?:curl|wget|tar|unzip)\s(?:[^;&|]*?\s)?-(?:o|O|C|d|-output|-directory|-output-document)[\s=]+(?<path>\/[^\s"'`;&|)<>]*)/g,
  // git clone's destination is its last positional argument.
  /(?:^|[\s;&|()])git\s+clone\s[^;&|]*?\s(?<path>\/[^\s"'`;&|)<>]*)(?=\s*(?:$|[;&|]))/g,
];

// What a bash call picked to run on. The two are orthogonal, not two spellings of
// one field: `workspace` names a mount, `sandbox` says "no mount, my own machine".
export interface BashTarget {
  workspace?: string;
  sandbox?: boolean;
}

// Per-tool runtime context. `workspaces` is the (registry-filtered) set this tool
// may operate on. `agentSandbox` is the agent's own sandbox (`config.sandbox`): it
// backs `bash` outright when no workspace is attached, and stays separately
// reachable when workspaces are — see hasStandaloneSandbox.
export interface SandboxToolContext {
  workspaces: ResolvedWorkspace[];
  // Present when the tool needs the account's model settings rather than the
  // workspace alone — `read` transcribes audio with them.
  agentConfig?: AgentConfig;
  agentSandbox?: SandboxExecutorConfig;
  agentSandboxPermissionMode?: SandboxPermissionMode;
  // Set when the parent session can track background jobs: bash exposes a
  // `background` flag for persistent workspaces and records each job as an
  // AsyncToolResult keyed by these ids so `async_status` can find it. `delivery`
  // carries the originating channel/WebSocket so a finished job is pushed back
  // there; absent => the result is only retrievable by polling.
  background?: {
    eventId: string;
    conversationKey: string;
    delivery?: AsyncToolDelivery;
  };
  // Reports each sandbox exec's CPU so the harness can attribute usage per
  // sandbox type. The agent's bash/fs tools always report role "agent".
  onSandboxCpu?: (sample: SandboxCpuSample) => void;
  sandboxMetadata?: SandboxRunMetadata;
}

export function workspaceRootFor(config: SandboxExecutorConfig): string {
  const options = isPlainObject(config.options) ? config.options : {};

  return typeof options.workspaceRoot === "string" &&
    options.workspaceRoot.trim()
    ? options.workspaceRoot.trim()
    : DEFAULT_WORKSPACE_ROOT;
}

// The reservation key a namespace-less run reconnects on, normally derived per
// agent by resolveAgentRuntime rather than written by the author.
function statelessReservationKeyFor(
  config: SandboxExecutorConfig,
): string | undefined {
  const options = isPlainObject(config.options) ? config.options : {};
  const reservationKey = options.reservationKey;

  return typeof reservationKey === "string" && reservationKey.trim()
    ? reservationKey.trim()
    : undefined;
}

/**
 * Whether the agent's own sandbox needs a way in of its own. It does not when there
 * are no workspaces (bash already runs there), nor when a workspace mounts that same
 * sandbox — the workspace IS the way in, and reaches the same machine with storage.
 */
export function hasStandaloneSandbox(
  workspaces: ResolvedWorkspace[],
  agentSandbox: SandboxExecutorConfig | undefined,
): boolean {
  if (!agentSandbox || workspaces.length === 0) {
    return false;
  }

  return !workspaces.some((workspace) =>
    isAgentOwnSandbox(workspace, agentSandbox),
  );
}

/**
 * Whether this workspace is mounted in the agent's OWN sandbox rather than
 * borrowing a different one. Identity is the sandbox record, so a workspace that
 * inherits the agent default and one that names it explicitly are the same case.
 */
export function isAgentOwnSandbox(
  workspace: ResolvedWorkspace,
  agentSandbox: SandboxExecutorConfig | undefined,
): boolean {
  const owned = agentSandbox?.controlPlane?.sandboxConfigId;

  return Boolean(
    owned && workspace.sandbox?.controlPlane?.sandboxConfigId === owned,
  );
}

export function sandboxSupportsBackgroundJobs(
  config: SandboxExecutorConfig | undefined,
): boolean {
  return config?.persistent === true;
}

export function sandboxSupportsJobControls(
  config: SandboxExecutorConfig | undefined,
): boolean {
  return sandboxSupportsBackgroundJobs(config) && config?.provider !== "e2b";
}

/**
 * Resolve the workspace a call targets. Returns undefined when no workspace is
 * configured (stateless / ephemeral run). The first workspace is the default.
 * Throws when a requested workspace name is unknown.
 */
export function resolveWorkspace(
  workspaces: ResolvedWorkspace[],
  requested?: string,
): ResolvedWorkspace | undefined {
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

export function workspaceParamSchema(
  workspaces: ResolvedWorkspace[],
): JSONSchema7 | undefined {
  // Only expose the selector when there is a genuine choice.
  if (workspaces.length <= 1) {
    return undefined;
  }

  return {
    type: "string" as const,
    enum: workspaces.map((w) => w.name),
    description:
      "Named workspace to operate in. Omit to use the default workspace.",
  };
}

export function sandboxRunMetadata(
  context: SandboxToolContext,
  workspace?: ResolvedWorkspace,
): SandboxRunMetadata | undefined {
  if (!context.sandboxMetadata) {
    return undefined;
  }

  return {
    ...context.sandboxMetadata,
    ...(workspace
      ? { workspaceName: workspace.name, workspaceId: workspace.workspaceId }
      : {}),
  };
}

export async function runSandbox(
  config: SandboxExecutorConfig,
  namespace: string | undefined,
  code: string,
  options?: {
    onSandboxCpu?: (sample: SandboxCpuSample) => void;
    metadata?: SandboxRunMetadata;
  },
): Promise<SandboxRunResult> {
  const executor = createSandboxExecutor(config);
  const limits = workspaceSandboxLimits(config.provider);
  const reservationKey =
    !namespace && config.persistent === true
      ? statelessReservationKeyFor(config)
      : undefined;
  const result = await executor.run({
    code: code,
    ...(namespace
      ? { namespace: namespace, workspaceRoot: workspaceRootFor(config) }
      : {}),
    ...(reservationKey
      ? {
          reservationKey: reservationKey,
          workspaceRoot: workspaceRootFor(config),
        }
      : {}),
    ...(options?.metadata ? { metadata: options.metadata } : {}),
    timeoutSeconds: boundedInteger(
      config.timeout,
      limits.defaultTimeoutSeconds,
      limits.maxTimeoutSeconds,
    ),
    outputLimitBytes: boundedInteger(
      config.outputLimitBytes,
      limits.defaultOutputLimitBytes,
      limits.maxOutputLimitBytes,
    ),
  });
  if (result.cpuUsec !== undefined && result.cpuUsec > 0) {
    options?.onSandboxCpu?.({
      type: result.provider,
      role: "agent",
      cpuUsec: result.cpuUsec,
    });
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
  options: {
    jobId: string;
    callback?: SandboxJobCallback;
    metadata?: SandboxRunMetadata;
  },
): Promise<SandboxJobHandle> {
  const executor = createSandboxExecutor(config);
  if (!executor.runBackground) {
    throw new Error("this sandbox provider does not support background jobs");
  }
  const limits = workspaceSandboxLimits(config.provider);

  return executor.runBackground({
    code: code,
    namespace: namespace,
    jobId: options.jobId,
    ...(options.callback ? { callback: options.callback } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
    workspaceRoot: workspaceRootFor(config),
    timeoutSeconds: boundedInteger(
      config.timeout,
      limits.defaultTimeoutSeconds,
      limits.maxTimeoutSeconds,
    ),
    outputLimitBytes: boundedInteger(
      config.outputLimitBytes,
      limits.defaultOutputLimitBytes,
      limits.maxOutputLimitBytes,
    ),
  });
}

// Approval policy is evaluated per call so workspaces with different
// sandboxes/permissionModes resolve independently:
//   - read/glob/grep: always auto (handled by omitting needsApproval).
//   - write/edit: auto in edit/bypass, ASK in ask.
//   - bash: ASK in ask + edit, auto only in bypass.
export function editNeedsApproval(
  workspaces: ResolvedWorkspace[],
  requested?: string,
): boolean {
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

export function bashNeedsApproval(
  context: SandboxToolContext,
  selection: BashTarget = {},
): boolean {
  try {
    if (!targetsAgentSandbox(context, selection)) {
      const workspace = resolveWorkspace(
        context.workspaces,
        selection.workspace,
      );
      // Read-only workspace (no sandbox): nothing to approve. Skip the gate so the
      // call falls through to the tool's clean "no sandbox available" rejection.
      if (workspace && !workspace.sandbox) {
        return false;
      }

      return permissionModeFor(workspace) !== "bypass";
    }

    return (context.agentSandboxPermissionMode ?? "ask") !== "bypass";
  } catch {
    return true;
  }
}

/**
 * Whether this call runs on the agent's own sandbox with no workspace mounted:
 * either the agent has no workspaces at all, or it asked for the sandbox and one
 * is standalone. `sandbox` wins over `workspace`; the two never both apply.
 */
export function targetsAgentSandbox(
  context: SandboxToolContext,
  selection: BashTarget = {},
): boolean {
  if (context.workspaces.length === 0) {
    return true;
  }

  return (
    selection.sandbox === true &&
    hasStandaloneSandbox(context.workspaces, context.agentSandbox)
  );
}

function permissionModeFor(
  workspace: ResolvedWorkspace | undefined,
): SandboxPermissionMode {
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
): Promise<string> {
  const target = await resolveS3ReadTarget(
    workspaceReadContext(ws.config.storage, ws.namespace),
  );
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
  const count =
    typeof limit === "number" && limit > 0 ? limit : READ_DEFAULT_LIMIT;
  const selected = lines.slice(start - 1, start - 1 + count);
  const numbered = selected
    .map((line, index) => `${String(start + index).padStart(6, " ")}\t${line}`)
    .join("\n");

  return toolText(numbered.length > 0 ? `${numbered}\n` : "");
}

export async function s3Glob(
  ws: ResolvedWorkspace,
  pattern: string,
  path?: string,
): Promise<string> {
  const target = await resolveS3ReadTarget(
    workspaceReadContext(ws.config.storage, ws.namespace),
  );
  const rootRel = path ? toWorkspaceRelative(path) : ".";
  const searchPrefix =
    rootRel === "." ? target.prefix : `${target.prefix}${rootRel}/`;

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
    .map((object) => ({
      rel: object.key.slice(searchPrefix.length),
      lastModified: object.lastModified,
    }))
    .filter(
      (entry) =>
        entry.rel.length > 0 &&
        !entry.rel.endsWith("/") &&
        matcher.match(entry.rel),
    )
    .sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""))
    .map((entry) => entry.rel);

  return toolText(
    matches.length > 0 ? `${matches.join("\n")}\n` : "No files found\n",
  );
}

// A workspace file as a URL an outside service can fetch, for the chat providers
// that pull media themselves instead of taking an upload. A presigned S3 link
// cannot be used: Zalo stores the URL and re-fetches it whenever a viewer opens
// the picture, so any expiry turns into a broken image in chat history. The
// sealed ticket points at the file for as long as the file exists.
export async function workspaceMediaUrl(
  ws: ResolvedWorkspace,
  rel: string,
  accountId: string,
): Promise<string> {
  const baseUrl = getHarnessPublicUrl();
  if (!baseUrl) {
    return toolError(
      "Error: sending a workspace file needs PUBLIC_BASE_URL configured",
    );
  }
  const target = await resolveS3ReadTarget(
    workspaceReadContext(ws.config.storage, ws.namespace),
  );
  const key = `${target.prefix}${rel}`;
  const exists = target.access
    ? await s3ObjectExists(target.bucket, key, target.access)
    : await s3ObjectExists(target.bucket, key);
  if (!exists) {
    return toolError(`Error: file not found: ${rel}`);
  }
  const token = sealMediaTicket(
    {
      accountId: accountId,
      workspaceId: ws.workspaceId,
      namespace: ws.namespace,
      path: rel,
    },
    requireEnv("SERVICE_AUTH_SECRET"),
  );

  return `${baseUrl}${MEDIA_PATH_PREFIX}${token}`;
}

// The same workspace file as bytes, for the providers that upload instead of
// fetching. Slack and Discord ignore an outbound URL entirely — both take a
// multipart upload and nothing else — so the media link the other channels are
// handed is worthless to them and the object has to be read here. Reading S3
// directly rather than fetching our own /media route keeps it to one hop and
// off the 25 MB the public route caps at.
export async function workspaceMediaBytes(
  ws: ResolvedWorkspace,
  rel: string,
): Promise<Uint8Array> {
  const target = await resolveS3ReadTarget(
    workspaceReadContext(ws.config.storage, ws.namespace),
  );
  const key = `${target.prefix}${rel}`;

  return target.access
    ? await readS3Bytes(target.bucket, key, target.access)
    : await readS3Bytes(target.bucket, key);
}

export function formatRunText(result: SandboxRunResult): string {
  if (!result.ok) {
    const error =
      `${result.stderr}${result.stdout}`.trim() || "sandbox command failed";
    if (isFatalSandboxSetupError(error)) {
      throw new Error(error);
    }
  }

  return `${result.stdout}${result.stderr}`;
}

function runtimeList(config: SandboxExecutorConfig): SandboxRuntime[] {
  return config.runtimes && config.runtimes.length > 0
    ? config.runtimes
    : ["bash", "python", "node"];
}

export function runtimeDescription(
  config: SandboxExecutorConfig | undefined,
): string {
  const runtimes = config ? runtimeList(config) : ["bash", "python", "node"];

  return `Allowed runtimes: ${runtimes.join(", ")}.`;
}

export function disallowedRuntimeCommand(
  config: SandboxExecutorConfig,
  command: string,
): string | undefined {
  const runtimes = new Set(runtimeList(config));
  if (!runtimes.has("bash")) {
    return "Error: this sandbox does not allow bash commands";
  }
  if (
    !runtimes.has("python") &&
    invokesCommand(command, ["python", "python3"])
  ) {
    return "Error: this sandbox does not allow python commands";
  }
  if (
    !runtimes.has("node") &&
    invokesCommand(command, ["node", "npm", "npx"])
  ) {
    return "Error: this sandbox does not allow node commands";
  }

  return undefined;
}

// The workspace mount is the only storage that outlives the sandbox; the rest of the
// filesystem dies with the VM, or with the reservation when there is one. So writes
// are what this guard is about — reading a sandbox's own system files risks nothing
// and is often how a task gets done.
export function outsideWorkspaceCommand(
  command: string,
  options: { persistentOwnSandbox?: boolean } = {},
): string | undefined {
  const scanned = unescapeShellChars(stripHereDocBodies(command));
  // Traversal is a containment concern, not a durability one: read/write/edit reject
  // `..`, and bash should not be the trivial way around them. This only sees the
  // literal text — bash expands `$'\x2e\x2e'`, `$(printf ..)` and variables after
  // this runs, so it is a guardrail, not a boundary. The boundary is the VM plus the
  // prefix-scoped mount credentials, which no amount of traversal escapes.
  if (PARENT_TRAVERSAL.test(scanned)) {
    return "Error: parent directory traversal is not allowed";
  }
  // A reserved sandbox the agent owns keeps its whole filesystem between calls, so
  // writing outside the mount there loses nothing until the reservation ends.
  if (options.persistentOwnSandbox === true) {
    return undefined;
  }

  const target = absoluteWriteTarget(scanned);
  if (target) {
    return (
      `Error: ${target} is outside the workspace, so anything written there is lost when the sandbox stops. ` +
      `Write to a workspace-relative path instead (e.g. ${workspaceRelativeSuggestion(target)}), ` +
      `or use /tmp when the file is genuinely throwaway.`
    );
  }

  return undefined;
}

/**
 * Whether the write guard steps aside for this workspace. One predicate for both
 * callers on purpose: the bash description promises exactly what the guard enforces,
 * and two copies of this condition would drift into the tool lying to the model.
 */
export function writesOutsideAllowed(
  workspace: ResolvedWorkspace,
  agentSandbox: SandboxExecutorConfig | undefined,
): boolean {
  return (
    workspace.sandbox?.persistent === true &&
    isAgentOwnSandbox(workspace, agentSandbox)
  );
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
  const parts = trimmed
    .replace(/^\/+/, "")
    .split("/")
    .filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === "..")) {
    throw new Error("Invalid path: directory traversal not allowed");
  }

  return parts.length === 0 ? "." : parts.join("/");
}

export function toBase64(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64");
}

export function boundedInteger(
  value: unknown,
  defaultValue: number,
  max: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new Error(
      `sandbox numeric option must be an integer from 1 to ${max}`,
    );
  }

  return value;
}

// The first absolute path the command would write to, ignoring roots that are
// ephemeral by convention. Shell semantics are not parseable with a regex, so this
// covers the constructs that actually lose an agent's work — redirections and the
// common file-producing commands. Three classes are knowingly out of reach and are
// left to the durability rule in the bash tool description: interpreter writes
// (`python -c "open(...)"`), a write through a symlink, and the open-ended tail of
// package-manager install prefixes. Adding one of those is not a bug fix.
function absoluteWriteTarget(command: string): string | undefined {
  for (const pattern of ABSOLUTE_WRITE_PATTERNS) {
    for (const match of command.matchAll(pattern)) {
      const path = match.groups?.path?.trim();
      if (path && !isEphemeralPath(path)) {
        return path;
      }
    }
  }

  return undefined;
}

function isEphemeralPath(path: string): boolean {
  return EPHEMERAL_WRITE_ROOTS.some(
    (root) => path === root.slice(0, -1) || path.startsWith(root),
  );
}

// Name a concrete relative path in the error so the retry is obvious rather than
// something the model has to invent.
function workspaceRelativeSuggestion(target: string): string {
  const basename = target.split("/").filter(Boolean).pop();

  return basename ? `./${basename}` : "./output";
}

function invokesCommand(command: string, names: string[]): boolean {
  const escaped = names
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  return new RegExp(`(^|[\\s;&|()])(${escaped})(\\s|$)`).test(command);
}

// Bash reads `\.\./x` as `../x`, so the escapes have to come off before anything is
// matched — otherwise the two dots are never adjacent and no pattern can see them.
function unescapeShellChars(command: string): string {
  return command.replace(/\\(.)/g, "$1");
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
