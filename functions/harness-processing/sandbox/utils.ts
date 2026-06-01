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
