const UNREACHABLE_ERROR_CODES = new Set([
  "ConnectionRefused",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "FailedToOpenSocket",
]);

// The context window or a per-minute token cap: either way the conversation no longer fits.
const CONTEXT_LIMIT_PATTERN =
  /request too large|context (length|window)|prompt is too long|input is too long|exceeds the maximum number of tokens/i;

// Hand-typed: `@ai-sdk/openai` keeps its `response.failed` schema private.
interface ProviderErrorPayload {
  code?: unknown;
  error?: unknown;
  message?: unknown;
  response?: unknown;
}

export function isContextLengthError(message: string): boolean {
  return CONTEXT_LIMIT_PATTERN.test(message);
}

export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

export function isUnreachableError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof err.code === "string" &&
    UNREACHABLE_ERROR_CODES.has(err.code)
  );
}

// `@ai-sdk/openai` nests the reason in `response.error` or `error`; String() gives [object Object].
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const nested = nestedErrorMessage(error, 0);
  if (nested) {
    return nested;
  }
  if (!error || typeof error !== "object") {
    return String(error);
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Unserializable error";
  }
}

function nestedErrorMessage(value: unknown, depth: number): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const payload = value as ProviderErrorPayload;
  if (typeof payload.message === "string" && payload.message.length > 0) {
    const code =
      typeof payload.code === "string" || typeof payload.code === "number"
        ? ` (${payload.code})`
        : "";

    return `${payload.message}${code}`;
  }
  // Two hops cover both AI SDK shapes; deeper is a payload we do not know.
  if (depth >= 2) {
    return undefined;
  }
  for (const child of [payload.error, payload.response]) {
    const found = nestedErrorMessage(child, depth + 1);
    if (found) {
      return found;
    }
  }

  return undefined;
}
