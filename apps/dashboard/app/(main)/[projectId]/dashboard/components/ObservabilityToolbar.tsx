"use client";

/**
 * Shared by the logs and tracing panels, so a filter added here shows up on
 * both: the token search, the range presets, the count, refresh, and the
 * volume strip whose drag narrows the range to a custom window.
 */
import { SearchInput } from "@/app/components/SearchInput";
import { SegmentedControl } from "@/app/components/SegmentedControl";
import { RefreshButton, Toolbar, ToolbarCount } from "@/app/components/Toolbar";
import { VolumeStrip } from "@/app/components/VolumeStrip";
import type { ObservabilityHistoryStatus } from "@/app/hooks/useObservabilityStream";
import {
  RANGE_PRESETS,
  rangeMs,
  volumeBins,
  type RangePreset,
  type TimeWindow,
} from "@/app/lib/queryTokens";
import { useMemo, useState } from "react";

/** The one point per entry the strip needs. */
export interface VolumePoint {
  ts: number;
  severity: "error" | "warn" | "none";
}

interface Props {
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  /** Field names the search box turns into chips. */
  searchFields: readonly string[];
  range: RangePreset;
  onRangeChange: (range: RangePreset) => void;
  /** The drag-picked part of the range, or null for the whole range. */
  window: TimeWindow | null;
  onWindowChange: (window: TimeWindow | null) => void;
  /** Every entry held, before filters; the strip draws their volume. */
  points: VolumePoint[];
  /** The strip's right edge; the panels pass the same clock their filters use. */
  now: number;
  shown: number;
  onRefresh: () => void;
  refreshDisabled: boolean;
  refreshTitle: string;
  isError: boolean;
}

/**
 * What an empty logs or traces table should say. "Waiting" alone hid a failed
 * or still-running history query behind the same text as a quiet stage.
 */
export function emptyStreamMessage(
  history: ObservabilityHistoryStatus,
  error: string | null,
  noun: "logs" | "traces",
  window: string,
): string {
  if (history === "loading") return `Loading ${noun} from the last ${window}…`;
  if (history === "failed")
    return `Couldn't load ${noun}: ${error ?? "history query failed"}`;
  if (history === "loaded") return `No ${noun} in the last ${window}.`;

  return `Waiting for ${noun}…`;
}

export function ObservabilityToolbar({
  search,
  onSearchChange,
  searchPlaceholder,
  searchFields,
  range,
  onRangeChange,
  window,
  onWindowChange,
  points,
  now,
  shown,
  onRefresh,
  refreshDisabled,
  refreshTitle,
  isError,
}: Props): React.JSX.Element {
  // The clock the strip ends at. It freezes while a selection is on the strip,
  // so the selection does not slide off the left edge as time passes.
  const [frozenNow, setFrozenNow] = useState<number | null>(null);
  const stripNow = frozenNow ?? now;
  const rangeWindow = useMemo(
    () => ({ from: stripNow - rangeMs(range), to: stripNow }),
    [stripNow, range],
  );
  const selectWindow = (selection: TimeWindow | null): void => {
    setFrozenNow(selection === null ? null : stripNow);
    onWindowChange(selection);
  };
  const bins = useMemo(
    () => volumeBins(points, rangeWindow),
    [points, rangeWindow],
  );

  return (
    <>
      <Toolbar>
        <SearchInput
          value={search}
          onChange={onSearchChange}
          fields={searchFields}
          placeholder={searchPlaceholder}
        />
        <SegmentedControl
          options={RANGE_PRESETS}
          value={range}
          onChange={(next) => {
            onRangeChange(next);
            selectWindow(null);
          }}
          ariaLabel="Time range"
        />
        <ToolbarCount shown={shown} total={points.length} />
        <RefreshButton
          onRefresh={onRefresh}
          disabled={refreshDisabled}
          title={refreshTitle}
          isError={isError}
        />
      </Toolbar>
      <VolumeStrip
        bins={bins}
        window={rangeWindow}
        selection={window}
        onSelect={selectWindow}
      />
    </>
  );
}
