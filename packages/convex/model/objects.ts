/** Shared guards for Convex config blobs that store unknown object-shaped data. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
