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

export function includesSkillRef(
  allowed: readonly string[] | undefined,
  skillPath: string,
): boolean {
  return (allowed ?? []).some((entry) => matchesSkillRef(entry, skillPath));
}

export function withoutSkillRef(
  allowed: readonly string[] | undefined,
  skillPath: string,
): string[] {
  return (allowed ?? []).filter((entry) => !matchesSkillRef(entry, skillPath));
}
