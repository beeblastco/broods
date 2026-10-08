/**
 * Sort and filter state every list shares. A filter is a `field:value` chip
 * in the search box, so the header menu, the Filter button and typing all
 * change the same string; sorting is one column and a direction.
 */

import { chipFor, parseQuery, splitTokens } from "./queryTokens";

export type SortDir = "asc" | "desc";

export interface SortState<C extends string> {
  column: C;
  dir: SortDir;
}

/** What a sortable column reads for a row; null sorts last either way. */
export type SortKey = string | number | null;

/** Adds `field:value` to the query, or removes it when already there. */
export function toggleToken(
  query: string,
  field: string,
  value: string,
): string {
  const token = chipFor(field, value);
  const words = splitTokens(query);
  const kept = words.filter((word) => word.toLowerCase() !== token);
  if (kept.length !== words.length) return kept.join(" ");

  return `${query.trim()} ${token} `.trimStart();
}

/** Removes every `field:` token from the query. */
export function clearField(query: string, field: string): string {
  return splitTokens(query)
    .filter((word) => !word.toLowerCase().startsWith(`${field}:`))
    .join(" ");
}

/** The lowercased values the query names for `field`. */
export function tokenValues(query: string, field: string): string[] {
  return parseQuery(query, [field]).fields.map((token) => token.value);
}

/**
 * A stable sort by one key. Numbers compare as numbers, strings without case,
 * and a null key goes last in both directions so unknowns never lead.
 */
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
