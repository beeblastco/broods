"use client";

import { useTween } from "@/app/hooks/useTween";
import {
  knownRuns,
  monotonePath,
  niceTicks,
  resampleRows,
  type TokenParts,
} from "@/app/lib/usageChart";
import { observeResize } from "@/app/lib/observeResize";
import { cn } from "@/app/lib/utils";
import { useCallback, useMemo, useState } from "react";

const PAD_TOP = 6;
const PAD_BOTTOM = 18;
const LABEL_GAP_PX = 64;
const WIDE_LABEL_GAP_PX = 120;
const TOOLTIP_OFFSET_PX = 12;
// The tooltip's `min-w-44`, until its real width is measured.
const TOOLTIP_MIN_WIDTH_PX = 176;

export interface UsageChartSeries {
  key: string;
  label: string;
  color: string;
}

// Stacked bottom to top; the parts sum to totalTokens (see tokenParts).
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
  kind: "area" | "bars" | "line";
  height: number;
  series: UsageChartSeries[];
  /** Per bin, per series; null is unknown. Memoize: a new array starts a transition. */
  rows: Array<Array<number | null>>;
  bucketStarts: number[];
  binSeconds: number;
  selected: number | null;
  onSelect?: (index: number) => void;
  formatAxis: (n: number) => string;
  formatValue: (n: number) => string;
  tickCount?: number;
  detail?: (index: number) => string;
}

interface Scale {
  width: number;
  height: number;
  slot: number;
  y: (v: number) => number;
}

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
  detail,
}: Props): React.JSX.Element {
  const [width, measureRef] = useElementWidth(0);
  const [hover, setHover] = useState<number | null>(null);

  const drawn = useMemo(
    () => rows.map((row) => row.map((value) => value ?? 0)),
    [rows],
  );
  const ticks = useMemo(
    () =>
      niceTicks(
        Math.max(0, ...drawn.map((row) => row.reduce((a, b) => a + b, 0))),
        tickCount,
      ),
    [drawn, tickCount],
  );
  const yMaxTarget = useMemo(() => [[ticks[ticks.length - 1]]], [ticks]);
  const yMax = useTween(yMaxTarget)[0][0] || 1;
  const tweened = useTween(drawn);
  const n = bucketStarts.length;
  // The tween's first frame after a switch still has the old bin and series counts.
  const shown = (tweened.length === n ? tweened : resampleRows(tweened, n)).map(
    (row) =>
      row.length === series.length ? row : series.map((_, k) => row[k] ?? 0),
  );
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
        aria-label={
          onSelect
            ? "Usage over time. Arrow keys move, Enter shows traces."
            : "Usage over time. Arrow keys move."
        }
        className={`block w-full text-3xs outline-none focus-visible:ring-1 focus-visible:ring-ring ${onSelect ? "cursor-pointer" : "cursor-default"}`}
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
        onClick={(event) => {
          const fromKeyboard = event.detail === 0;
          onSelect?.(
            fromKeyboard
              ? active
              : indexAt(
                  event.clientX,
                  event.currentTarget.getBoundingClientRect(),
                ),
          );
        }}
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
            ) : kind === "line" ? (
              <LineLayers
                rows={shown}
                known={rows}
                series={series}
                scale={scale}
                hover={hover}
              />
            ) : (
              <BarLayers
                rows={shown}
                bucketStarts={bucketStarts}
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
          clickable={onSelect !== undefined}
          detail={detail?.(hover)}
        />
      )}
    </div>
  );
}

export function UsageLegend({
  series,
  className,
}: {
  series: UsageChartSeries[];
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-wrap gap-3 text-2xs text-muted-foreground",
        className,
      )}
    >
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span
            className="size-2 rounded-sm bg-(--series-color)"
            style={{ "--series-color": s.color }}
          />
          {s.label}
        </span>
      ))}
    </div>
  );
}

// Day bins start at UTC midnight, so they print UTC dates.
export function formatBucketLabel(
  ms: number,
  binSeconds: number,
  long: boolean,
): string {
  const d = new Date(ms);
  if (binSeconds >= 86400) {
    const utcDay: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    };
    const first = d.toLocaleDateString([], utcDay);
    if (!long || binSeconds === 86400) return first;
    const last = new Date(ms + (binSeconds - 86400) * 1000);

    return `${first} – ${last.toLocaleDateString([], utcDay)}`;
  }
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (!long && binSeconds < 6 * 3600) return time;

  return `${date} ${time}`;
}

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

