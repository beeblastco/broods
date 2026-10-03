/**
 * Workspace isolation levels, the one list the config plane, core, the
 * dashboard and the CLI read. No imports on purpose: the CLI bundles this file
 * without the Convex runtime behind workspaceRules (like modelProviders.ts).
 */

export const WORKSPACE_ISOLATION_LEVELS = ["conversation", "agent"] as const;

/**
 * How a workspace splits its files. "conversation" mounts a folder per channel
 * partition, "agent" gives every attached agent its own folder. Unset shares
 * one root between every agent and conversation.
 */
export type WorkspaceIsolation = (typeof WORKSPACE_ISOLATION_LEVELS)[number];

export function isWorkspaceIsolation(
  value: unknown,
): value is WorkspaceIsolation {
  return WORKSPACE_ISOLATION_LEVELS.some((level) => level === value);
}

/**
 * The isolation level a config value asks for, with the boolean spelling
 * folded in: `true` is the first spelling of "conversation", which the API
 * still accepts and rows written before the levels existed hold. Anything
 * else reads as a shared root.
 */
export function workspaceIsolation(
  value: unknown,
): WorkspaceIsolation | undefined {
  if (value === true) return "conversation";

  return isWorkspaceIsolation(value) ? value : undefined;
}
