export interface HistoryPage<T> {
  rows: T[];
  nextTo?: number;
}

// Keep a timestamp group on one page so a strict upper bound cannot skip tied entries.
export function historyPage<T>(
  rows: readonly T[],
  limit: number,
  timestamp: (row: T) => number,
): HistoryPage<T> {
  const sorted = rows.toSorted((a, b): number => timestamp(b) - timestamp(a));
  if (sorted.length <= limit) return { rows: sorted };
  const boundary = timestamp(sorted[limit]!);
  const page = sorted.filter((row): boolean => timestamp(row) > boundary);
  if (page.length === 0)
    throw new Error(
      "Too many entries share a timestamp. Narrow the query or increase the page size.",
    );

  return { rows: page, nextTo: boundary + 1 };
}
