"use client";

import { useTween } from "@/app/hooks/useTween";
import {
  monotonePath,
  niceTicks,
  resampleRows,
  type TokenParts,
} from "@/app/lib/usageChart";
import { useCallback, useMemo, useRef, useState } from "react";

const PAD_TOP = 6;
const PAD_BOTTOM = 18;
// Minimum pixels between x-axis labels; wider for "Sep 24 06:00" style labels.
const LABEL_GAP_PX = 64;
const WIDE_LABEL_GAP_PX = 120;
// Gap between the hovered point and the tooltip, on whichever side it opens.
const TOOLTIP_OFFSET_PX = 12;
// The tooltip's `min-w-44`, used until its real width is measured.
const TOOLTIP_MIN_WIDTH_PX = 176;

export interface UsageChartSeries {
  key: string;
  label: string;
  /** CSS color, usually a `var(--color-usage-*)` token. */
  color: string;
}

// The token chart's series, stacked bottom to top. The parts add up to
// totalTokens; see tokenParts. Shared by the Usage tab and its gallery fixture.
export const TOKEN_SERIES: Array<UsageChartSeries & { key: keyof TokenParts }> =
  [
    {
      key: "uncachedInput",
      label: "Uncached input",
      color: "var(--color-usage-input)",
    },
    {
      key: "cacheRead",
      label: "Cache read",
      color: "var(--color-usage-cache-read)",
    },
    {
      key: "cacheWrite",
      label: "Cache write",
      color: "var(--color-usage-cache-write)",
    },
    {
      key: "textOutput",
      label: "Text output",
      color: "var(--color-usage-output)",
    },
    {
      key: "reasoning",
      label: "Reasoning",
      color: "var(--color-usage-reasoning)",
    },
  ];

interface Props {
  kind: "area" | "bars";
  /** Plot height in px, axis labels included. */
  height: number;
  series: UsageChartSeries[];
  /** One row per bin, one value per series. Memoize: a new array starts a transition. */
  rows: number[][];
  bucketStarts: number[];
  binSeconds: number;
  selected: number | null;
  onSelect: (index: number) => void;
  formatAxis: (n: number) => string;
  formatValue: (n: number) => string;
  tickCount?: number;
}

interface Scale {
  width: number;
  height: number;
  slot: number;
  y: (v: number) => number;
}

/**
 * Stacked usage chart for the Usage tab. Draws at the container's real pixel
 * width so text and lines never scale, eases between datasets (range switch,
 * model filter, live updates), and reports a clicked or Enter-ed bin through
 * `onSelect`. Arrow keys move the hover when the chart has focus.
 */
export function UsageChart({
  kind,
  height,
  series,
  rows,
  bucketStarts,
  binSeconds,
  selected,
  onSelect,
  formatAxis,
  formatValue,
  tickCount = 4,
}: Props): React.JSX.Element {
  const [width, measureRef] = useElementWidth(0);
  const [hover, setHover] = useState<number | null>(null);

  const ticks = useMemo(
    () =>
      niceTicks(
        Math.max(0, ...rows.map((row) => row.reduce((a, b) => a + b, 0))),
        tickCount,
      ),
    [rows, tickCount],
  );
  const yMaxTarget = useMemo(() => [[ticks[ticks.length - 1]]], [ticks]);
  const yMax = useTween(yMaxTarget)[0][0] || 1;
  const tweened = useTween(rows);
  const n = bucketStarts.length;
  // The first frame after a range switch still holds the old bin count.
  const shown = tweened.length === n ? tweened : resampleRows(tweened, n);
  const innerH = height - PAD_TOP - PAD_BOTTOM;
  const scale: Scale = {
    width: width,
    height: height,
    slot: n > 0 ? width / n : 0,
    y: (v) => PAD_TOP + innerH - (v / yMax) * innerH,
  };
  const indexAt = (clientX: number, rect: DOMRect): number =>
    Math.max(
      0,
      Math.min(n - 1, Math.floor((clientX - rect.left) / scale.slot)),
    );
  const active = hover ?? selected ?? n - 1;

  return (
    <div className="relative select-none" ref={measureRef}>
      <button
        type="button"
        aria-label="Usage over time. Arrow keys move, Enter shows traces."
        className="block w-full cursor-pointer text-3xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") setHover(Math.max(0, active - 1));
          else if (event.key === "ArrowRight")
            setHover(Math.min(n - 1, active + 1));
          else return;
          event.preventDefault();
        }}
        onBlur={() => setHover(null)}
        onMouseMove={(event) =>
          setHover(
            indexAt(event.clientX, event.currentTarget.getBoundingClientRect()),
          )
        }
        onMouseLeave={() => setHover(null)}
        onClick={(event) =>
          // detail is 0 when Enter or Space fired the click.
          onSelect(
            event.detail === 0
              ? active
              : indexAt(
                  event.clientX,
                  event.currentTarget.getBoundingClientRect(),
                ),
          )
        }
      >
        {width > 0 && n > 0 && (
          <svg width={width} height={height} className="block">
            {selected !== null && selected < n && (
              <rect
                x={selected * scale.slot}
                y={PAD_TOP}
                width={scale.slot}
                height={innerH}
                className="fill-foreground/5"
              />
            )}
            <GridLines ticks={ticks} scale={scale} />
            {kind === "area" ? (
              <AreaLayers
                rows={shown}
                series={series}
                scale={scale}
                hover={hover}
              />
            ) : (
              <BarLayers
                rows={shown}
                series={series}
                scale={scale}
                active={hover ?? selected}
              />
            )}
            <AxisLabels
              ticks={ticks}
              scale={scale}
              bucketStarts={bucketStarts}
              binSeconds={binSeconds}
              formatAxis={formatAxis}
            />
          </svg>
        )}
      </button>
      {hover !== null && hover < n && rows[hover] && (
        <ChartTooltip
          x={hover * scale.slot + scale.slot / 2}
          chartWidth={width}
          title={formatBucketLabel(bucketStarts[hover], binSeconds, true)}
          series={series}
          values={rows[hover]}
          formatValue={formatValue}
        />
      )}
    </div>
  );
}

