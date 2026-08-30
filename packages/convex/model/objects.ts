/** Shared guards and transforms for Convex config blobs that store unknown object-shaped data. */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the value is a plain object whose values are all strings. */
export function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    isPlainObject(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/** Copy a record, replacing each key by its mapping when one exists. */
export function remapKeys(
  record: Record<string, unknown>,
  keyMap: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [keyMap[key] ?? key, value]),
  );
}

/** Deterministic JSON (keys sorted recursively) for small payload comparisons. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

/** Drop `undefined`-valued entries so optional fields stay absent, not null. */
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
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }

  return value;
}
