import type { RangePreset, TimeWindow } from "@/app/lib/queryTokens";
import { timeWindow, windowParams, type LOG_VIEW } from "@/app/lib/urlState";
import { useQueryStates } from "nuqs";
import { useCallback, useMemo } from "react";

/**
 * The logs or tracing panel's search box, range preset and strip window, kept
 * in the URL (`q`, `range`, `from`, `to`) so a link opens the same view. Pass
 * `LOG_VIEW` or `TRACE_VIEW`. Writes are shallow; the window keeps its
 * identity until `from` or `to` change, so the filters memoized on it hold.
 */
export function useObservabilityView(parsers: typeof LOG_VIEW): {
  query: string;
  setQuery: (query: string) => void;
  range: RangePreset;
  setRange: (range: RangePreset) => void;
  window: TimeWindow | null;
  setWindow: (window: TimeWindow | null) => void;
} {
  const [view, setView] = useQueryStates(parsers);
  const { from, to } = view;
  const window = useMemo(() => timeWindow(from, to), [from, to]);
  const setQuery = useCallback(
    (query: string): void => void setView({ q: query }),
    [setView],
  );
  const setRange = useCallback(
    (range: RangePreset): void => void setView({ range: range }),
    [setView],
  );
  const setWindow = useCallback(
    (next: TimeWindow | null): void => void setView(windowParams(next)),
    [setView],
  );

  return {
    query: view.q,
    setQuery: setQuery,
    range: view.range,
    setRange: setRange,
    window: window,
    setWindow: setWindow,
  };
}
