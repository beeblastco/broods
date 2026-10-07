/** Shared classification for model-provider failures. */

// Providers describe the same input overflow with different status bodies.
const CONTEXT_LIMIT_PATTERN =
  /request too large|context (length|window)|prompt is too long|input is too long|exceeds the maximum number of tokens/i;

/** Whether a provider rejected a request because its input exceeded the model window. */
export function isContextLengthError(message: string): boolean {
  return CONTEXT_LIMIT_PATTERN.test(message);
}
