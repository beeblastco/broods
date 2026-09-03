export { cn } from "cn";

/** Narrows a value to a plain (non-array, non-null) object. */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
