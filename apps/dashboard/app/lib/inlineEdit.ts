/** What a draft does when it is committed against the text it started from. */
export type InlineEditOutcome =
  | { kind: "commit"; value: string }
  | { kind: "empty" }
  | { kind: "unchanged" };

/** A draft trimmed; blank is refused, and the saved text again is no change at all. */
export function resolveInlineEdit(
  draft: string,
  saved: string,
): InlineEditOutcome {
  const value = draft.trim();
  if (value === "") return { kind: "empty" };
  if (value === saved) return { kind: "unchanged" };

  return { kind: "commit", value: value };
}
