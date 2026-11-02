"use client";

import { SearchInput } from "@/app/components/SearchInput";
import { SegmentedControl } from "@/app/components/SegmentedControl";
import { RefreshButton, Toolbar } from "@/app/components/Toolbar";
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

export interface VolumePoint {
  ts: number;
  severity: "error" | "warn" | "none";
}

interface Props {
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  searchFields: readonly string[];
  range: RangePreset;
  onRangeChange: (range: RangePreset) => void;
  window: TimeWindow | null;
  onWindowChange: (window: TimeWindow | null) => void;
  points: VolumePoint[];
  marker?: number;
  now: number;
  onRefresh: () => void;
  refreshDisabled: boolean;
  refreshTitle: string;
  isError: boolean;
}

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
  marker,
  now,
  onRefresh,
  refreshDisabled,
  refreshTitle,
  isError,
}: Props): React.JSX.Element {
  // Frozen while the window picked on the strip stands, so it does not slide off as time
  // passes; compared by value, since the parent rebuilds the window from the URL.
  const [frozen, setFrozen] = useState<{
    window: TimeWindow;
    now: number;
  } | null>(null);
  const stripNow =
    frozen !== null &&
    frozen.window.from === window?.from &&
    frozen.window.to === window.to
      ? frozen.now
      : now;
  const rangeWindow = useMemo(
    () => ({ from: stripNow - rangeMs(range), to: stripNow }),
    [stripNow, range],
  );
  // Whole ms, the precision the URL keeps, so the frozen window matches it.
  const selectWindow = (drag: TimeWindow | null): void => {
    const selection =
      drag === null
        ? null
        : { from: Math.round(drag.from), to: Math.round(drag.to) };
    setFrozen(selection === null ? null : { window: selection, now: stripNow });
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
        marker={marker}
      />
    </>
  );
}
