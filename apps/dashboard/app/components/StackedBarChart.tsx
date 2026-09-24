"use client";

import { formatNumber } from "@/app/lib/formatNumber";
import { useCallback, useRef, useState } from "react";

/** One stacked series: the bin field it reads, its legend label and color. */
export interface ChartSeries<K extends string> {
  key: K;
  label: string;
  color: string;
}

/** One bar: its start time and a number for each series key. */
export type ChartBin<K extends string> = { bucketStart: number } & Record<
  K,
  number
>;

interface StackedBarChartProps<K extends string> {
  bins: Array<ChartBin<K>>;
  binSeconds: number;
  series: Array<ChartSeries<K>>;
  formatAxis?: (n: number) => string;
  formatValue?: (n: number) => string;
  total?: (bin: ChartBin<K>) => number;
  totalLabel?: string;
}

/**
 * Floating tooltip that hovers above a chart bar. Positioned in container-
 * relative coordinates so it follows the bar regardless of chart width.
 */
export function ChartTooltip({
  xPct,
  yPct,
  children,
}: {
  xPct: number;
  yPct: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className="pointer-events-none absolute top-(--tooltip-y) left-(--tooltip-x) z-10 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-popover/95 px-2.5 py-1.5 text-2xs shadow-lg"
      style={{ "--tooltip-x": `${xPct}%`, "--tooltip-y": `${yPct}%` }}
    >
      {children}
    </div>
  );
}

/** SVG bar chart of time bins, one stacked segment per series, with a hover tooltip. Used by the Usage and Billing tabs. */
export function StackedBarChart<K extends string>({
  bins,
  binSeconds,
  series,
  formatAxis = formatNumber,
  formatValue = (n) => n.toLocaleString(),
  total,
  totalLabel = "Total",
}: StackedBarChartProps<K>): React.JSX.Element {
  const width = 640;
  const height = 200;
  const padding = { top: 12, right: 12, bottom: 28, left: 44 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const { ref: containerRef, fontSize } = useChartFontSize(width, 9);

  const binTotal = (b: ChartBin<K>): number =>
    total ? total(b) : series.reduce((sum, s) => sum + b[s.key], 0);

  const maxTotal = Math.max(...bins.map(binTotal), 1);
  const barW = innerW / bins.length;
  const gap = Math.min(2, barW * 0.2);
  const hovered = hoverIndex !== null ? bins[hoverIndex] : null;
  const hoveredCenterPct =
    hoverIndex !== null
      ? ((padding.left + barW * hoverIndex + barW / 2) / width) * 100
      : 0;
  const hoveredTopPct = hovered
    ? ((padding.top + innerH - (binTotal(hovered) / maxTotal) * innerH) /
        height) *
      100
    : 0;

  return (
    <div className="relative" ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto text-(length:--chart-font-size)"
        style={{ "--chart-font-size": `${fontSize}px` }}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {/* Y-axis ticks */}
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
          const y = padding.top + innerH * (1 - t);
          const val = maxTotal * t;

          return (
            <g key={i}>
              <line
                x1={padding.left}
                x2={padding.left + innerW}
                y1={y}
                y2={y}
                stroke="currentColor"
                className="text-border"
                strokeWidth={0.5}
              />
              <text
                x={padding.left - 6}
                y={y + 3}
                textAnchor="end"
                className="fill-muted-foreground"
              >
                {formatAxis(val)}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {bins.map((b, i) => {
          const x = padding.left + barW * i + gap / 2;
          const w = Math.max(barW - gap, 1);
          let yCursor = padding.top + innerH;
          const isHover = hoverIndex === i;

          return (
            <g
              key={b.bucketStart}
              onMouseEnter={() => setHoverIndex(i)}
              className="cursor-pointer"
            >
              {/* Full-height invisible hit target so empty space above the stack is also hoverable */}
              <rect
                x={padding.left + barW * i}
                y={padding.top}
                width={barW}
                height={innerH}
                fill="transparent"
              />
              {series.map((s) => {
                const value = b[s.key];
                if (!value) return null;
                const h = (value / maxTotal) * innerH;
                yCursor -= h;

                return (
                  <rect
                    key={s.key}
                    x={x}
                    y={yCursor}
                    width={w}
                    height={h}
                    className="fill-(--series-color)"
                    style={{ "--series-color": s.color }}
                    opacity={hoverIndex === null || isHover ? 1 : 0.5}
                  />
                );
              })}
            </g>
          );
        })}

        {/* X-axis labels, at most 12 evenly spaced */}
        {bins.map((b, i) => {
          const stride = Math.max(1, Math.ceil(bins.length / 12));
          if (i % stride !== 0) return null;
          const x = padding.left + barW * i + barW / 2;

          return (
            <text
              key={b.bucketStart}
              x={x}
              y={height - 8}
              textAnchor="middle"
              className="fill-muted-foreground"
            >
              {formatBucketLabel(b.bucketStart, binSeconds)}
            </text>
          );
        })}
      </svg>

      {hovered && (
        <ChartTooltip xPct={hoveredCenterPct} yPct={hoveredTopPct}>
          <div className="font-medium tabular-nums">
            {formatBucketLabel(hovered.bucketStart, binSeconds)}
          </div>
          <div className="mt-1 grid gap-0.5">
            {series.map((s) => {
              const value = hovered[s.key];

              return (
                <div
                  key={s.key}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      className="size-2 rounded-sm bg-(--series-color)"
                      style={{ "--series-color": s.color }}
                    />
                    {s.label}
                  </span>
                  <span className="tabular-nums">{formatValue(value)}</span>
                </div>
              );
            })}
            <div className="mt-0.5 flex items-center justify-between gap-3 border-t border-border/60 pt-0.5 font-medium">
              <span className="text-muted-foreground">{totalLabel}</span>
              <span className="tabular-nums">
                {formatValue(binTotal(hovered))}
              </span>
            </div>
          </div>
        </ChartTooltip>
      )}
    </div>
  );
}

/**
 * Keeps SVG axis text at a fixed on-screen size. The chart's viewBox upscales to
 * the container width, which would otherwise blow the labels up on wide screens;
 * this counters that scale so labels stay aligned with the surrounding UI text. Uses
 * a callback ref so the observer attaches when the chart mounts (after data loads).
 */
export function useChartFontSize(
  viewBoxWidth: number,
  targetPx: number,
): { ref: (el: HTMLDivElement | null) => void; fontSize: number } {
  const [fontSize, setFontSize] = useState(targetPx);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      if (!el) return;

      const observer = new ResizeObserver(() => {
        const rendered = el.clientWidth || viewBoxWidth;
        setFontSize((targetPx * viewBoxWidth) / rendered);
      });
      observer.observe(el);
      observerRef.current = observer;
    },
    [viewBoxWidth, targetPx],
  );

  return { ref: ref, fontSize: fontSize };
}

export function formatBucketLabel(ms: number, binSeconds: number): string {
  const d = new Date(ms);
  if (binSeconds < 24 * 60 * 60) {
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