function LineLayers({
  rows,
  known,
  series,
  scale,
  hover,
}: {
  rows: number[][];
  known: Array<Array<number | null>>;
  series: UsageChartSeries[];
  scale: Scale;
  hover: number | null;
}): React.JSX.Element {
  const { slot, y } = scale;
  const isKnown = (i: number, k: number): boolean =>
    known[i] !== undefined && known[i][k] !== null;
  const x = (i: number): number => i * slot + slot / 2;

  return (
    <>
      {series.map((s, k) =>
        knownRuns(rows.map((row, i) => (isKnown(i, k) ? row[k] : null))).map(
          (run) =>
            run.length === 1 ? (
              <circle
                key={`${s.key}-${run[0][0]}`}
                cx={x(run[0][0])}
                cy={y(run[0][1])}
                r={4}
                className="fill-(--series-color)"
                style={{ "--series-color": s.color }}
              />
            ) : (
              <path
                key={`${s.key}-${run[0][0]}`}
                d={run
                  .map(([i, v], j) => `${j === 0 ? "M" : "L"}${x(i)},${y(v)}`)
                  .join("")}
                fill="none"
                strokeWidth={2}
                strokeLinejoin="round"
                className="stroke-(--series-color)"
                style={{ "--series-color": s.color }}
              />
            ),
        ),
      )}
      {hover !== null && hover < rows.length && (
        <>
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={y(0)}
            y2={PAD_TOP}
            className="stroke-foreground/30"
          />
          {series.map((s, k) =>
            isKnown(hover, k) ? (
              <circle
                key={s.key}
                cx={x(hover)}
                cy={y(rows[hover][k])}
                r={3}
                className="fill-(--series-color) stroke-card"
                style={{ "--series-color": s.color }}
              />
            ) : null,
          )}
        </>
      )}
    </>
  );
}

function BarLayers({
  rows,
  bucketStarts,
  series,
  scale,
  active,
}: {
  rows: number[][];
  bucketStarts: number[];
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
            key={bucketStarts[i]}
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

function ChartTooltip({
  x,
  chartWidth,
  title,
  series,
  values,
  formatValue,
  clickable,
  detail,
}: {
  x: number;
  chartWidth: number;
  title: string;
  series: UsageChartSeries[];
  values: Array<number | null>;
  formatValue: (n: number) => string;
  clickable: boolean;
  detail?: string | undefined;
}): React.JSX.Element {
  const [boxWidth, measureRef] = useElementWidth(TOOLTIP_MIN_WIDTH_PX);
  const right = x + TOOLTIP_OFFSET_PX;
  const side =
    right + boxWidth > chartWidth ? x - TOOLTIP_OFFSET_PX - boxWidth : right;
  const left = Math.max(0, Math.min(side, chartWidth - boxWidth));
  const known = values.filter((value) => value !== null);

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
              <span className="tabular-nums">
                {value === null ? "–" : formatValue(value)}
              </span>
            </div>
          ))}
        {series.length > 1 && (
          <div className="mt-0.5 flex items-center justify-between gap-3 border-t border-border pt-0.5 font-medium">
            <span className="text-muted-foreground">Total</span>
            <span className="tabular-nums">
              {known.length === 0
                ? "–"
                : formatValue(known.reduce((a, b) => a + b, 0))}
            </span>
          </div>
        )}
        {detail && <div className="text-muted-foreground">{detail}</div>}
        {clickable && (
          <div className="text-muted-foreground">Click to see traces</div>
        )}
      </div>
    </div>
  );
}

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

function useElementWidth(
  initial: number,
): [number, (el: HTMLElement | null) => (() => void) | undefined] {
  const [width, setWidth] = useState(initial);
  const measureRef = useCallback(
    (el: HTMLElement | null) =>
      el ? observeResize(el, () => setWidth(el.offsetWidth)) : undefined,
    [],
  );

  return [width, measureRef];
}
