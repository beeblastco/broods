"use client";

/** Usage panel: live Convex usage rollups — tokens, activity, and compute — as charts and tables. */
import { Section } from "@/app/components/Section";
import { cn } from "@/app/lib/utils";
import { useObservabilityStream, type ObservabilitySpanRow } from "@/app/hooks/useObservabilityStream";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { estimateModelTokenCost } from "@broods/convex/modelPricing";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { RefreshCw } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

type Range = "1h" | "3h" | "1d" | "7d" | "30d" | "1y";
type UsageStats = FunctionReturnType<typeof api.logs.fetchUsageStats>;
type Bucket = UsageStats["buckets"][number];

const RANGE_SECONDS: Record<Range, number> = {
  "1h": 60 * 60,
  "3h": 3 * 60 * 60,
  "1d": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
  "1y": 365 * 24 * 60 * 60,
};

// Mirrors the server's bin sizing so the charts can render an empty (zero-bin)
// grid across the window before the first query resolves.
const RANGE_BIN_SECONDS: Record<Range, number> = {
  "1h": 5 * 60,
  "3h": 15 * 60,
  "1d": 60 * 60,
  "7d": 6 * 60 * 60,
  "30d": 24 * 60 * 60,
  "1y": 7 * 24 * 60 * 60,
};

interface Props {
  projectId: Id<"projects">;
  /** Active environment to scope usage to, or null for the whole project. */
  environmentId: Id<"environments"> | null;
  /** Scope + key for the live trace overlay. Omitted = Convex-only (no overlay). */
  projectSlug?: string | undefined;
  environmentSlug?: string | undefined;
  apiKey?: string | undefined;
}

// In-progress totals taken straight off the live trace stream. Tokens, task/model
// counts, and sandbox CPU are folded into the latest chart bin + headline tiles so
// a run in flight grows live instead of showing nothing until it finalizes.
interface LiveOverlay {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  // Running roots (tasks + subagent subtasks) and the model steps beneath them.
  invocations: number;
  modelCalls: number;
  agentSandboxCpuUsec: number;
  toolSandboxCpuUsec: number;
}

const EMPTY_LIVE_OVERLAY: LiveOverlay = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  invocations: 0,
  modelCalls: 0,
  agentSandboxCpuUsec: 0,
  toolSandboxCpuUsec: 0,
};

function numericAttribute(span: ObservabilitySpanRow, key: string): number {
  const value = span.attributes?.[key];

  return typeof value === "number" ? value : 0;
}

// A turn can't outlive the Lambda (15-min ceiling). A task still "running" past
// this never reported its terminal span (crash/freeze), so excluding it keeps a
// dead task from inflating the live total forever.
const STALE_RUNNING_TASK_MS = 20 * 60 * 1000;

/**
 * In-progress overlay taken straight off the live trace stream: Convex usage is
 * only written when a task finalizes, so a long run would otherwise show nothing
 * until it ends. Each model step is scoped to its own root span (a task OR a
 * subagent subtask, which share the parent's traceId) so a finished subtask stops
 * counting the moment its usage row lands in Convex — no double counting. Sandbox
 * CPU is read off the running roots, which the harness re-publishes with live
 * role-split CPU on each step.
 */
