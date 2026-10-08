/**
 * The typed URL params every dashboard view reads, so a link (from an agent,
 * a teammate, another page) opens the exact view. Each param goes through a
 * parser with an allowlist or a shape check; anything else reads as absent,
 * so a bad link opens the default view and never throws. The URL only holds
 * view state: an id here selects among rows an authorized query already
 * loaded, it never fetches, runs or changes anything.
 */
import type { Id, TableNames } from "@broods/convex/_generated/dataModel";
import { createParser, debounce, parseAsStringLiteral } from "nuqs";
import { isTraceId } from "../../../../packages/broods/src/observability-contracts";
import { RANGE_PRESETS, type TimeWindow } from "./queryTokens";
import type { SortDir, SortState } from "./tableState";

/** Longest search text a URL may carry. */
export const MAX_QUERY_LENGTH = 500;

// Convex ids are lowercase base32; the length range leaves room for format changes.
const CONVEX_ID = /^[0-9a-z]{16,64}$/;
// Epoch ms: digits only, so no sign, exponent or fraction gets through.
const EPOCH_MS = /^\d{1,15}$/;
// A printable name with no control characters, as role names and model keys are.
const NAME = /^[^\p{Cc}]{1,200}$/u;
const MODEL_KEY = /^[^\p{Cc},]{1,200}$/u;
const SORT_DIRS: readonly SortDir[] = ["asc", "desc"];

const RANGE_IDS = RANGE_PRESETS.map((preset) => preset.id);

/**
 * Free search text, capped so a link cannot hand the filters a huge string.
 * No default, so a list can tell an explicit `?q=` from an absent one.
 */
export const parseAsSearch = createParser({
  parse: (value: string): string | null =>
    value.length <= MAX_QUERY_LENGTH ? value : null,
  // Capped on write too, so every link the UI makes reads back.
  serialize: (value: string): string => value.slice(0, MAX_QUERY_LENGTH),
})
  // Typing writes once it pauses: each URL write re-renders every search-param reader.
  .withOptions({ limitUrlUpdates: debounce(300) });

/** The search box of a view that has no remembered fallback; empty when absent. */
export const parseAsQuery = parseAsSearch.withDefault("");

/** A finite, non-negative integer timestamp in ms. */
export const parseAsEpochMs = createParser({
  parse: (value: string): number | null => {
    if (!EPOCH_MS.test(value)) return null;
    const ms = Number(value);

    return Number.isSafeInteger(ms) ? ms : null;
  },
  serialize: (value: number): string => String(Math.round(value)),
});

/** A W3C trace id: 32 lowercase hex, never all zeros. */
export const parseAsTraceId = createParser({
  parse: (value: string): string | null => (isTraceId(value) ? value : null),
  serialize: (value: string): string => value,
});

/** A role name or other printable label, up to 200 characters. */
export const parseAsName = createParser({
  parse: (value: string): string | null => (NAME.test(value) ? value : null),
  serialize: (value: string): string => value,
});

/** The usage panel's model filter: `provider::model` keys, comma separated. */
export const parseAsModelKeys = createParser({
  parse: (value: string): string[] | null => {
    const keys = value.split(",");

    return keys.every((key) => MODEL_KEY.test(key)) ? keys : null;
  },
  serialize: (value: string[]): string => value.join(","),
  eq: (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((key, index) => key === b[index]),
});

/** The logs panel's search, range and strip window. The 30 day backfill fits the widest preset. */
export const LOG_VIEW = {
  q: parseAsQuery,
  range: parseAsStringLiteral(RANGE_IDS).withDefault("30d"),
  from: parseAsEpochMs,
  to: parseAsEpochMs,
};

/** The tracing panel's search, range and strip window. The 7 day backfill fits that preset. */
export const TRACE_VIEW = {
  ...LOG_VIEW,
  range: parseAsStringLiteral(RANGE_IDS).withDefault("7d"),
};

/** A Convex document id of table `T`; the row it names still has to be in an authorized query's result. */
export function parseAsId<T extends TableNames>(): ReturnType<
  typeof createParser<Id<T>>
> {
  return createParser({
    parse: (value: string): Id<T> | null =>
      CONVEX_ID.test(value) ? (value as Id<T>) : null,
    serialize: (value: Id<T>): string => value,
  });
}

/** A list's `column.dir` sort, where the column must be one the list sorts by. */
export function parseAsSort<C extends string>(
  columns: readonly C[],
): ReturnType<typeof createParser<SortState<C>>> {
  return createParser({
    parse: (value: string): SortState<C> | null => {
      const dot = value.lastIndexOf(".");
      const column = columns.find((name) => name === value.slice(0, dot));
      const dir = SORT_DIRS.find((name) => name === value.slice(dot + 1));

      return dot > 0 && column && dir ? { column: column, dir: dir } : null;
    },
    serialize: (value: SortState<C>): string => `${value.column}.${value.dir}`,
    eq: (a: SortState<C>, b: SortState<C>): boolean =>
      a.column === b.column && a.dir === b.dir,
  });
}

/** The strip window `from`/`to` name: from before to, an absent `to` is open ended. */
export function timeWindow(
  from: number | null,
  to: number | null,
): TimeWindow | null {
  if (from === null) return null;
  const end = to ?? Number.POSITIVE_INFINITY;

  return from < end ? { from: from, to: end } : null;
}

/** The `from`/`to` params a window writes; an open end leaves `to` out. */
export function windowParams(window: TimeWindow | null): {
  from: number | null;
  to: number | null;
} {
  if (window === null) return { from: null, to: null };

  return {
    from: Math.round(window.from),
    to: Number.isFinite(window.to) ? Math.round(window.to) : null,
  };
}
