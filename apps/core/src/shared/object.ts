/**
 * Runtime object-shape guards for untyped provider, webhook, and config payloads.
 */

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    isPlainObject(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

export function assertOptionalStringArray(value: unknown, name: string): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      !value.every(
        (entry) => typeof entry === "string" && entry.trim().length > 0,
      ))
  ) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
}
