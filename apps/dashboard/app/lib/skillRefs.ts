/**
 * Helpers for matching local skill node labels against agent `skills.allowed` entries.
 */

/** Returns true when an allowed skill entry names the local path directly or by trailing segment. */
export function matchesSkillRef(
  allowedRef: string,
  skillPath: string,
): boolean {
  const path = skillPath.trim();
  const ref = allowedRef.trim();
  if (!path || !ref) return false;
  if (ref === path) return true;

  const slashIndex = ref.lastIndexOf("/");
  if (slashIndex < 0) return false;

  return ref.slice(slashIndex + 1) === path;
}

/** Returns true when a skill path appears in the allowed list. */
export function includesSkillRef(
  allowed: readonly string[] | undefined,
  skillPath: string,
): boolean {
  return (allowed ?? []).some((entry) => matchesSkillRef(entry, skillPath));
}

/** Removes every allowed entry that targets the given local skill path. */
export function withoutSkillRef(
  allowed: readonly string[] | undefined,
  skillPath: string,
): string[] {
  return (allowed ?? []).filter((entry) => !matchesSkillRef(entry, skillPath));
}
