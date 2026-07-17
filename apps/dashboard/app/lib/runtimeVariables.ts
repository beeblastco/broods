/** Shared shape and guard for agent runtime environment variables. */

/** A single runtime environment variable entry stored on an agent config. */
export type RuntimeVariable = { key: string; value: string };

/**
 * Narrows an unknown value to a {@link RuntimeVariable}. Used to filter the
 * loosely-typed `agentConfig.runtimeVariables` array read from Convex.
 */
export function isRuntimeVariable(value: unknown): value is RuntimeVariable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { key: unknown }).key === "string" &&
    typeof (value as { value: unknown }).value === "string"
  );
}
