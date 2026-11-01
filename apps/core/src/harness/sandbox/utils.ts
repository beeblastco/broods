import {
  removeSandboxInstance,
  setSandboxInstanceSpecs,
  upsertSandboxInstance,
} from "../../shared/convex/sandbox-instances.ts";
import {
  findSandboxSnapshot,
  type SandboxSnapshotRecord,
} from "../../shared/convex/sandbox-snapshots.ts";
import type { SandboxExecResponse } from "../../shared/domain/sandbox-config.ts";
import { waitUntil } from "../../shared/in-flight.ts";
import { isPlainObject } from "../../shared/object.ts";
import {
  CONFIGURED_SIZE_PROVIDERS,
  type SandboxControlPlane,
  type SandboxRunMetadata,
  type SandboxSpecs,
} from "../../shared/sandbox-sizes.ts";
import {
  sandboxScope,
  snapshotBootRefusal,
} from "@broods/convex/model/sandboxRules";
import type {
  SandboxExecutorConfig,
  SandboxProvider,
  SandboxRunPrincipal,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const PREFIX_SLUG_LENGTH = 31;

const IDENTITY_ENV_KEYS: ReadonlySet<string> = new Set([
  "BROODS_ACCOUNT_ID",
  "BROODS_AGENT_ID",
  "BROODS_BASE_URL",
  "BROODS_RUN_TOKEN",
]);

export const RESERVED_SANDBOX_ENV_KEYS: ReadonlySet<string> = new Set([
  ...IDENTITY_ENV_KEYS,
  "BASH_ENV",
  "ENV",
  "HOME",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LOGNAME",
  "NODE_OPTIONS",
  "PATH",
  "PROMPT_COMMAND",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "SHELL",
  "TMPDIR",
  "USER",
  "__CB_CODE",
  "__CB_LOG",
  "__CB_TOKEN",
  "__CB_URL",
]);

// Thrown only at create, so nothing ran and the request may go to another provider.
export class SandboxCapacityError extends Error {}

export class SandboxGoneError extends Error {}

const mirrorWrites = new Map<string, Promise<void>>();

// The server answers `timed_out` itself; this only catches a server that never answers.
export const EXEC_GRACE_MS = 15_000;

export function execRunResult(
  request: SandboxRunRequest,
  response: SandboxExecResponse,
  provider: SandboxProvider,
  startedAt: number,
): SandboxRunResult {
  const stdout = truncateText(response.stdout, request.outputLimitBytes);
  const stderr = truncateText(response.stderr, request.outputLimitBytes);

  return {
    ok: response.ok,
    runtime: request.runtime ?? "bash",
    exitCode: response.exit_code ?? null,
    stdout: stdout.value,
    stderr: stderr.value,
    durationMs: response.duration_ms || Date.now() - startedAt,
    timedOut: response.timed_out,
    truncated:
      response.truncated === true || stdout.truncated || stderr.truncated,
    provider: provider,
    ...(typeof response.cpu_usec === "number" && response.cpu_usec > 0
      ? { cpuUsec: response.cpu_usec }
      : {}),
  };
}

// A custom exec server is a third party, so its answer is checked, not assumed.
export function parseExecResponse(
  bodyText: string,
  label: string,
): SandboxExecResponse {
  if (!bodyText) throw new Error(`${label} returned an empty response`);
  const parsed: unknown = JSON.parse(bodyText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} response must be a JSON object`);
  }
  if (!isExecResponse(parsed)) {
    throw new Error(`${label} response is not a sandbox exec response`);
  }

  return parsed;
}

export function configString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function configuredSandboxSpecs(
  config: Pick<SandboxExecutorConfig, "provider" | "controlPlane">,
): SandboxSpecs | undefined {
  return CONFIGURED_SIZE_PROVIDERS.has(config.provider)
    ? config.controlPlane?.specs
    : undefined;
}

export function isNoRunnersError(error: unknown): boolean {
  const message =
    isPlainObject(error) && typeof error.message === "string"
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  return /no (available )?runners?/i.test(message);
}

export function isSandboxGoneError(error: unknown): boolean {
  if (error instanceof SandboxGoneError) return true;
  if (!isPlainObject(error)) {
    return (
      typeof error === "string" &&
      /not ?found|does not exist|no such/i.test(error)
    );
  }
  const status = error.statusCode ?? error.status ?? error.code;
  if (status === 404 || status === 410) {
    return true;
  }
  const message = typeof error.message === "string" ? error.message : "";

  return /not ?found|does not exist|no such|already (deleted|destroyed)/i.test(
    message,
  );
}

export function mergeSandboxEnv(
  accountEnv: Record<string, string | undefined> | undefined,
  requestEnv: Record<string, string> | undefined,
  principal?: SandboxRunPrincipal,
): Record<string, string> {
  const account = Object.entries(stringRecord(accountEnv)).filter(
    ([key]) => !IDENTITY_ENV_KEYS.has(key),
  );
  const overrides = Object.entries(requestEnv ?? {}).filter(
    ([key]) => !RESERVED_SANDBOX_ENV_KEYS.has(key),
  );

  return {
    ...Object.fromEntries(account),
    ...Object.fromEntries(overrides),
    ...(principal ? principalEnv(principal) : {}),
  };
}

// Call the returned remover only once the provider confirms the sandbox is gone:
// a failed teardown keeps billing until the stale-row sweep.
export function meterEphemeralSandbox(
  controlPlane: SandboxControlPlane | undefined,
  provider: SandboxProvider,
  sandboxId: string,
  metadata: SandboxRunMetadata | undefined,
  readSpecs?: () =>
    | SandboxSpecs
    | Promise<SandboxSpecs | undefined>
    | undefined,
): () => void {
  const accountId = controlPlane?.ownCredentials
    ? undefined
    : controlPlane?.accountId;
  if (!accountId) return (): void => {};
  const specs = readSpecs?.();
  void queueMirrorWrite(sandboxId, (): Promise<void> =>
    upsertSandboxInstance(
      controlPlane,
      provider,
      sandboxId,
      sandboxId,
      metadata,
      { ephemeral: true, specs: specs instanceof Promise ? undefined : specs },
    ),
  );
  if (specs instanceof Promise) {
    void specs.then((reported): void => {
      if (!reported) return;
      void queueMirrorWrite(sandboxId, (): Promise<void> =>
        setSandboxInstanceSpecs(accountId, sandboxId, sandboxId, reported),
      );
    });
  }

  return (): void =>
    waitUntil(
      queueMirrorWrite(sandboxId, (): Promise<void> =>
        removeSandboxInstance(accountId, sandboxId, sandboxId),
      ),
    );
}

// Every row write for a sandbox goes here, so neither a burst nor a removal beats its upsert.
export function queueMirrorWrite(
  sandboxId: string,
  write: () => Promise<unknown>,
): Promise<void> {
  const queued = (mirrorWrites.get(sandboxId) ?? Promise.resolve())
    .then(write)
    .then(
      () => {},
      () => {},
    );
  mirrorWrites.set(sandboxId, queued);
  void queued.then(() => {
    if (mirrorWrites.get(sandboxId) === queued) mirrorWrites.delete(sandboxId);
  });

  return queued;
}

export function requiredWorkspacePath(
  request: { workspaceRoot?: string; namespace?: string },
  fallbackRoot: string,
): string {
  return workspacePath(request, fallbackRoot)!;
}

// Not a name: a key-derived name would let a compare-and-swap match a machine the caller
// never created, so callers append a per-machine suffix, which the slug budget leaves room for.
export function sandboxNamePrefix(reservationKey: string): string {
  return `fp-p-${slugFor(reservationKey, undefined, PREFIX_SLUG_LENGTH)}-${shortHash(reservationKey)}`;
}

export function sandboxReservationKey(request: {
  reservationKey?: string;
  namespace?: string;
}): string | undefined {
  return request.reservationKey ?? request.namespace;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function shortHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }

  return hash.toString(36).slice(0, 6);
}

// Trimmed after the cut, so a caller appending to it never gets a dangling separator.
export function slugFor(
  value: string | undefined,
  fallback = "sandbox",
  maxLength = 40,
): string {
  return (
    (value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, maxLength)
      .replace(/^-|-$/g, "") || fallback
  );
}

export function stringRecord(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function truncateText(
  value: string,
  limit: number,
): { value: string; truncated: boolean } {
  const bytes = textEncoder.encode(value);
  if (bytes.byteLength <= limit) {
    return { value: value, truncated: false };
  }

  return {
    value: `${textDecoder.decode(bytes.slice(0, limit))}\n[output truncated]`,
    truncated: true,
  };
}

export function workspacePath(
  request: { workspaceRoot?: string; namespace?: string },
  fallbackRoot?: string,
): string | undefined {
  const root = (request.workspaceRoot ?? fallbackRoot)?.replace(/\/+$/, "");
  if (!root) {
    return undefined;
  }

  return request.namespace ? `${root}/${request.namespace}` : root;
}

function isExecResponse(value: object): value is SandboxExecResponse {
  const fields: Record<
    Exclude<keyof SandboxExecResponse, "burst">,
    [type: string, required: boolean]
  > = {
    ok: ["boolean", true],
    runtime: ["string", false],
    exit_code: ["number", false],
    timed_out: ["boolean", true],
    duration_ms: ["number", true],
    stdout: ["string", true],
    stderr: ["string", true],
    truncated: ["boolean", false],
    cpu_usec: ["number", false],
  };
  const record: Record<string, unknown> = { ...value };

  return Object.entries(fields).every(
    ([field, [type, required]]): boolean =>
      typeof record[field] === type ||
      (!required && (record[field] === undefined || record[field] === null)),
  );
}

// A snapshot copies another sandbox's disk, so every create from one checks it first.
// Null for an image no account registered (a provider image or template).
export async function assertSnapshotBootable(
  controlPlane: SandboxControlPlane | undefined,
  snapshot: string | undefined,
): Promise<SandboxSnapshotRecord | null> {
  if (!snapshot) return null;
  const row = await findSandboxSnapshot(controlPlane?.accountId, snapshot);
  if (!row) return null;
  const refusal = controlPlane
    ? snapshotBootRefusal(row, {
        accountId: controlPlane.accountId,
        scope: sandboxScope(controlPlane),
      })
    : "config.snapshot names a snapshot, which boots only from a sandbox config of its own account and stage";
  if (refusal) throw new Error(refusal);

  return row;
}

function principalEnv(principal: SandboxRunPrincipal): Record<string, string> {
  return {
    BROODS_ACCOUNT_ID: principal.accountId,
    BROODS_AGENT_ID: principal.agentId,
    ...(principal.baseUrl ? { BROODS_BASE_URL: principal.baseUrl } : {}),
    BROODS_RUN_TOKEN: principal.runToken,
  };
}
