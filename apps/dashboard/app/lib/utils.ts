export { cn } from "cn";

// Not the convex copy: importing it pulls the agent-config model into 3 more chunks (+9 KB).
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
