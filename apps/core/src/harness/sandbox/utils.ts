/**
 * Provider-neutral sandbox executor helpers.
 * Keep small coercion, path, quoting, and output utilities here.
 */

import { isPlainObject } from "../../shared/object.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Keeps a prefixed name within the length a whole name used to take, so adding a
// per-machine suffix cannot run into a provider's undocumented name limit.
const PREFIX_SLUG_LENGTH = 31;

// Keys a per-call `request.envVars` may never set; account `config.envVars` is not filtered.
export const RESERVED_SANDBOX_ENV_KEYS: ReadonlySet<string> = new Set([
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

// Account envVars under per-call overrides, reserved keys dropped from the overrides.
export function mergeSandboxEnv(
  accountEnv: Record<string, string | undefined> | undefined,
  requestEnv: Record<string, string> | undefined,
): Record<string, string> {
  const overrides = Object.entries(requestEnv ?? {}).filter(
    ([key]) => !RESERVED_SANDBOX_ENV_KEYS.has(key),
  );

  return { ...stringRecord(accountEnv), ...Object.fromEntries(overrides) };
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