function liveOverlayFromTraces(spans: ObservabilitySpanRow[]): LiveOverlay {
  const freshAfter = Date.now() - STALE_RUNNING_TASK_MS;
  const runningRoots = spans.filter(
    (span) =>
      (span.kind === "task" || span.kind === "subtask") &&
      span.status === "running" &&
      span.startTimeMs >= freshAfter,
  );
  if (runningRoots.length === 0) return EMPTY_LIVE_OVERLAY;
  const runningRootSpanIds = new Set(runningRoots.map((root) => root.spanId));
  const totals = { ...EMPTY_LIVE_OVERLAY };
  totals.invocations = runningRoots.length;
  for (const root of runningRoots) {
    totals.agentSandboxCpuUsec += numericAttribute(root, "sandbox.cpu_usec.role.agent");
    totals.toolSandboxCpuUsec += numericAttribute(root, "sandbox.cpu_usec.role.tool");
  }
  for (const span of spans) {
    if (span.kind !== "model.step" || !span.parentSpanId || !runningRootSpanIds.has(span.parentSpanId)) continue;
    totals.modelCalls += 1;
    totals.inputTokens += numericAttribute(span, "model.input_tokens");
    totals.outputTokens += numericAttribute(span, "model.output_tokens");
    totals.reasoningTokens += numericAttribute(span, "model.reasoning_tokens");
    totals.cachedInputTokens += numericAttribute(span, "model.cached_input_tokens");
  }

  return totals;
}

const RANGE_OPTIONS: Array<{ id: Range; label: string }> = [
  { id: "1h", label: "1h" },
  { id: "3h", label: "3h" },
  { id: "1d", label: "1d" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "1y", label: "1y" },
];

const TOKEN_SERIES: Array<{ key: keyof Bucket; label: string; color: string }> = [
  { key: "inputTokens", label: "Input", color: "#60a5fa" },
  { key: "outputTokens", label: "Output", color: "#34d399" },
  { key: "reasoningTokens", label: "Reasoning", color: "#a78bfa" },
  { key: "cachedInputTokens", label: "Cache read", color: "#fbbf24" },
  { key: "cacheWriteTokens", label: "Cache write", color: "#fb7185" },
];

// Sandbox CPU split: agent's own sandbox vs user-uploaded tool sandboxes.
const SANDBOX_CPU_SERIES: Array<{
  key: keyof Bucket;
  label: string;
  color: string;
}> = [
  { key: "agentSandboxCpuUsec", label: "Agent sandbox", color: "#2dd4bf" },
  { key: "toolSandboxCpuUsec", label: "Tool sandbox", color: "#fb923c" },
];

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;

  return n.toLocaleString();
}

/** Microseconds → compact duration (µs / ms / s). */
function formatCpuUsec(usec: number): string {
  if (usec >= 1_000_000) return `${(usec / 1_000_000).toFixed(2)}s`;
  if (usec >= 1_000) return `${(usec / 1_000).toFixed(0)}ms`;

  return `${Math.round(usec)}µs`;
}

