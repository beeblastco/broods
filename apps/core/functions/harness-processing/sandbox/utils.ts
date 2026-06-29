/**
 * Provider-neutral sandbox executor helpers.
 * Keep small coercion, path, quoting, and output utilities here.
 */

import { isPlainObject } from "../../_shared/object.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function configString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function assertSafeTenantProviderUrl(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use https`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    isPrivate172(host)
  ) {
    throw new Error(`${name} must not target localhost, private, or link-local addresses`);
  }
}

export function stringRecord(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
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

export function requiredWorkspacePath(
  request: { workspaceRoot?: string; namespace?: string },
  fallbackRoot: string,
): string {
  return workspacePath(request, fallbackRoot)!;
}

export function sandboxReservationKey(request: { reservationKey?: string; namespace?: string }): string | undefined {
  return request.reservationKey ?? request.namespace;
}

function isPrivate172(host: string): boolean {
  const match = /^172\.(\d{1,3})\./.exec(host);
  if (!match) return false;
  const octet = Number(match[1]);
  return Number.isInteger(octet) && octet >= 16 && octet <= 31;
}

// Deterministic name for a reserved sandbox: the same reservation key always
// maps to the same sandbox, so any later request reconnects to it. The hash
// keeps names unique after the slug is truncated. workdir and vercel both
// rely on this exact format to find their existing persistent sandboxes.
export function persistentSandboxName(reservationKey: string): string {
  return `fp-p-${slugFor(reservationKey)}-${shortHash(reservationKey)}`;
}

export function slugFor(value: string | undefined, fallback = "sandbox"): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || fallback;
}

export function shortHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).slice(0, 6);
}

export function truncateText(value: string, limit: number): { value: string; truncated: boolean } {
  const bytes = textEncoder.encode(value);
  if (bytes.byteLength <= limit) {
    return { value, truncated: false };
  }

  return {
    value: `${textDecoder.decode(bytes.slice(0, limit))}\n[output truncated]`,
    truncated: true,
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * True when a provider error means the sandbox is already gone (safe to forget),
 * as opposed to wrong credentials or a transient fault (which must propagate so a
 * caller can try another config rather than silently drop the instance record).
 */
export function isSandboxGoneError(error: unknown): boolean {
  if (!isPlainObject(error)) {
    return typeof error === "string" && /not ?found|does not exist|no such/i.test(error);
  }
  const status = error.statusCode ?? error.status ?? error.code;
  if (status === 404 || status === 410) {
    return true;
  }
  const message = typeof error.message === "string" ? error.message : "";
  return /not ?found|does not exist|no such|already (deleted|destroyed)/i.test(message);
}

/**
 * True when a provider rejected sandbox creation because no runner could host it
 * (capacity, or a region-pinned/non-general snapshot). Capacity is the provider's
 * to resolve; the executor only surfaces a clearer message.
 */
export function isNoRunnersError(error: unknown): boolean {
  const message = isPlainObject(error) && typeof error.message === "string"
    ? error.message
    : typeof error === "string" ? error : "";
  return /no (available )?runners?/i.test(message);
}