/** Time label for a bin: clock time for sub-day bins, date for day bins. */
export function formatBucketLabel(
  ms: number,
  binSeconds: number,
  long: boolean,
): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
  if (binSeconds >= 86400) return date;
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (!long && binSeconds < 6 * 3600) return time;

  return `${date} ${time}`;
}

/** Stacked smooth areas, one per series, plus the hover crosshair and dots. */
function AreaLayers({
  rows,
  series,
  scale,
  hover,
}: {
  rows: number[][];
  series: UsageChartSeries[];
  scale: Scale;
  hover: number | null;
}): React.JSX.Element {
  const { slot, y } = scale;
  const base = rows.map(() => 0);
  const layers = series.map((s, k) => {
    const top = rows.map((row, i): [number, number] => [
      i * slot + slot / 2,
      y(base[i] + row[k]),
    ]);
    const bottom = rows
      .map((_, i): [number, number] => [i * slot + slot / 2, y(base[i])])
      .reverse();
    rows.forEach((row, i) => {
      base[i] += row[k];
    });
    const back = monotonePath(bottom).replace(/^M[^C]*/, "");

    return (
      <path
        key={s.key}
        d={`${monotonePath(top)}L${bottom[0][0]},${bottom[0][1]}${back}Z`}
        fillOpacity={0.85}
        className="fill-(--series-color)"
        style={{ "--series-color": s.color }}
      />
    );
  });
  let stacked = 0;

  return (
    <>
      {layers}
      {hover !== null && hover < rows.length && (
        <>
          <line
            x1={hover * slot + slot / 2}
            x2={hover * slot + slot / 2}
            y1={y(0)}
            y2={PAD_TOP}
            className="stroke-foreground/30"
          />
          {series.map((s, k) => {
            stacked += rows[hover][k];
            if (rows[hover][k] <= 0) return null;

            return (
              <circle
                key={s.key}
                cx={hover * slot + slot / 2}
                cy={y(stacked)}
                r={2.5}
                className="fill-(--series-color) stroke-card"
                style={{ "--series-color": s.color }}
              />
            );
          })}
        </>
      )}
    </>
  );
}

/** Y labels sit inside the plot above their gridline, with a halo so marks never hide them. */
function AxisLabels({
  ticks,
  scale,
  bucketStarts,
  binSeconds,
  formatAxis,
}: {
  ticks: number[];
  scale: Scale;
  bucketStarts: number[];
  binSeconds: number;
  formatAxis: (n: number) => string;
}): React.JSX.Element {
  const gap =
    binSeconds >= 6 * 3600 && binSeconds < 86400
      ? WIDE_LABEL_GAP_PX
      : LABEL_GAP_PX;
  const every = Math.max(
    1,
    Math.ceil(bucketStarts.length / Math.max(2, Math.floor(scale.width / gap))),
  );

  return (
    <>
      {ticks.map((tick, i) => {
        const ty = Math.round(scale.y(tick)) + 0.5;
        if (i === 0 || ty < PAD_TOP + 8) return null;

        return (
          <text
            key={tick}
            x={2}
            y={ty - 3}
            strokeWidth={3}
            paintOrder="stroke"
            className="fill-muted-foreground stroke-card"
          >
            {formatAxis(tick)}
          </text>
        );
      })}
      {bucketStarts.map((start, i) =>
        i % every === 0 ? (
          <text
            key={start}
            x={i * scale.slot + scale.slot / 2}
            y={scale.height - 4}
            textAnchor={i === 0 ? "start" : "middle"}
            className="fill-muted-foreground"
          >
            {formatBucketLabel(start, binSeconds, false)}
          </text>
        ) : null,
      )}
    </>
  );
}

