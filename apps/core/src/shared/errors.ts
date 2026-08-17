/**
 * Readable text for a thrown value. A model provider reports a stream failure
 * as data rather than an exception, so the harness sees a payload where it
 * expects an Error and the one line worth reading sits nested inside it.
 */

/**
 * The part of a provider failure payload worth reading. `@ai-sdk/provider`
 * types a stream error part as `error: unknown`, and `@ai-sdk/openai` keeps its
 * `response.failed` schema private, so nothing shipped describes this shape.
 * The fields stay `unknown` because the payload is whatever the provider sent,
 * and narrowing each one here is what stops a nested object from rendering as
 * "[object Object]" all over again.
 */
interface ProviderErrorPayload {
  code?: unknown;
  error?: unknown;
  message?: unknown;
  response?: unknown;
}

/**
 * Normalize a thrown value to the message worth showing. `@ai-sdk/openai`
 * surfaces a Responses failure as `{ type, response: { error: { message } } }`
 * and a nested error chunk as `{ type, error: { message } }`, so `String()` on
 * either renders "[object Object]" and the reason is gone for good, because it
 * is never logged anywhere else. `getErrorMessage` from `@ai-sdk/provider`
 * stops at JSON for both. Fall back to JSON here too, so an unrecognised
 * payload is still legible.
 */
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
    return String(error);
  }
}

function nestedErrorMessage(value: unknown, depth: number): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const payload = value as ProviderErrorPayload;
  if (typeof payload.message === "string" && payload.message.length > 0) {
    // A code is a string or a number, the same pair the SDK's own
    // parseStreamError accepts.
    const code =
      typeof payload.code === "string" || typeof payload.code === "number"
        ? ` (${payload.code})`
        : "";

    return `${payload.message}${code}`;
  }
  // Two hops covers both AI SDK shapes; deeper is a payload we do not know.
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
