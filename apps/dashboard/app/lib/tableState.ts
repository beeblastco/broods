import { chipFor, parseQuery, splitTokens } from "./queryTokens";

export type SortDir = "asc" | "desc";

export interface SortState<C extends string> {
  column: C;
  dir: SortDir;
}

export type SortKey = string | number | null;

export function toggleToken(
  query: string,
  field: string,
  value: string,
): string {
  const token = chipFor(field, value);
  const words = splitTokens(query);
  const kept = words.filter((word) => word.toLowerCase() !== token);
  if (kept.length !== words.length) {
    return kept.length === 0 ? "" : `${kept.join(" ")} `;
  }

  return `${token} ${query.trimStart()}`;
}

export function clearField(query: string, field: string): string {
  return splitTokens(query)
    .filter((word) => !word.toLowerCase().startsWith(`${field}:`))
    .join(" ");
}

export function tokenValues(query: string, field: string): string[] {
  return parseQuery(query, [field]).fields.map((token) => token.value);
}

export function sortRows<T>(
  rows: readonly T[],
  key: (row: T) => SortKey,
  dir: SortDir,
): T[] {
  const sign = dir === "asc" ? 1 : -1;

  return rows
    .map((row, index) => ({ row: row, index: index, key: key(row) }))
    .sort((a, b) => {
      if (a.key === null && b.key === null) return a.index - b.index;
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      const order =
        typeof a.key === "number" && typeof b.key === "number"
          ? a.key - b.key
          : String(a.key).localeCompare(String(b.key), undefined, {
              sensitivity: "base",
              numeric: true,
            });

      return order === 0 ? a.index - b.index : order * sign;
    })
    .map((entry) => entry.row);
}
