"use client";

/** Token usage panel: aggregates CloudWatch Logs Insights data into charts and tables. */
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { toErrorMessage } from "@/app/lib/errors";
import { cn } from "@/app/lib/utils";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

interface Props {
    projectId: Id<"projects">;
    /** Active environment to scope usage to, or null for the whole project. */
    environmentId: Id<"environments"> | null;
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
    { key: "cachedInputTokens", label: "Cached", color: "#fbbf24" },
];

function formatNumber(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;

    return n.toLocaleString();
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
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
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
    totalTokens: number;
    invocations: number;
    modelCalls: number;
}> {
    const map = new Map<number, ReturnType<typeof mergeByBucket>[number]>();
    for (const b of buckets) {
        const existing = map.get(b.bucketStart);
        if (existing) {
            existing.inputTokens += b.inputTokens;
            existing.outputTokens += b.outputTokens;
            existing.reasoningTokens += b.reasoningTokens;
            existing.cachedInputTokens += b.cachedInputTokens;
            existing.totalTokens += b.totalTokens;
            existing.invocations += b.invocations;
            existing.modelCalls += b.modelCalls;
        } else {
            map.set(b.bucketStart, {
                bucketStart: b.bucketStart,
                inputTokens: b.inputTokens,
                outputTokens: b.outputTokens,
                reasoningTokens: b.reasoningTokens,
                cachedInputTokens: b.cachedInputTokens,
                totalTokens: b.totalTokens,
                invocations: b.invocations,
                modelCalls: b.modelCalls,
            });
        }
    }

    return Array.from(map.values()).sort((a, b) => a.bucketStart - b.bucketStart);
}

/**
 * Fill the selected time window with zero-valued bins so the X-axis spans
 * the full range (1h shows the whole hour, 1d shows the whole day, etc.),
 * matching the CloudWatch / Lambda monitoring style. Existing populated
 * bins are merged in at their aligned timestamps.
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
                totalTokens: 0,
                invocations: 0,
                modelCalls: 0,
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
            existing.totalTokens += b.totalTokens;
            existing.invocations += b.invocations;
            existing.modelCalls += b.modelCalls;
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
}

/**
 * Floating tooltip that hovers above a chart bar. Positioned in container-
 * relative coordinates so it follows the bar regardless of chart width.
 */
function ChartTooltip({
    xPct,
    yPct,
    children,
}: {
    xPct: number;
    yPct: number;
    children: React.ReactNode;
}) {
    return (
        <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-popover/95 px-2.5 py-1.5 text-[11px] shadow-lg backdrop-blur"
            style={{ left: `${xPct}%`, top: `${yPct}%` }}
        >
            {children}
        </div>
    );
}

