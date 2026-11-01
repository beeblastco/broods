// A link is untrusted: a bad param reads as absent, and an id only selects among rows an
// authorized query already loaded. It never runs or changes anything.
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

export const MAX_QUERY_LENGTH = 500;

// Lowercase Crockford base32: no i, l, o or u.
export const CONVEX_ID_SHAPE = /^[0-9a-hjkmnp-tv-z]{31,37}$/;
const EPOCH_MS = /^\d{1,15}$/;
const NAME = /^[^\p{Cc}]{1,200}$/u;
const SORT_DIRS: readonly SortDir[] = ["asc", "desc"];

const RANGE_IDS = RANGE_PRESETS.map((preset) => preset.id);

// Debounced: each URL write re-renders every search-param reader. No default, so a list
// can tell an explicit `?q=` from an absent one.
export const parseAsSearch = createParser({
  parse: (value: string): string | null =>
    value.length <= MAX_QUERY_LENGTH ? value : null,
  serialize: (value: string): string => value.slice(0, MAX_QUERY_LENGTH),
}).withOptions({ limitUrlUpdates: debounce(300) });

export const parseAsQuery = parseAsSearch.withDefault("");

export const parseAsEpochMs = createParser({
  parse: (value: string): number | null => {
    if (!EPOCH_MS.test(value)) return null;
    const ms = Number(value);

    return Number.isSafeInteger(ms) ? ms : null;
  },
  serialize: (value: number): string => String(Math.round(value)),
});

export const parseAsTraceId = createParser({
  parse: (value: string): string | null => (isTraceId(value) ? value : null),
  serialize: (value: string): string => value,
});

export const parseAsName = createParser({
  parse: (value: string): string | null => (NAME.test(value) ? value : null),
  serialize: (value: string): string => value,
});

export const parseAsModelKeys = parseAsArrayOf(parseAsName);

// Each default range matches the backfill its panel loads: 30 days of logs, 7 of traces.
export const LOG_VIEW = {
  q: parseAsQuery,
  range: parseAsStringLiteral(RANGE_IDS).withDefault("30d"),
  from: parseAsEpochMs,
  to: parseAsEpochMs,
};

export const TRACE_VIEW = {
  ...LOG_VIEW,
  range: parseAsStringLiteral(RANGE_IDS).withDefault("7d"),
};

export function parseAsId<T extends TableNames>(): SingleParserBuilder<Id<T>> {
  return createParser({
    parse: (value: string): Id<T> | null =>
      isConvexId<T>(value) ? value : null,
    serialize: (value: Id<T>): string => value,
  });
}

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

export function timeWindow(
  from: number | null,
  to: number | null,
): TimeWindow | null {
  if (from === null) return null;
  const end = to ?? Number.POSITIVE_INFINITY;

  return from < end ? { from: from, to: end } : null;
}

export function windowParams(window: TimeWindow | null): {
  from: number | null;
  to: number | null;
} {
  if (window === null) return { from: null, to: null };

  return {
    from: window.from,
    to: Number.isFinite(window.to) ? window.to : null,
  };
}

function isConvexId<T extends TableNames>(value: string): value is Id<T> {
  return CONVEX_ID_SHAPE.test(value);
}
