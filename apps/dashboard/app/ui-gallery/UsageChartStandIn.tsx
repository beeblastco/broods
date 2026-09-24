"use client";

import {
  TOKEN_SERIES,
  UsageChart,
} from "@/app/(main)/[projectId]/dashboard/components/UsageChart";
import { formatNumber } from "@/app/lib/formatNumber";
import { formatAxisNumber, tokenParts } from "@/app/lib/usageChart";
import { useMemo, useState } from "react";

const HOUR_MS = 60 * 60 * 1000;
const START_MS = Date.UTC(2026, 8, 24, 0, 0);

/**
 * The Usage tab's token chart on fixed, cache-heavy data: SDK input totals that
 * already include cache reads and writes, the case that once stacked past the
 * frame. Two bin counts to switch between, like changing the range.
 */
export function UsageChartStandIn(): React.JSX.Element {
  const [bins, setBins] = useState(12);
  const [selected, setSelected] = useState<number | null>(null);
  const rows = useMemo(
    () =>
      Array.from({ length: bins }, (_, i) => {
        const input = 40_000 + ((i * 7919) % 11) * 9_000;
        const parts = tokenParts({
          inputTokens: input,
          outputTokens: Math.round(input * 0.1),
          reasoningTokens: Math.round(input * 0.03),
          cachedInputTokens: Math.round(input * 0.7),
          cacheWriteTokens: Math.round(input * 0.05),
        });

        return TOKEN_SERIES.map((s) => parts[s.key]);
      }),
    [bins],
  );
  const bucketStarts = useMemo(
    () => Array.from({ length: bins }, (_, i) => START_MS + i * HOUR_MS),
    [bins],
  );

  return (
    <div className="grid gap-2" data-selected={selected ?? "none"}>
      <div className="flex gap-2">
        {[12, 24].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => {
              setBins(n);
              setSelected(null);
            }}
            className="cursor-pointer rounded-md border border-border px-2 py-1 text-xs"
          >
            {n} bins
          </button>
        ))}
      </div>
      <div className="w-full max-w-3xl rounded-lg border border-border bg-card p-3">
        <UsageChart
          kind="area"
          height={250}
          series={TOKEN_SERIES}
          rows={rows}
          bucketStarts={bucketStarts}
          binSeconds={3600}
          selected={selected}
          onSelect={(i) => setSelected(i === selected ? null : i)}
          formatAxis={formatAxisNumber}
          formatValue={formatNumber}
        />
      </div>
    </div>
  );
}