/** Stacked bars, one per bin; bins other than the active one dim. */
function BarLayers({
  rows,
  series,
  scale,
  active,
}: {
  rows: number[][];
  series: UsageChartSeries[];
  scale: Scale;
  active: number | null;
}): React.JSX.Element {
  const { slot, y } = scale;
  const barW = Math.max(1, slot * 0.7);
  const gap = (slot - barW) / 2;

  return (
    <>
      {rows.map((row, i) => {
        let acc = 0;

        return (
          <g
            key={i}
            opacity={active === null || active === i ? 1 : 0.5}
            className="transition-opacity duration-150"
          >
            {series.map((s, k) => {
              if (row[k] <= 0) return null;
              const y0 = y(acc);
              acc += row[k];
              const y1 = y(acc);

              return (
                <rect
                  key={s.key}
                  x={i * slot + gap}
                  y={y1}
                  width={barW}
                  height={Math.max(0, y0 - y1)}
                  className="fill-(--series-color)"
                  style={{ "--series-color": s.color }}
                />
              );
            })}
          </g>
        );
      })}
    </>
  );
}

/**
 * Hover card that glides between bins instead of jumping. Opens right of the
 * point, or left when its measured width does not fit, clamped inside the
 * chart on both sides.
 */
function ChartTooltip({
  x,
  chartWidth,
  title,
  series,
  values,
  formatValue,
}: {
  x: number;
  chartWidth: number;
  title: string;
  series: UsageChartSeries[];
  values: number[];
  formatValue: (n: number) => string;
}): React.JSX.Element {
  const [boxWidth, measureRef] = useElementWidth(TOOLTIP_MIN_WIDTH_PX);
  const right = x + TOOLTIP_OFFSET_PX;
  const side =
    right + boxWidth > chartWidth ? x - TOOLTIP_OFFSET_PX - boxWidth : right;
  const left = Math.max(0, Math.min(side, chartWidth - boxWidth));

  return (
    <div
      ref={measureRef}
      className="pointer-events-none absolute top-1.5 left-0 z-10 min-w-44 translate-x-(--tooltip-x) rounded-md border border-border bg-popover px-2.5 py-1.5 text-2xs shadow-sm transition-transform duration-150 ease-out"
      style={{ "--tooltip-x": `${Math.round(left)}px` }}
    >
      <div className="mb-1 font-medium tabular-nums">{title}</div>
      <div className="grid gap-0.5">
        {series
          .map((s, k) => ({ s: s, value: values[k] }))
          .reverse()
          .map(({ s, value }) => (
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
          ))}
        <div className="mt-0.5 flex items-center justify-between gap-3 border-t border-border pt-0.5 font-medium">
          <span className="text-muted-foreground">Total</span>
          <span className="tabular-nums">
            {formatValue(values.reduce((a, b) => a + b, 0))}
          </span>
        </div>
        <div className="text-muted-foreground">Click to see traces</div>
      </div>
    </div>
  );
}

/** Horizontal gridline per tick, drawn under the data. */
function GridLines({
  ticks,
  scale,
}: {
  ticks: number[];
  scale: Scale;
}): React.JSX.Element {
  return (
    <>
      {ticks.map((tick, i) => {
        const ty = Math.round(scale.y(tick)) + 0.5;
        if (ty < PAD_TOP - 1) return null;

        return (
          <line
            key={tick}
            x1={0}
            x2={scale.width}
            y1={ty}
            y2={ty}
            className={i === 0 ? "stroke-border" : "stroke-border/50"}
          />
        );
      })}
    </>
  );
}

/** Width of the element under the returned callback ref, kept current as it resizes. */
function useElementWidth(
  initial: number,
): [number, (el: HTMLElement | null) => void] {
  const [width, setWidth] = useState(initial);
  const observerRef = useRef<ResizeObserver | null>(null);
  const measureRef = useCallback((el: HTMLElement | null): void => {
    observerRef.current?.disconnect();
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.offsetWidth));
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  return [width, measureRef];
}
