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
import { getHarnessPublicUrl, requireSecretsEnv } from "../../shared/env.ts";
import { isTimeoutError, toErrorMessage } from "../../shared/errors.ts";
import { logWarn } from "../../shared/log.ts";
import {
  MEDIA_PATH_PREFIX,
  sealMediaTicket,
} from "../../shared/media-ticket.ts";
import {
  resolveSandboxSpecs,
  type SandboxRunMetadata,
} from "../../shared/sandbox-sizes.ts";
import { workspaceSandboxLimits } from "../../shared/sandbox.ts";
import type {
  ResolvedAgentSandbox,
  ResolvedWorkspace,
} from "../../shared/workspaces.ts";
import type { AsyncToolDelivery } from "../async-tool-result.ts";
import { createSandboxExecutor } from "../sandbox/index.ts";
import { isMachineConnected } from "../sandbox/machine-executor.ts";
import { configString, SandboxCapacityError } from "../sandbox/utils.ts";
import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "../sandbox/s3-mount.ts";
import type {
  SandboxCpuSample,
  SandboxExecutorConfig,
  SandboxJobCallback,
  SandboxJobHandle,
  SandboxRunPrincipal,
  SandboxRunResult,
  SandboxRuntime,
} from "../sandbox/types.ts";
import { isFatalSandboxSetupError, toolError, toolText } from "./utils.ts";

export const DEFAULT_WORKSPACE_ROOT = "/mnt/workspaces";

const EPHEMERAL_WRITE_ROOTS = ["/tmp/", "/var/tmp/", "/dev/"];

