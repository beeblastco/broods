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
import { parseAsSearch, parseAsSort } from "@/app/lib/urlState";
import { useQueryStates } from "nuqs";
import { useMemo } from "react";
import { useRemembered } from "./useRemembered";

const noMatch = (): boolean => false;
const noText = (): string => "";

/** `sortKey`, `matches` and `text` must be module constants, or the list memo breaks. */
export interface ListSpec<Row, Column extends string, Field extends string> {
  rows: readonly Row[];
  fields: readonly Field[];
  initialSort: SortState<NoInfer<Column>>;
  sortKey: Record<Column, (row: Row) => SortKey>;
  /** `value` arrives lowercased. */
  matches?: (row: Row, field: Field, value: string) => boolean;
  text?: (row: Row) => string;
  remember?: string;
  url?: boolean;
}

export interface ListState<Row, Column extends string, Field extends string> {
  query: string;
  setQuery: (query: string) => void;
  sort: SortState<Column>;
  shown: Row[];
  sortFor: (column: Column, words?: [string, string]) => HeadSort;
  filterFor: (field: Field, values: readonly string[]) => HeadFilter;
}

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
    url = true,
  } = spec;
  const [remembered, rememberQuery] = useRemembered(
    remember ? `${remember}.filter` : null,
    "",
  );
  const [rememberedSort, rememberSort] = useRemembered<SortState<Column>>(
    remember ? `${remember}.sort` : null,
    spec.initialSort,
  );
  const parsers = useMemo(
    () => ({
      q: parseAsSearch,
      sort: parseAsSort(sortKey),
    }),
    [sortKey],
  );
  const [linked, setLinked] = useQueryStates(parsers);
  // A link's `q`, even an empty one, wins over this viewer's remembered search.
  const query = url && linked.q !== null ? linked.q : remembered;
  const sort = (url && linked.sort) || rememberedSort;
  const setQuery = (next: string): void => {
    rememberQuery(next);
    if (url) void setLinked({ q: next });
  };
  const setSort = (next: SortState<Column>): void => {
    rememberSort(next);
    if (url) void setLinked({ sort: next });
  };
  const parsed = useMemo(() => parseQuery(query, fields), [query, fields]);
  const shown = useMemo(() => {
    const byField = new Map<Field, string[]>();
    for (const { field, value } of parsed.fields) {
      byField.set(field, [...(byField.get(field) ?? []), value]);
    }
    const matching = rows.filter((row) => {
      const chipsPass = [...byField].every(([field, values]) =>
        values.some((value) => matches(row, field, value)),
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