/** Stacked-bar SVG chart for token usage over time, with per-bar hover breakdown. */
function StackedBarChart({ bins, binSeconds, series }: StackedBarChartProps) {
    const width = 640;
    const height = 200;
    const padding = { top: 12, right: 12, bottom: 28, left: 44 };
    const innerW = width - padding.left - padding.right;
    const innerH = height - padding.top - padding.bottom;
    const [hoverIndex, setHoverIndex] = useState<number | null>(null);
    const { ref: containerRef, fontSize } = useChartFontSize(width, 9);

    if (bins.length === 0) {
        return (
            <div className="rounded-lg bg-card px-4 py-12 text-center">
                <p className="text-sm text-muted-foreground">No usage data in this window.</p>
            </div>
        );
    }

    const maxTotal = Math.max(
        ...bins.map((b) => series.reduce((sum, s) => sum + (b[s.key as keyof typeof b] as number), 0)),
        1,
    );
    const barW = innerW / bins.length;
    const gap = Math.min(2, barW * 0.2);
    const hovered = hoverIndex !== null ? bins[hoverIndex] : null;
    const hoveredCenterPct = hoverIndex !== null
        ? ((padding.left + barW * hoverIndex + barW / 2) / width) * 100
        : 0;
    const hoveredTopPct = hovered
        ? ((padding.top + innerH - (series.reduce((s, sr) => s + (hovered[sr.key as keyof typeof hovered] as number), 0) / maxTotal) * innerH) / height) * 100
        : 0;

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
                                {formatNumber(val)}
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
                            style={{ cursor: "pointer" }}
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
                    <div className="font-medium tabular-nums">
                        {formatBucketLabel(hovered.bucketStart, binSeconds)}
                    </div>
                    <div className="mt-1 grid gap-0.5">
                        {series.map((s) => {
                            const value = hovered[s.key as keyof typeof hovered] as number;
                            return (
                                <div key={s.key as string} className="flex items-center justify-between gap-3">
                                    <span className="flex items-center gap-1.5 text-muted-foreground">
                                        <span className="size-2 rounded-sm" style={{ backgroundColor: s.color }} />
                                        {s.label}
                                    </span>
                                    <span className="tabular-nums">{value.toLocaleString()}</span>
                                </div>
                            );
                        })}
                        <div className="mt-0.5 flex items-center justify-between gap-3 border-t border-border/60 pt-0.5 font-medium">
                            <span className="text-muted-foreground">Total</span>
                            <span className="tabular-nums">{hovered.totalTokens.toLocaleString()}</span>
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

    if (bins.length === 0) {
        return (
            <div className="px-4 py-12 text-center">
                <p className="text-sm text-muted-foreground">No activity in this window.</p>
            </div>
        );
    }

    const maxVal = Math.max(...bins.map((b) => Math.max(b.invocations, b.modelCalls)), 1);
    const slot = innerW / bins.length;
    const barW = Math.max((slot - 4) / 2, 1);
    const hovered = hoverIndex !== null ? bins[hoverIndex] : null;
    const hoveredCenterPct = hoverIndex !== null
        ? ((padding.left + slot * hoverIndex + slot / 2) / width) * 100
        : 0;
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
                        <g
                            key={b.bucketStart}
                            onMouseEnter={() => setHoverIndex(i)}
                            style={{ cursor: "pointer" }}
                        >
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
                    <div className="font-medium tabular-nums">
                        {formatBucketLabel(hovered.bucketStart, binSeconds)}
                    </div>
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

export function TokensUsagePanel({ projectId, environmentId }: Props) {
    const [range, setRange] = useState<Range>("1h");
    const [stats, setStats] = useState<UsageStats | null>(null);
    const [isFetching, setIsFetching] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchUsageStats = useAction(api.logs.fetchUsageStats);

    const refresh = useCallback(async () => {
        setIsFetching(true);
        setError(null);
        try {
            const result = await fetchUsageStats({
                projectId: projectId,
                environmentId: environmentId ?? undefined,
                range: range,
            });
            setStats(result);
        } catch (err) {
            setError(toErrorMessage(err));
        } finally {
            setIsFetching(false);
        }
    }, [fetchUsageStats, projectId, environmentId, range]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const bins = useMemo(() => {
        if (!stats) return [];
        const merged = mergeByBucket(stats.buckets);
        return fillBucketsAcrossRange(merged, stats.binSeconds, RANGE_SECONDS[range]);
    }, [stats, range]);
    const byModel = useMemo(() => (stats ? aggregateByModel(stats.buckets) : []), [stats]);

    return (
        <div className="grid gap-8">
            <Section
                title="Usage Overview"
                description="Token consumption and model activity aggregated from CloudWatch Logs."
            >
                {/* Range selector + refresh */}
                <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-1 rounded-md border border-border bg-card p-1">
                        {RANGE_OPTIONS.map((opt) => (
                            <button
                                key={opt.id}
                                type="button"
                                onClick={() => setRange(opt.id)}
                                className={cn(
                                    "px-2.5 py-1 text-xs rounded cursor-pointer transition-colors",
                                    range === opt.id
                                        ? "bg-accent text-foreground"
                                        : "text-muted-foreground hover:text-foreground",
                                )}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>
                    <Button
                        size="sm"
                        variant="outline"
                        className="cursor-pointer gap-1.5"
                        onClick={refresh}
                        disabled={isFetching}
                    >
                        <RefreshCw className={`size-3.5 ${isFetching ? "animate-spin" : ""}`} />
                        {isFetching ? "Loading…" : "Refresh"}
                    </Button>
                </div>

                {error && <p className="text-sm text-destructive">{error}</p>}
            </Section>

            <Section title="Token usage over time" description="Stacked: input · output · reasoning · cached input.">
                <div className="rounded-lg border border-border bg-card p-3">
                    <StackedBarChart bins={bins} binSeconds={stats?.binSeconds ?? 0} series={TOKEN_SERIES} />
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

            <Section title="Tasks & model calls over time" description="Number of agent tasks and individual model invocations.">
                <div className="rounded-lg border border-border bg-card p-3">
                    <InvocationsChart bins={bins} binSeconds={stats?.binSeconds ?? 0} />
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

            <Section title="By model & provider" description="Per-(provider, model) totals over the selected window.">
                {byModel.length === 0 ? (
                    <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                        <p className="text-sm text-muted-foreground">No model activity in this window.</p>
                    </div>
                ) : (
                    <div className="rounded-lg border border-border bg-card overflow-x-auto">
                        <table className="w-full min-w-[680px] text-xs">
                            <thead>
                                <tr className="text-left text-muted-foreground border-b border-border">
                                    <th className="px-3 py-2 font-medium whitespace-nowrap">Provider</th>
                                    <th className="px-3 py-2 font-medium whitespace-nowrap">Model</th>
                                    <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Input</th>
                                    <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Output</th>
                                    <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Reasoning</th>
                                    <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Cached</th>
                                    <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Total</th>
                                    <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Tasks</th>
                                    <th className="px-3 py-2 font-medium whitespace-nowrap text-right">Calls</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border font-mono">
                                {byModel.map((m) => (
                                    <tr key={`${m.modelProvider}::${m.modelId}`}>
                                        <td className="px-3 py-2 whitespace-nowrap">{m.modelProvider}</td>
                                        <td className="px-3 py-2 whitespace-nowrap">{m.modelId}</td>
                                        <td className="px-3 py-2 whitespace-nowrap text-right">{formatNumber(m.inputTokens)}</td>
                                        <td className="px-3 py-2 whitespace-nowrap text-right">{formatNumber(m.outputTokens)}</td>
                                        <td className="px-3 py-2 whitespace-nowrap text-right">{formatNumber(m.reasoningTokens)}</td>
                                        <td className="px-3 py-2 whitespace-nowrap text-right">{formatNumber(m.cachedInputTokens)}</td>
                                        <td className="px-3 py-2 whitespace-nowrap text-right">{formatNumber(m.totalTokens)}</td>
                                        <td className="px-3 py-2 whitespace-nowrap text-right">{formatNumber(m.invocations)}</td>
                                        <td className="px-3 py-2 whitespace-nowrap text-right">{formatNumber(m.modelCalls)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Section>
        </div>
    );
}

