import type { HeadFilter, HeadSort } from "@/app/components/DataTable";
import { parseQuery } from "@/app/lib/queryTokens";
import {
  clearField,
  sortRows,
  toggleToken,
  tokenValues,
  type SortKey,
  type SortState,
} from "@/app/lib/tableState";
import { useMemo } from "react";
import { useRemembered } from "./useRemembered";

// A list without a search box never sees a chip or a word.
const noMatch = (): boolean => false;
const noText = (): string => "";

/** How one list searches, filters and sorts its rows. */
export interface ListSpec<Row, Column extends string, Field extends string> {
  rows: readonly Row[];
  /** The `field:value` tokens the search box understands. */
  fields: readonly Field[];
  initialSort: SortState<NoInfer<Column>>;
  /** What each column sorts by. A module constant, so the list memo holds. */
  sortKey: Record<Column, (row: Row) => SortKey>;
  /** Whether a lowercased `field:value` chip keeps the row. A module constant; absent when the list has no search box. */
  matches?: (row: Row, field: Field, value: string) => boolean;
  /** The words free text searches, lowercased here. A module constant; absent when the list has no search box. */
  text?: (row: Row) => string;
  /** Keep the query and sort across reloads under this id; absent keeps them in memory. */
  remember?: string;
}

export interface ListState<Row, Column extends string, Field extends string> {
  query: string;
  setQuery: (query: string) => void;
  sort: SortState<Column>;
  /** The rows that match the query, in sort order. */
  shown: Row[];
  /** The sort half of a column's header menu. */
  sortFor: (column: Column, words?: [string, string]) => HeadSort;
  /** The filter half of a column's header menu, over the values it may take. */
  filterFor: (field: Field, values: readonly string[]) => HeadFilter;
}

/**
 * The state every list on the kit shares: the search box with its
 * `field:value` chips, one sorted column, and the header menus that change
 * them. Pages describe their rows once and render the result.
 */
export function useListState<Row, Column extends string, Field extends string>(
  spec: ListSpec<Row, Column, Field>,
): ListState<Row, Column, Field> {
  const {
    rows,
    fields,
    sortKey,
    matches = noMatch,
    text = noText,
    remember,
  } = spec;
  const [query, setQuery] = useRemembered(
    remember ? `${remember}.filter` : null,
    "",
  );
  const [sort, setSort] = useRemembered<SortState<Column>>(
    remember ? `${remember}.sort` : null,
    spec.initialSort,
  );
  const parsed = useMemo(() => parseQuery(query, fields), [query, fields]);
  const shown = useMemo(() => {
    const matching = rows.filter((row) => {
      const chipsPass = parsed.fields.every(({ field, value }) =>
        matches(row, field, value),
      );
      if (!chipsPass) return false;

      return !parsed.text || text(row).toLowerCase().includes(parsed.text);
    });

    // A remembered column the list no longer has falls back to the default.
    const key = sortKey[sort.column] ?? sortKey[spec.initialSort.column];

    return sortRows(matching, key, sort.dir);
  }, [rows, parsed, sort, sortKey, matches, text, spec.initialSort.column]);

  return {
    query: query,
    setQuery: setQuery,
    sort: sort,
    shown: shown,
    sortFor: (column, words) => ({
      dir: sort.column === column ? sort.dir : null,
      onSort: (dir) => setSort({ column: column, dir: dir }),
      words: words,
    }),
    filterFor: (field, values) => ({
      field: field,
      values: values.map((value) => ({ value: value, label: value })),
      active: tokenValues(query, field),
      onToggle: (value) => setQuery(toggleToken(query, field, value)),
      onClear: () => setQuery(clearField(query, field)),
    }),
  };
}
