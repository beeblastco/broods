export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    isPlainObject(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

export function remapKeys(
  record: Record<string, unknown>,
  keyMap: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [keyMap[key] ?? key, value]),
  );
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        // Code-unit order, not locale collation: a hash of it must match in any runtime.
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }

  return value;
}
