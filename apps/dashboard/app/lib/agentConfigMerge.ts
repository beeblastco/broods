/**
 * Merge semantics for the Settings → Advanced raw-config editor.
 *
 * The retired Config tab's save rewrote `extraConfig` with only the
 * `agent`/`model`/`provider` branches and silently dropped everything else
 * (`scheduler`, `workspaces`, `sandbox`, …) — the known defect in
 * plans/00-read-first.md §2a. The Advanced editor loads the FULL nested
 * config and saves through this merge: a branch present in the edited JSON
 * replaces that branch, and every branch the edit does not mention survives
 * untouched.
 */

export type NestedConfig = Record<string, unknown>;

/**
 * Branch-level merge of an edited nested AgentConfig into the existing one.
 * Edited branches win wholesale (so removing a sub-field inside a branch the
 * user is editing sticks); unmentioned branches are preserved verbatim.
 */
export function mergeNestedAgentConfig(
  base: NestedConfig,
  edited: NestedConfig,
): NestedConfig {
  return { ...base, ...edited };
}
