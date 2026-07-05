/** Shared guards for Convex config blobs that store unknown object-shaped data. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the value is a plain object whose values are all strings. */
export function isStringRecord(value: unknown): value is Record<string, string> {
    return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}
