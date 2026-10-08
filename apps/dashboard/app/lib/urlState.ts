/**
 * The typed URL params every dashboard view reads, so a link (from an agent,
 * a teammate, another page) opens the exact view. Each param goes through a
 * parser with an allowlist or a shape check; anything else reads as absent,
 * so a bad link opens the default view and never throws. The URL only holds
 * view state: an id here selects among rows an authorized query already
 * loaded, and never runs or changes anything. The one read a link can cause
 * is Tracing fetching a `trace` it does not hold, with the stage's own key.
 */
import type { Id, TableNames } from "@broods/convex/_generated/dataModel";
import {
  createParser,
  debounce,
  parseAsArrayOf,
  parseAsStringLiteral,
  type SingleParserBuilder,
} from "nuqs";
import { isTraceId } from "../../../../packages/broods/src/observability-contracts";
import { RANGE_PRESETS, type TimeWindow } from "./queryTokens";
import type { SortDir, SortState } from "./tableState";

/** Longest search text a URL may carry. */
export const MAX_QUERY_LENGTH = 500;

/** A Convex id: 31 to 37 characters of lowercase Crockford base32 (no i, l, o, u). */
export const CONVEX_ID_SHAPE = /^[0-9a-hjkmnp-tv-z]{31,37}$/;
// Epoch ms: digits only, so no sign, exponent or fraction gets through.
const EPOCH_MS = /^\d{1,15}$/;
// A printable name with no control characters, as role names and model keys are.
const NAME = /^[^\p{Cc}]{1,200}$/u;
const SORT_DIRS: readonly SortDir[] = ["asc", "desc"];

const RANGE_IDS = RANGE_PRESETS.map((preset) => preset.id);

/**
 * Free search text, capped on read and write so every link the UI makes reads
 * back. The URL write waits for a typing pause: each write re-renders every
 * search-param reader. No default, so a list can tell an explicit `?q=` from
 * an absent one.
 */
export const parseAsSearch = createParser({
  parse: (value: string): string | null =>
    value.length <= MAX_QUERY_LENGTH ? value : null,
  serialize: (value: string): string => value.slice(0, MAX_QUERY_LENGTH),
}).withOptions({ limitUrlUpdates: debounce(300) });

/** The Logs and Tracing search, empty when absent. */
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

/** The usage panel's model filter: `provider::model` keys, comma separated; `models=` is none. */
export const parseAsModelKeys = parseAsArrayOf(parseAsName);

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
export function parseAsId<T extends TableNames>(): SingleParserBuilder<Id<T>> {
  return createParser({
    parse: (value: string): Id<T> | null =>
      isConvexId<T>(value) ? value : null,
    serialize: (value: Id<T>): string => value,
  });
}

/** A list's `column.dir` sort, where the column must be a key of the list's `sortKey`. */
export function parseAsSort<C extends string>(
  columns: Readonly<Record<C, unknown>>,
): SingleParserBuilder<SortState<C>> {
  const isColumn = (name: string): name is C => Object.hasOwn(columns, name);

  return createParser({
    parse: (value: string): SortState<C> | null => {
      const dot = value.lastIndexOf(".");
      const column = value.slice(0, dot);
      const dir = SORT_DIRS.find((name) => name === value.slice(dot + 1));

      return dot > 0 && isColumn(column) && dir
        ? { column: column, dir: dir }
        : null;
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

  // parseAsEpochMs rounds on write.
  return {
    from: window.from,
    to: Number.isFinite(window.to) ? window.to : null,
  };
}

// A string shaped like a Convex id of table `T`.
function isConvexId<T extends TableNames>(value: string): value is Id<T> {
  return CONVEX_ID_SHAPE.test(value);
}
