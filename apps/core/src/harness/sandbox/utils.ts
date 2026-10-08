/**
 * Provider-neutral sandbox executor helpers.
 * Keep small coercion, path, quoting, and output utilities here, plus the
 * per-sandbox queue that orders dashboard-row writes and the ephemeral meter
 * built on it.
 */

import {
  removeSandboxInstance,
  upsertSandboxInstance,
} from "../../shared/convex/sandbox-instances.ts";
import type { SandboxExecResponse } from "../../shared/domain/sandbox-config.ts";
import { waitUntil } from "../../shared/in-flight.ts";
import { isPlainObject } from "../../shared/object.ts";
import type {
  SandboxControlPlane,
  SandboxRunMetadata,
  SandboxSpecs,
} from "../../shared/sandbox-sizes.ts";
import type {
  SandboxExecutorConfig,
  SandboxProvider,
  SandboxRunPrincipal,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";

// Providers whose machine is the size derived from the config; see configuredSandboxSpecs.
const CONFIGURED_SIZE_PROVIDERS: ReadonlySet<SandboxProvider> = new Set([
  "cloudflare",
  "lambda",
  "sandbox",
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Keeps a prefixed name within the length a whole name used to take, so adding a
// per-machine suffix cannot run into a provider's undocumented name limit.
const PREFIX_SLUG_LENGTH = 31;

// The run identity. Only core sets these, so both env layers drop them.
const IDENTITY_ENV_KEYS: ReadonlySet<string> = new Set([
  "BROODS_ACCOUNT_ID",
  "BROODS_AGENT_ID",
  "BROODS_BASE_URL",
  "BROODS_RUN_TOKEN",
]);

// Keys a per-call `request.envVars` may never set. Account `config.envVars` is
// filtered for the identity names only.
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

/**
 * Thrown by an executor whose provider refused the *create* for lack of room:
 * the MicroVM quota or throttle, workdir's admission ceiling, Daytona with no
 * runner. Raised only at the create call, so it always means nothing ran and
 * the same request may go to another provider.
 */
export class SandboxCapacityError extends Error {}

/**
 * Thrown by an executor that read the sandbox back from its provider and found
 * it past recovery (workdir `failed`: exec answers 409, only delete is allowed),
 * so the caller retires the reservation and creates a fresh one, exactly as it
 * would for a provider 404.
 */
export class SandboxGoneError extends Error {}

// Each sandbox's dashboard-row writes (upsert, burst, remove) in the order they
// were queued, so a write never beats the row it bills or its removal.
const mirrorWrites = new Map<string, Promise<void>>();

// Past the exec server's own `timeout_ms`: it answers `timed_out` itself, so
// the client deadline only covers a server that never answers.
export const EXEC_GRACE_MS = 15_000;

// A `SandboxExecResponse` (the lambda-sandbox image's and a custom server's
// answer) as a run result, with the output held to the request's limit.
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

// The body of a 2xx exec answer as the contract. A custom server is a third
// party, so the fields a run result is built from are checked, not assumed.
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

/**
 * True when a provider rejected sandbox creation because no runner could host it
 * (capacity, or a region-pinned/non-general snapshot). Capacity is the provider's
 * to resolve; the executor only surfaces a clearer message.
 */
/**
 * The machine size Broods itself sets from a config: workdir creates the VM with
 * those resources, every MicroVM is one size, and cloudflare starts that instance
 * type. Undefined for providers that size machines themselves, whose real size
 * is known only once they report it. Those three executors mirror it, and the
 * agent's status line states it.
 */
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

/**
 * True when a provider error means the sandbox is already gone (safe to forget),
 * as opposed to wrong credentials or a transient fault (which must propagate so a
 * caller can try another config rather than silently drop the instance record).
 */
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

// Account envVars under per-call overrides, reserved keys dropped from the
// overrides and the identity names from both, then the run's identity on top.
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

/**
 * Meter one ephemeral sandbox call on platform credentials: mirror a row keyed by
 * the sandbox id now, and return the call that removes it, which bills the time
 * in between. Call it only once the provider confirms the sandbox is gone, so a
 * failed teardown keeps billing until the stale-row sweep. The account's own
 * credentials, or no account, get no row. `readSpecs` returns the machine's real
 * size, or a read of it; it is called only for a metered call, and the row waits
 * for the read, which runs beside the command and so never holds it up.
 */
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
  void queueMirrorWrite(sandboxId, async (): Promise<void> =>
    upsertSandboxInstance(
      controlPlane,
      provider,
      sandboxId,
      sandboxId,
      metadata,
      { ephemeral: true, specs: await specs },
    ),
  );

  return (): void =>
    waitUntil(
      queueMirrorWrite(sandboxId, (): Promise<void> =>
        removeSandboxInstance(accountId, sandboxId, sandboxId),
      ),
    );
}

/**
 * Run `write` after every earlier write queued for this sandbox id. A failed
 * write never blocks the ones behind it. Every dashboard-row write for a sandbox
 * (upsert, burst, remove) goes through it, so a burst never beats the row it
 * bills and a removal never lands before the upsert that created the row.
 */
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

// The readable half of a reserved sandbox's name: a slug and hash of the
// reservation key, so a machine is recognisable at its provider. This is a
// prefix, not a name. The caller appends a per-machine suffix, because a name
// derived from the key alone would let a compare-and-swap on that name match a
// machine the caller never created. The slug budget leaves room for the suffix.
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

// Trimmed after the truncation, not before: a cut that lands on a separator
// would otherwise leave one dangling for a caller that appends to the result.
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
  // Every field the run result reads, by the type it must have. A required
  // one must be there; an optional one is checked only when the server sent it.
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

/** The BROODS_* variables sandbox code reads to act as its run. */
function principalEnv(principal: SandboxRunPrincipal): Record<string, string> {
  return {
    BROODS_ACCOUNT_ID: principal.accountId,
    BROODS_AGENT_ID: principal.agentId,
    ...(principal.baseUrl ? { BROODS_BASE_URL: principal.baseUrl } : {}),
    BROODS_RUN_TOKEN: principal.runToken,
  };
}