/** Milliseconds → compact duration (ms / s). */
function formatMs(ms: number): string {
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(2)}s`;

  return `${Math.round(ms)}ms`;
}

/** USD estimate with useful precision for small token batches. */
function formatUsd(value: number): string {
  if (value > 0 && value < 0.0001) return "<$0.0001";

  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

/**
 * Keeps SVG axis text at a fixed on-screen size. The chart's viewBox upscales to
 * the container width, which would otherwise blow the labels up on wide screens;
 * this counters that scale so labels stay aligned with the surrounding UI text. Uses
 * a callback ref so the observer attaches when the chart mounts (after data loads).
 */
function useChartFontSize(viewBoxWidth: number, targetPx: number) {
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

function formatBucketLabel(ms: number, binSeconds: number): string {
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

/** Merge per-(model, provider) rows into a single time-bucket aggregate for charting. */
function mergeByBucket(buckets: Bucket[]): Array<{
  bucketStart: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  invocations: number;
  modelCalls: number;
  runtimeWallMs: number;
  agentSandboxCpuUsec: number;
  toolSandboxCpuUsec: number;
}> {
  const map = new Map<number, ReturnType<typeof mergeByBucket>[number]>();
  for (const b of buckets) {
    const existing = map.get(b.bucketStart);
    if (existing) {
      existing.inputTokens += b.inputTokens;
      existing.outputTokens += b.outputTokens;
      existing.reasoningTokens += b.reasoningTokens;
      existing.cachedInputTokens += b.cachedInputTokens;
      existing.cacheWriteTokens += b.cacheWriteTokens;
      existing.totalTokens += b.totalTokens;
      existing.invocations += b.invocations;
      existing.modelCalls += b.modelCalls;
      existing.runtimeWallMs += b.runtimeWallMs;
      existing.agentSandboxCpuUsec += b.agentSandboxCpuUsec;
      existing.toolSandboxCpuUsec += b.toolSandboxCpuUsec;
    } else {
      map.set(b.bucketStart, {
        bucketStart: b.bucketStart,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        reasoningTokens: b.reasoningTokens,
        cachedInputTokens: b.cachedInputTokens,
        cacheWriteTokens: b.cacheWriteTokens,
        totalTokens: b.totalTokens,
        invocations: b.invocations,
        modelCalls: b.modelCalls,
        runtimeWallMs: b.runtimeWallMs,
        agentSandboxCpuUsec: b.agentSandboxCpuUsec,
        toolSandboxCpuUsec: b.toolSandboxCpuUsec,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => a.bucketStart - b.bucketStart);
}

/**
 * Fill the selected time window with zero-valued bins so the X-axis spans
 * the full range (1h shows the whole hour, 1d shows the whole day, etc.).
 * Existing populated bins are merged in at their aligned timestamps.
 */
function fillBucketsAcrossRange(
  merged: ReturnType<typeof mergeByBucket>,
  binSeconds: number,
  rangeSeconds: number,
  now: number = Date.now(),
): ReturnType<typeof mergeByBucket> {
  if (!binSeconds) return merged;
  const binMs = binSeconds * 1000;
  const endMs = Math.ceil(now / binMs) * binMs;
  const startMs = endMs - rangeSeconds * 1000;
  const indexed = new Map(merged.map((b) => [Math.floor(b.bucketStart / binMs) * binMs, b]));
  const out: ReturnType<typeof mergeByBucket> = [];
  for (let t = startMs; t < endMs; t += binMs) {
    const existing = indexed.get(t);
    out.push(
      existing ?? {
        bucketStart: t,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        invocations: 0,
        modelCalls: 0,
        runtimeWallMs: 0,
        agentSandboxCpuUsec: 0,
        toolSandboxCpuUsec: 0,
      },
    );
  }
  return out;
}

/** Aggregate per-bucket rows into per-(provider, modelId) totals for the breakdown table. */
function aggregateByModel(buckets: Bucket[]) {
  const map = new Map<string, Bucket>();
  for (const b of buckets) {
    const key = `${b.modelProvider}::${b.modelId}`;
    const existing = map.get(key);
    if (existing) {
      existing.inputTokens += b.inputTokens;
      existing.outputTokens += b.outputTokens;
      existing.reasoningTokens += b.reasoningTokens;
      existing.cachedInputTokens += b.cachedInputTokens;
      existing.cacheWriteTokens += b.cacheWriteTokens;
      existing.totalTokens += b.totalTokens;
      existing.invocations += b.invocations;
      existing.modelCalls += b.modelCalls;
      existing.runtimeWallMs += b.runtimeWallMs;
      existing.agentSandboxCpuUsec += b.agentSandboxCpuUsec;
      existing.toolSandboxCpuUsec += b.toolSandboxCpuUsec;
    } else {
      map.set(key, { ...b });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.totalTokens - a.totalTokens);
}

interface StackedBarChartProps {
  bins: ReturnType<typeof mergeByBucket>;
  binSeconds: number;
  series: typeof TOKEN_SERIES;
  formatAxis?: (n: number) => string;
  formatValue?: (n: number) => string;
  total?: (bin: ReturnType<typeof mergeByBucket>[number]) => number;
  totalLabel?: string;
}

/**
 * Floating tooltip that hovers above a chart bar. Positioned in container-
 * relative coordinates so it follows the bar regardless of chart width.
 */
function ChartTooltip({ xPct, yPct, children }: { xPct: number; yPct: number; children: React.ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-popover/95 px-2.5 py-1.5 text-[11px] shadow-lg backdrop-blur"
      style={{ left: `${xPct}%`, top: `${yPct}%` }}
    >
      {children}
    </div>
  );
}

/** Stacked-bar SVG chart over time, with per-bar hover breakdown. */
function StackedBarChart({
  bins,
  binSeconds,
  series,
  formatAxis = formatNumber,
  formatValue = (n) => n.toLocaleString(),
  total,
  totalLabel = "Total",
}: StackedBarChartProps) {
  const width = 640;
  const height = 200;
  const padding = { top: 12, right: 12, bottom: 28, left: 44 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const { ref: containerRef, fontSize } = useChartFontSize(width, 9);

  const binTotal = (b: ReturnType<typeof mergeByBucket>[number]): number =>
    total ? total(b) : series.reduce((sum, s) => sum + (b[s.key as keyof typeof b] as number), 0);

  const maxTotal = Math.max(...bins.map(binTotal), 1);
  const barW = innerW / bins.length;
  const gap = Math.min(2, barW * 0.2);
  const hovered = hoverIndex !== null ? bins[hoverIndex] : null;
  const hoveredCenterPct = hoverIndex !== null ? ((padding.left + barW * hoverIndex + barW / 2) / width) * 100 : 0;
  const hoveredTopPct = hovered ? ((padding.top + innerH - (binTotal(hovered) / maxTotal) * innerH) / height) * 100 : 0;

  return (
    <div className="relative" ref={containerRef}>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" onMouseLeave={() => setHoverIndex(null)}>
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
                style={{ fontSize: fontSize }}
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
            <g key={b.bucketStart} onMouseEnter={() => setHoverIndex(i)} style={{ cursor: "pointer" }}>
              {/* Full-height invisible hit target so empty space above the stack is also hoverable */}
              <rect x={padding.left + barW * i} y={padding.top} width={barW} height={innerH} fill="transparent" />
              {series.map((s) => {
                const value = b[s.key as keyof typeof b] as number;
                if (!value) return null;
                const h = (value / maxTotal) * innerH;
                yCursor -= h;

                return (
                  <rect
                    key={s.key as string}
                    x={x}
                    y={yCursor}
                    width={w}
                    height={h}
                    fill={s.color}
                    opacity={hoverIndex === null || isHover ? 1 : 0.5}
                  />
                );
              })}
            </g>
          );
        })}

        {/* X-axis labels — show ~6 evenly spaced */}
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
              style={{ fontSize: fontSize }}
            >
              {formatBucketLabel(b.bucketStart, binSeconds)}
            </text>
          );
        })}
      </svg>

      {hovered && (
        <ChartTooltip xPct={hoveredCenterPct} yPct={hoveredTopPct}>
          <div className="font-medium tabular-nums">{formatBucketLabel(hovered.bucketStart, binSeconds)}</div>
          <div className="mt-1 grid gap-0.5">
            {series.map((s) => {
              const value = hovered[s.key as keyof typeof hovered] as number;
              return (
                <div key={s.key as string} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-sm" style={{ backgroundColor: s.color }} />
                    {s.label}
                  </span>
                  <span className="tabular-nums">{formatValue(value)}</span>
                </div>
              );
            })}
            <div className="mt-0.5 flex items-center justify-between gap-3 border-t border-border/60 pt-0.5 font-medium">
              <span className="text-muted-foreground">{totalLabel}</span>
              <span className="tabular-nums">{formatValue(binTotal(hovered))}</span>
            </div>
          </div>
        </ChartTooltip>
      )}
    </div>
  );
}

interface InvocationsChartProps {
  bins: ReturnType<typeof mergeByBucket>;
  binSeconds: number;
}

/** Twin-series bar chart for tasks (model.invocation.finished) and model calls (model.step.finished). */
function InvocationsChart({ bins, binSeconds }: InvocationsChartProps) {
  const width = 640;
  const height = 180;
  const padding = { top: 12, right: 12, bottom: 28, left: 44 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const { ref: containerRef, fontSize } = useChartFontSize(width, 9);

  const maxVal = Math.max(...bins.map((b) => Math.max(b.invocations, b.modelCalls)), 1);
  const slot = innerW / bins.length;
  const barW = Math.max((slot - 4) / 2, 1);
  const hovered = hoverIndex !== null ? bins[hoverIndex] : null;
  const hoveredCenterPct = hoverIndex !== null ? ((padding.left + slot * hoverIndex + slot / 2) / width) * 100 : 0;
  const hoveredTopPct = hovered
    ? ((padding.top + innerH - (Math.max(hovered.invocations, hovered.modelCalls) / maxVal) * innerH) / height) * 100
    : 0;

  return (
    <div className="relative" ref={containerRef}>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" onMouseLeave={() => setHoverIndex(null)}>
        {[0, 0.5, 1].map((t, i) => {
          const y = padding.top + innerH * (1 - t);

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
                style={{ fontSize: fontSize }}
              >
                {formatNumber(maxVal * t)}
              </text>
            </g>
          );
        })}

        {bins.map((b, i) => {
          const x = padding.left + slot * i + 2;
          const hTasks = (b.invocations / maxVal) * innerH;
          const hCalls = (b.modelCalls / maxVal) * innerH;
          const isHover = hoverIndex === i;

          return (
            <g key={b.bucketStart} onMouseEnter={() => setHoverIndex(i)} style={{ cursor: "pointer" }}>
              <rect x={padding.left + slot * i} y={padding.top} width={slot} height={innerH} fill="transparent" />
              <rect
                x={x}
                y={padding.top + innerH - hTasks}
                width={barW}
                height={hTasks}
                fill="#22d3ee"
                opacity={hoverIndex === null || isHover ? 1 : 0.5}
              />
              <rect
                x={x + barW + 1}
                y={padding.top + innerH - hCalls}
                width={barW}
                height={hCalls}
                fill="#f472b6"
                opacity={hoverIndex === null || isHover ? 1 : 0.5}
              />
            </g>
          );
        })}

        {bins.map((b, i) => {
          const stride = Math.max(1, Math.ceil(bins.length / 12));
          if (i % stride !== 0) return null;
          const x = padding.left + slot * i + slot / 2;

          return (
            <text
              key={b.bucketStart}
              x={x}
              y={height - 8}
              textAnchor="middle"
              className="fill-muted-foreground"
              style={{ fontSize: fontSize }}
            >
              {formatBucketLabel(b.bucketStart, binSeconds)}
            </text>
          );
        })}
      </svg>

      {hovered && (
        <ChartTooltip xPct={hoveredCenterPct} yPct={hoveredTopPct}>
          <div className="font-medium tabular-nums">{formatBucketLabel(hovered.bucketStart, binSeconds)}</div>
          <div className="mt-1 grid gap-0.5">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-sm" style={{ backgroundColor: "#22d3ee" }} />
                Tasks
              </span>
              <span className="tabular-nums">{hovered.invocations.toLocaleString()}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-sm" style={{ backgroundColor: "#f472b6" }} />
                Model calls
              </span>
              <span className="tabular-nums">{hovered.modelCalls.toLocaleString()}</span>
            </div>
          </div>
        </ChartTooltip>
      )}
    </div>
  );
}

/** Single labelled compute metric with a colour swatch. */
function ComputeTile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="size-2.5 rounded-sm" style={{ backgroundColor: color }} />
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function TokensUsagePanel({ projectId, environmentId, projectSlug, environmentSlug, apiKey }: Props) {
  const [range, setRange] = useState<Range>("1h");

  // Reactive subscription: usage totals update live as the harness meters tokens.
  const data = useQuery(api.logs.fetchUsageStats, {
    projectId: projectId,
    environmentId: environmentId ?? undefined,
    range: range,
  });
  const stats: UsageStats | null = data ?? null;
  const isFetching = data === undefined;

  // Live trace overlay: Convex only records usage at task finalize, so without
  // this a run in flight shows nothing until it ends. We fold the in-progress
  // tokens into the latest bin + totals so the existing chart grows live.
  const { entries: liveSpans } = useObservabilityStream({
    stream: "traces",
    projectSlug: projectSlug,
    environmentSlug: environmentSlug,
    apiKey: apiKey,
    backfill: 30,
  });
  const liveOverlay = useMemo(() => liveOverlayFromTraces(liveSpans), [liveSpans]);
  const isStreamingLive = liveOverlay.invocations > 0;

  // Always span the window with zero-filled bins — even before the first query
  // resolves — so the user sees a live, empty grid rather than a "no data" card.
  const binSeconds = stats?.binSeconds ?? RANGE_BIN_SECONDS[range];
  const bins = useMemo(() => {
    const merged = stats ? mergeByBucket(stats.buckets) : [];
    const filled = fillBucketsAcrossRange(merged, binSeconds, RANGE_SECONDS[range]);
    // Fold in-progress tokens, task/model counts, and sandbox CPU into the most
    // recent bin so every chart (tokens, tasks & model calls, compute) grows live.
    if (filled.length > 0 && liveOverlay.invocations > 0) {
      const last = filled[filled.length - 1];
      filled[filled.length - 1] = {
        ...last,
        inputTokens: last.inputTokens + liveOverlay.inputTokens,
        outputTokens: last.outputTokens + liveOverlay.outputTokens,
        reasoningTokens: last.reasoningTokens + liveOverlay.reasoningTokens,
        cachedInputTokens: last.cachedInputTokens + liveOverlay.cachedInputTokens,
        totalTokens: last.totalTokens + liveOverlay.inputTokens + liveOverlay.outputTokens + liveOverlay.reasoningTokens,
        invocations: last.invocations + liveOverlay.invocations,
        modelCalls: last.modelCalls + liveOverlay.modelCalls,
        agentSandboxCpuUsec: last.agentSandboxCpuUsec + liveOverlay.agentSandboxCpuUsec,
        toolSandboxCpuUsec: last.toolSandboxCpuUsec + liveOverlay.toolSandboxCpuUsec,
      };
    }

    return filled;
  }, [stats, binSeconds, range, liveOverlay]);
  const byModel = useMemo(() => (stats ? aggregateByModel(stats.buckets) : []), [stats]);
  const pricedByModel = useMemo(
    () =>
      byModel.map((model) => ({
        ...model,
        estimatedCost: estimateModelTokenCost(model.modelProvider, model.modelId, model),
      })),
    [byModel],
  );
  const estimatedCost = pricedByModel.reduce((total, model) => total + (model.estimatedCost?.total ?? 0), 0);
  const unpricedModels = pricedByModel.filter((model) => model.estimatedCost === null).length;
  const compute = stats?.totals;

  return (
    <div className="grid gap-8">
      <Section
        title="Usage Overview"
        description="Token consumption and model activity, metered live by the agent harness."
      >
        {/* Range selector + live indicator */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-1 rounded-md border border-border bg-card p-1">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setRange(opt.id)}
                className={cn(
                  "px-2.5 py-1 text-xs rounded cursor-pointer transition-colors",
                  range === opt.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <RefreshCw className={`size-3.5 ${isFetching || isStreamingLive ? "animate-spin" : ""}`} />
            {isFetching ? "Connecting…" : isStreamingLive ? "Streaming" : "Live"}
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <ComputeTile label="Estimated token cost" value={formatUsd(estimatedCost)} color="#34d399" />
          <ComputeTile
            label="Cache read"
            value={formatNumber((stats?.totals.cachedInputTokens ?? 0) + liveOverlay.cachedInputTokens)}
            color="#fbbf24"
          />
          <ComputeTile label="Cache write" value={formatNumber(stats?.totals.cacheWriteTokens ?? 0)} color="#fb7185" />
        </div>
        {unpricedModels > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {unpricedModels} model{unpricedModels === 1 ? " is" : "s are"} not included in the estimate because no
            standard rate is configured.
          </p>
        )}
      </Section>

      <Section
        title="Token usage over time"
        description="Stacked: input, output, reasoning, cache reads, and cache writes."
      >
        <div className="rounded-lg border border-border bg-card p-3">
          <StackedBarChart bins={bins} binSeconds={binSeconds} series={TOKEN_SERIES} total={(b) => b.totalTokens} />
          <div className="flex flex-wrap gap-3 pt-2 pl-1">
            {TOKEN_SERIES.map((s) => (
              <div key={s.key as string} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="size-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
                {s.label}
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section
        title="Tasks & model calls over time"
        description="Number of agent tasks and individual model invocations."
      >
        <div className="rounded-lg border border-border bg-card p-3">
          <InvocationsChart bins={bins} binSeconds={binSeconds} />
          <div className="flex flex-wrap gap-3 pt-2 pl-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-2.5 rounded-sm" style={{ backgroundColor: "#22d3ee" }} />
              Tasks
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-2.5 rounded-sm" style={{ backgroundColor: "#f472b6" }} />
              Model calls
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="Compute"
        description="Harness runtime time and sandbox CPU — agent sandbox vs user-uploaded tool sandbox."
      >
        <div className="mb-4 grid grid-cols-3 gap-3">
          <ComputeTile label="Runtime" value={formatMs(compute?.runtimeWallMs ?? 0)} color="#818cf8" />
          <ComputeTile
            label="Agent sandbox CPU"
            value={formatCpuUsec((compute?.agentSandboxCpuUsec ?? 0) + liveOverlay.agentSandboxCpuUsec)}
            color="#2dd4bf"
          />
          <ComputeTile
            label="Tool sandbox CPU"
            value={formatCpuUsec((compute?.toolSandboxCpuUsec ?? 0) + liveOverlay.toolSandboxCpuUsec)}
            color="#fb923c"
          />
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <StackedBarChart
            bins={bins}
            binSeconds={binSeconds}
            series={SANDBOX_CPU_SERIES}
            formatAxis={formatCpuUsec}
            formatValue={formatCpuUsec}
            totalLabel="Sandbox CPU"
          />
          <div className="flex flex-wrap gap-3 pt-2 pl-1">
            {SANDBOX_CPU_SERIES.map((s) => (
              <div key={s.key as string} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="size-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
                {s.label}
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section title="By model & provider" description="Per-(provider, model) totals over the selected window.">
        <div className="rounded-lg border border-border bg-card overflow-x-auto">
          <table className="w-full min-w-170 text-xs">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="px-3 py-2 font-medium whitespace-nowrap">Provider</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">Model</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Input</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Output</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Reasoning</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Cache read</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Cache write</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Total</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Tasks</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Calls</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Est. cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border font-mono">
              {byModel.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-3 py-6 text-center text-muted-foreground/60">
                    Waiting for model activity…
                  </td>
                </tr>
              )}
              {pricedByModel.map((m) => (
                <tr key={`${m.modelProvider}::${m.modelId}`}>
                  <td className="px-3 py-2 whitespace-nowrap">{m.modelProvider}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{m.modelId}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">{formatNumber(m.inputTokens)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">{formatNumber(m.outputTokens)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">{formatNumber(m.reasoningTokens)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">{formatNumber(m.cachedInputTokens)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">{formatNumber(m.cacheWriteTokens)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">{formatNumber(m.totalTokens)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">{formatNumber(m.invocations)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">{formatNumber(m.modelCalls)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    {m.estimatedCost ? formatUsd(m.estimatedCost.total) : "Unpriced"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
