export type InlineEditOutcome =
  | { kind: "commit"; value: string }
  | { kind: "empty" }
  | { kind: "unchanged" };

export function resolveInlineEdit(
  draft: string,
  saved: string,
): InlineEditOutcome {
  const value = draft.trim();
  if (value === "") return { kind: "empty" };
  if (value === saved) return { kind: "unchanged" };

  return { kind: "commit", value: value };
}
