/**
 * Provider-neutral sandbox executor helpers.
 * Keep small coercion, path, quoting, and output utilities here.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function configString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecordObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

export function stringRecord(value: unknown): Record<string, string> {
  if (!isRecordObject(value)) {
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

// Deterministic name for a reserved sandbox: the same reservation key always
// maps to the same sandbox, so any later request reconnects to it. The hash
// keeps names unique after the slug is truncated. Kubernetes and vercel both
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
  if (!isRecordObject(error)) {
    return typeof error === "string" && /not ?found|does not exist|no such/i.test(error);
  }
  const status = error.statusCode ?? error.status ?? error.code;
  if (status === 404 || status === 410) {
    return true;
  }
  const message = typeof error.message === "string" ? error.message : "";
  return /not ?found|does not exist|no such|already (deleted|destroyed)/i.test(message);
}
