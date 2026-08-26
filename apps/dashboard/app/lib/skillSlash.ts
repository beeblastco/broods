/**
 * Slash-command parsing for the Agent tab composer: `/skill-name rest…`
 * resolves against the agent's genuinely enabled skills (one source of truth
 * with the Skills tab) and expands into an explicit ask to load that skill.
 */

export interface SkillSlash {
  name: string;
  rest: string;
}

/** Parse a leading `/skill-name` against the enabled names; null when no match. */
export function parseSkillSlash(
  input: string,
  enabledNames: readonly string[],
): SkillSlash | null {
  const match = input.match(/^\/([a-z0-9][a-z0-9-]*)\s*([\s\S]*)$/);
  if (!match || !match[1]) return null;
  const name = match[1];
  if (!enabledNames.includes(name)) return null;

  return { name: name, rest: (match[2] ?? "").trim() };
}

/** Names matching the current `/prefix` being typed, for the autocomplete row. */
export function matchSkillSlashPrefix(
  input: string,
  enabledNames: readonly string[],
): string[] {
  const match = input.match(/^\/([a-z0-9-]*)$/);
  if (!match) return [];
  const prefix = match[1] ?? "";

  return enabledNames.filter((name) => name.startsWith(prefix));
}

/** The message actually sent when a slash command is used. */
export function skillSlashMessage(slash: SkillSlash): string {
  return slash.rest.length > 0
    ? `Load and follow your "${slash.name}" skill, then: ${slash.rest}`
    : `Load and follow your "${slash.name}" skill, then confirm what it instructs you to do.`;
}