// `..` as a whole segment: `a/../b` matches, `{1..10}` and `main..dev` do not.
const PARENT_TRAVERSAL = /(?:^|[\s"'=:{([<>,/])\.\.(?=[/\s;&|)"'\]}>,]|$)/;

const ABSOLUTE_WRITE_PATTERNS = [
  /(?:^|[\s;&|()])\d*>>?\|?\s*(?<path>\/[^\s"'`;&|)<>]*)/g,
  /(?:^|[\s;&|()])tee\s+(?:-\S+\s+)*(?<path>\/[^\s"'`;&|)<>]*)/g,
  /(?:^|[\s;&|()])dd\s[^;&|]*\bof=(?<path>\/[^\s"'`;&|)<>]*)/g,
  /(?:^|[\s;&|()])(?:cp|mv|ln|install|rsync)\s[^;&|]*?\s(?<path>\/[^\s"'`;&|)<>]*)(?=\s*(?:$|[;&|]))/g,
  /(?:^|[\s;&|()])(?:mkdir|touch|rm|rmdir|truncate|unlink)\s+(?:-\S+\s+)*(?<path>\/[^\s"'`;&|)<>]*)/g,
  /(?:^|[\s;&|()])sed\s+[^;&|]*-i[^;&|]*?\s(?<path>\/[^\s"'`;&|)<>]*)/g,
  /(?:^|[\s;&|()])(?:curl|wget|tar|unzip)\s(?:[^;&|]*?\s)?-(?:o|O|C|d|-output|-directory|-output-document)[\s=]+(?<path>\/[^\s"'`;&|)<>]*)/g,
  /(?:^|[\s;&|()])git\s+clone\s[^;&|]*?\s(?<path>\/[^\s"'`;&|)<>]*)(?=\s*(?:$|[;&|]))/g,
];

export interface BashTarget {
  workspace?: string;
  sandbox?: string;
}

export interface SandboxToolContext {
  workspaces: ResolvedWorkspace[];
  agentConfig?: AgentConfig;
  // Resolved config.sandboxes; the first is the default.
  sandboxes?: ResolvedAgentSandbox[];
  background?: {
    eventId: string;
    conversationKey: string;
    delivery?: AsyncToolDelivery;
    onDetachedResult?: (resultId: string) => void;
  };
  onSandboxCpu?: (sample: SandboxCpuSample) => void;
  sandboxMetadata?: SandboxRunMetadata;
  // Blocking bash only, minted when a command runs: file tools and background jobs get none.
  principal?: () => SandboxRunPrincipal | undefined;
}

export function workspaceRootFor(config: SandboxExecutorConfig): string {
  const options = isPlainObject(config.options) ? config.options : {};

  return typeof options.workspaceRoot === "string" &&
    options.workspaceRoot.trim()
    ? options.workspaceRoot.trim()
    : DEFAULT_WORKSPACE_ROOT;
}

export function sandboxTimeoutSeconds(
  config: SandboxExecutorConfig,
  defaultSeconds?: number,
): number {
  const limits = workspaceSandboxLimits(config.provider);

  return boundedInteger(
    config.timeout,
    Math.min(
      defaultSeconds ?? limits.defaultTimeoutSeconds,
      limits.maxTimeoutSeconds,
    ),
    limits.maxTimeoutSeconds,
  );
}

export function agentOwnWorkspace(
  context: SandboxToolContext,
): ResolvedWorkspace | undefined {
  return context.workspaces.find((workspace): boolean =>
    isAgentOwnSandbox(workspace, context),
  );
}

export function hasStandaloneSandbox(context: SandboxToolContext): boolean {
  return Boolean(context.sandboxes?.[0]) && !agentOwnWorkspace(context);
}

// By sandbox record, so inheriting the agent default and naming it explicitly match alike.
export function isAgentOwnSandbox(
  workspace: ResolvedWorkspace,
  context: SandboxToolContext,
): boolean {
  const owned = context.sandboxes?.[0]?.sandbox.controlPlane?.sandboxConfigId;

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

export function resolveAgentSandbox(
  context: SandboxToolContext,
  requested?: string,
): ResolvedAgentSandbox | undefined {
  if (requested === undefined) {
    return context.sandboxes?.[0];
  }
  const entry = selectableSandboxes(context).find(
    (candidate): boolean => candidate.name === requested,
  );
  if (entry) {
    return entry;
  }
  const mountedBy =
    context.sandboxes?.[0]?.name === requested
      ? agentOwnWorkspace(context)
      : undefined;
  if (mountedBy) {
    throw new Error(
      `sandbox "${requested}" is mounted by workspace "${mountedBy.name}"; pass workspace "${mountedBy.name}" instead`,
    );
  }

  throw new Error(`unknown sandbox ${requested}`);
}

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
    principal?: SandboxRunPrincipal;
  },
): Promise<SandboxRunResult> {
  let result: SandboxRunResult;
  try {
    result = await runSandboxOn(config, namespace, code, options);
  } catch (error) {
    // The primary's options and snapshot do not fit the fallback: it runs on the platform's
    // defaults and credentials, and bills the specs the fallback provider creates.
    const {
      fallbackProvider,
      options: _options,
      snapshot: _snapshot,
      controlPlane,
      ...primary
    } = config;
    if (!fallbackProvider || !(error instanceof SandboxCapacityError)) {
      throw error;
    }
    logWarn("Sandbox create refused for capacity; running on the fallback", {
      provider: config.provider,
      fallbackProvider: fallbackProvider,
      error: toErrorMessage(error),
    });
    result = await runSandboxOn(
      {
        ...primary,
        provider: fallbackProvider,
        ...(controlPlane
          ? {
              controlPlane: {
                ...controlPlane,
                ownCredentials: undefined,
                specs: resolveSandboxSpecs({
                  provider: fallbackProvider,
                  size: primary.size,
                }),
              },
            }
          : {}),
      },
      namespace,
      code,
      options,
    );
  }
  if (result.cpuUsec !== undefined && result.cpuUsec > 0) {
    options?.onSandboxCpu?.({
      type: result.provider,
      role: "agent",
      cpuUsec: result.cpuUsec,
    });
  }

  return result;
}

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
    timeoutSeconds: sandboxTimeoutSeconds(config),
    outputLimitBytes: boundedInteger(
      config.outputLimitBytes,
      limits.defaultOutputLimitBytes,
      limits.maxOutputLimitBytes,
    ),
  });
}

export function editNeedsApproval(
  workspaces: ResolvedWorkspace[],
  requested?: string,
): boolean {
  try {
    const workspace = resolveWorkspace(workspaces, requested);
    // Read-only: no gate, so the call reaches the tool's own refusal.
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
    const picked = resolveAgentSandbox(context, selection.sandbox);
    if (!targetsAgentSandbox(context, selection)) {
      const workspace = resolveWorkspace(
        context.workspaces,
        selection.workspace,
      );
      // Read-only: no gate, so the call reaches the tool's own refusal.
      if (workspace && !workspace.sandbox) {
        return false;
      }

      return permissionModeFor(workspace) !== "bypass";
    }

    return picked?.sandbox.permissionMode !== "bypass";
  } catch {
    return true;
  }
}

export function bashSandboxTarget(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// A name always decides, even with one machine left: a replayed approval can carry a name
// from a longer list, and it must not land on whichever machine remains.
export function computerSandboxTarget(
  machines: ResolvedAgentSandbox[],
  requested: unknown,
): ResolvedAgentSandbox | undefined {
  if (typeof requested === "string") {
    return machines.find((machine): boolean => machine.name === requested);
  }

  return machines.length <= 1 ? machines[0] : undefined;
}

export function machineSandboxes(
  sandboxes: ResolvedAgentSandbox[] = [],
): ResolvedAgentSandbox[] {
  return sandboxes.filter(
    (entry): boolean => entry.sandbox.provider === "machine",
  );
}

export function bashTargetLines(context: SandboxToolContext): string[] {
  const namesWorkspace = workspaceParamSchema(context.workspaces) !== undefined;
  const namesSandbox = sandboxParamChoices(context).length > 0;
  const workspaces = context.workspaces.map(
    (workspace, index): string =>
      `- ${namesWorkspace ? `workspace=${workspace.name}` : `workspace ${workspace.name}, omit workspace`}${index === 0 ? " (default)" : ""}${workspace.sandbox ? "" : " (read-only, no bash)"}`,
  );
  const sandboxes = selectableSandboxes(context).map((entry, index): string => {
    const target = namesSandbox
      ? `sandbox=${entry.name}`
      : `sandbox ${entry.name}, omit sandbox`;
    const isDefault =
      context.workspaces.length === 0 && index === 0 ? " (default)" : "";

    return `- ${target}${isDefault} (${entry.sandbox.provider}, no workspace mounted${machineState(entry)})`;
  });

  return [...workspaces, ...sandboxes];
}

export function sandboxParamChoices(
  context: SandboxToolContext,
): ResolvedAgentSandbox[] {
  const choices = selectableSandboxes(context);
  const onlyTheDefault =
    choices.length === 1 && context.workspaces.length === 0;

  return onlyTheDefault ? [] : choices;
}

export function selectableSandboxes(
  context: SandboxToolContext,
): ResolvedAgentSandbox[] {
  const sandboxes = context.sandboxes ?? [];

  return hasStandaloneSandbox(context) ? sandboxes : sandboxes.slice(1);
}

export function targetsAgentSandbox(
  context: SandboxToolContext,
  selection: BashTarget = {},
): boolean {
  if (context.workspaces.length === 0) {
    return true;
  }
  if (selection.sandbox === undefined) {
    return false;
  }

  return selectableSandboxes(context).some(
    (entry): boolean => entry.name === selection.sandbox,
  );
}

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

// Not a presigned link: Zalo re-fetches the URL whenever a viewer opens the picture, so
// any expiry breaks chat history. The sealed ticket lasts as long as the file.
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
    requireSecretsEnv("MEDIA_TICKET_SECRET")[0],
  );

  return `${baseUrl}${MEDIA_PATH_PREFIX}${token}`;
}

// Slack and Discord take uploads only. S3 directly, not /media, skips a hop and its 25 MB cap.
export async function workspaceMediaBytes(
  ws: ResolvedWorkspace,
  rel: string,
  maxBytes?: number,
): Promise<Uint8Array> {
  const target = await resolveS3ReadTarget(
    workspaceReadContext(ws.config.storage, ws.namespace),
  );

  return await readS3Bytes(
    target.bucket,
    `${target.prefix}${rel}`,
    target.access,
    maxBytes,
  );
}

export function formatRunText(
  result: SandboxRunResult,
  timeoutSeconds: number,
): string {
  const output = `${result.stdout}${result.stderr}`;
  const separator = output === "" || output.endsWith("\n") ? "" : "\n";
  if (result.timedOut) {
    throw new Error(
      `${output}${separator}[timed out after ${timeoutSeconds}s, the per-call limit; any output past it is lost]`,
    );
  }
  const failed = !result.ok || (result.exitCode ?? 0) !== 0;
  if (!failed) {
    return output;
  }
  if (!result.ok) {
    const error =
      `${result.stderr}${result.stdout}`.trim() || "sandbox command failed";
    if (isFatalSandboxSetupError(error)) {
      throw new Error(error);
    }
  }
  const status =
    result.exitCode === null
      ? "command failed"
      : `exit code ${result.exitCode}`;

  return `${output}${separator}[${status}]`;
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

export function outsideWorkspaceCommand(
  command: string,
  options: { persistentOwnSandbox?: boolean } = {},
): string | undefined {
  const scanned = unescapeShellChars(stripHereDocBodies(command));
  // A guardrail, not a boundary: bash expands `$'\x2e\x2e'`, `$(...)` and variables after this.
  // The VM and the prefix-scoped mount credentials are the boundary.
  if (PARENT_TRAVERSAL.test(scanned)) {
    return "Error: parent directory traversal is not allowed";
  }
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

export function writesOutsideAllowed(
  workspace: ResolvedWorkspace,
  context: SandboxToolContext,
): boolean {
  return (
    workspace.sandbox?.persistent === true &&
    isAgentOwnSandbox(workspace, context)
  );
}

// A leading `/` is the workspace root, not the container root.
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

// Regex cannot parse shell: interpreter writes, symlink writes and install prefixes are
// knowingly left to the bash description's durability rule.
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

function invokesCommand(command: string, names: string[]): boolean {
  const escaped = names
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  return new RegExp(`(^|[\\s;&|()])(${escaped})(\\s|$)`).test(command);
}

function isEphemeralPath(path: string): boolean {
  return EPHEMERAL_WRITE_ROOTS.some(
    (root) => path === root.slice(0, -1) || path.startsWith(root),
  );
}

function machineState(entry: ResolvedAgentSandbox): string {
  if (entry.sandbox.provider !== "machine") return "";

  return isMachineConnected(entry.sandbox)
    ? ", connected"
    : `, offline: the person must run \`broods machine ${entry.name}\``;
}

function permissionModeFor(
  workspace: ResolvedWorkspace | undefined,
): SandboxPermissionMode {
  return workspace?.sandbox?.permissionMode ?? "ask";
}

async function runSandboxOn(
  config: SandboxExecutorConfig,
  namespace: string | undefined,
  code: string,
  options:
    | { metadata?: SandboxRunMetadata; principal?: SandboxRunPrincipal }
    | undefined,
): Promise<SandboxRunResult> {
  const executor = createSandboxExecutor(config);
  const limits = workspaceSandboxLimits(config.provider);
  const reservationKey =
    !namespace && config.persistent === true
      ? statelessReservationKeyFor(config)
      : undefined;
  const startedAt = Date.now();

  return executor
    .run({
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
      ...(options?.principal ? { principal: options.principal } : {}),
      timeoutSeconds: sandboxTimeoutSeconds(config),
      outputLimitBytes: boundedInteger(
        config.outputLimitBytes,
        limits.defaultOutputLimitBytes,
        limits.maxOutputLimitBytes,
      ),
    })
    .catch((error: unknown): SandboxRunResult => {
      if (!isTimeoutError(error)) throw error;

      return {
        ok: false,
        runtime: "bash",
        exitCode: null,
        stdout: "",
        stderr:
          "no answer from the sandbox in time; the command may still be running there",
        durationMs: Date.now() - startedAt,
        timedOut: true,
        provider: config.provider,
      };
    });
}

function runtimeList(config: SandboxExecutorConfig): SandboxRuntime[] {
  return config.runtimes && config.runtimes.length > 0
    ? config.runtimes
    : ["bash", "python", "node"];
}

export function statelessReservationKeyFor(
  config: SandboxExecutorConfig,
): string | undefined {
  return configString(config.options?.reservationKey);
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

function unescapeShellChars(command: string): string {
  return command.replace(/\\(.)/g, "$1");
}

function workspaceRelativeSuggestion(target: string): string {
  const basename = target.split("/").filter(Boolean).pop();

  return basename ? `./${basename}` : "./output";
}
