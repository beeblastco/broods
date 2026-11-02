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
  if (typeof value === "object" && value !== null) {
    const entries: [string, unknown][] = Object.entries(value);

    return Object.fromEntries(
      entries
        // Code-unit order, not locale collation: a hash of it must match in any runtime.
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }

  return value;
}
