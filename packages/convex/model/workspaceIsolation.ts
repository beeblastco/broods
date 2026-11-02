// No imports: the CLI bundles this file without the Convex runtime behind workspaceRules.

export const WORKSPACE_ISOLATION_LEVELS = ["conversation", "agent"] as const;

/** A folder per channel partition or per agent; unset shares one root. */
export type WorkspaceIsolation = (typeof WORKSPACE_ISOLATION_LEVELS)[number];

export function isWorkspaceIsolation(
  value: unknown,
): value is WorkspaceIsolation {
  return WORKSPACE_ISOLATION_LEVELS.some((level) => level === value);
}
