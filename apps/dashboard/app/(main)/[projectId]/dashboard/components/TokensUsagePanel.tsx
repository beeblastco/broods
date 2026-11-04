"use client";

import { HelpMark } from "@/app/components/HelpMark";
import { SegmentedControl } from "@/app/components/SegmentedControl";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
  isRootSpanKind,
  useObservabilityStream,
  type ObservabilitySpanRow,
} from "@/app/hooks/useObservabilityStream";
import { useModelRates } from "@/app/hooks/useModelRates";
import { useTween } from "@/app/hooks/useTween";
import { formatNumber } from "@/app/lib/formatNumber";
import {
  formatUsd,
  isModelCallSpan,
  modelKey,
  numberAttribute,
  runModel,
  stepTokens,
  type ModelUsage,
} from "@/app/lib/modelCost";
import {
  bucketStartsAcrossRange,
  formatAxisNumber,
  knownRuns,
  perTaskAverages,
  SERIES_COLORS,
  tokenParts,
  type PerTaskAverages,
} from "@/app/lib/usageChart";
import { parseAsEpochMs, parseAsModelKeys } from "@/app/lib/urlState";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import {
  estimateModelTokenCost,
  type ModelTokenRates,
} from "@broods/convex/model/modelPricing";
import { useQuery } from "convex/react";
import { ChevronDownIcon } from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import { parseAsStringLiteral, useQueryStates } from "nuqs";
import { useMemo, useState } from "react";
import {
  formatBucketLabel,
  TOKEN_SERIES,
  UsageChart,
  UsageLegend,
  type UsageChartSeries,
} from "./UsageChart";
import { AllowanceUsage } from "./AllowanceUsage";
import { UsageTraceRail } from "./UsageTraceRail";

type UsageStats = FunctionReturnType<typeof api.logs.fetchUsageStats>;
type Range = UsageStats["range"];
type Bucket = UsageStats["buckets"][number];
type CounterKey = Exclude<
  keyof Bucket,
  | "bucketStart"
  | "modelProvider"
  | "modelId"
  | "agentSandboxCpuUsec"
  | "toolSandboxCpuUsec"
>;
type Counters = Record<CounterKey, number> & { bucketStart: number };
type PerTaskMetric = keyof PerTaskAverages;

interface Props {
  projectId: Id<"projects">;
  stageId: Id<"stages"> | null;
  projectSlug?: string | undefined;
  stageSlug?: string | undefined;
  apiKey?: string | undefined;
}

interface LiveOverlay {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  invocations: number;
  modelCalls: number;
  modelUsage: ModelUsage[];
}

const RANGE_SECONDS: Record<Range, number> = {
  "1h": 60 * 60,
  "3h": 3 * 60 * 60,
  "1d": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
  "1y": 365 * 24 * 60 * 60,
};

// Mirrors the server's bin sizing, for the empty grid before the first result.
const RANGE_BIN_SECONDS: Record<Range, number> = {
  "1h": 5 * 60,
  "3h": 15 * 60,
  "1d": 60 * 60,
  "7d": 6 * 60 * 60,
  "30d": 24 * 60 * 60,
  "1y": 7 * 24 * 60 * 60,
};

const RANGES: Array<{ id: Range }> = [
  { id: "1h" },
  { id: "3h" },
  { id: "1d" },
  { id: "7d" },
  { id: "30d" },
  { id: "1y" },
];

// `bin` is keyed by its start, so it survives the window sliding.
const USAGE_VIEW = {
  range: parseAsStringLiteral(RANGES.map((option) => option.id)).withDefault(
    "1h",
  ),
  models: parseAsModelKeys,
  bin: parseAsEpochMs,
};

const COUNTER_KEYS: CounterKey[] = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "totalTokens",
  "invocations",
  "modelCalls",
  "runtimeWallMs",
];

const TASK_HELP =
  "A task is one model pass; a run that waited on your answer and resumed counts twice.";

const PER_TASK_SERIES: Record<
  PerTaskMetric,
  UsageChartSeries & { format: (n: number) => string; help: string }
> = {
  cost: {
    key: "cost",
    label: "Avg cost per task",
    color: "var(--color-usage-output)",
    format: formatUsd,
    help: `${TASK_HELP} Models without a public price add no cost but their tasks still count.`,
  },
  calls: {
    key: "calls",
    label: "Avg model calls per task",
    color: "var(--color-usage-model-calls)",
    format: (n) => n.toFixed(1),
    help: TASK_HELP,
  },
  tokens: {
    key: "tokens",
    label: "Avg tokens per task",
    color: "var(--color-usage-input)",
    format: formatNumber,
    help: TASK_HELP,
  },
};

const EMPTY_LIVE_OVERLAY: LiveOverlay = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  invocations: 0,
  modelCalls: 0,
  modelUsage: [],
};

// A task "running" this long likely died before its terminal span, so it stops counting.
const STALE_RUNNING_TASK_MS = 20 * 60 * 1000;

export function TokensUsagePanel({
  projectId,
  stageId,
  projectSlug,
  stageSlug,
  apiKey,
}: Props): React.JSX.Element {
  const [view, setView] = useQueryStates(USAGE_VIEW);
  const { range, models: modelFilter, bin: selectedStart } = view;
  const setSelectedStart = (bin: number | null): void =>
    void setView({ bin: bin });
  const [metric, setMetric] = useState<PerTaskMetric | null>(null);

  // Convex records usage only at task finalize: a run in flight shows through the traces.
  const { entries: liveSpans } = useObservabilityStream({
    stream: "traces",
    projectSlug: projectSlug,
    stageSlug: stageSlug,
    apiKey: apiKey,
    backfill: 30,
  });
  const liveOverlay = useMemo(
    () => liveOverlayFromTraces(liveSpans),
    [liveSpans],
  );
  const data = useQuery(api.logs.fetchUsageStats, {
    projectId: projectId,
    stageId: stageId ?? undefined,
    range: range,
  });
  const { rates: liveRates, loading: liveRatesLoading } = useModelRates(
    liveOverlay.modelUsage,
  );
  // Held across a range switch so the chart morphs, never across a project or stage.
  const scopeKey = `${projectId}:${stageId ?? ""}`;
  const [held, setHeld] = useState<{ key: string; stats: UsageStats } | null>(
    null,
  );
  if (data !== undefined && data !== held?.stats) {
    setHeld({ key: scopeKey, stats: data });
  }
  const stats = data ?? (held?.key === scopeKey ? held.stats : null);

  const rates = useMemo(
    () =>
      new Map<string, ModelTokenRates>(
        [...(stats?.rates ?? []), ...(liveRates ?? [])].map((row) => [
          modelKey(row),
          row,
        ]),
      ),
    [stats, liveRates],
  );

  const shownRange = stats?.range ?? range;
  const binSeconds = stats?.binSeconds ?? RANGE_BIN_SECONDS[range];
  const binMs = binSeconds * 1000;
  const modelColors = useMemo(() => colorModels(stats?.buckets ?? []), [stats]);
  const activeFilter = useMemo(() => {
    const kept = (modelFilter ?? []).filter((key) => modelColors.has(key));

    return kept.length === 0 || kept.length === modelColors.size ? null : kept;
  }, [modelFilter, modelColors]);
  const isShown = (key: string): boolean =>
    activeFilter === null || activeFilter.includes(key);
  const bins = useMemo(() => {
    const shown = (stats?.buckets ?? []).filter(
      (b) => activeFilter === null || activeFilter.includes(modelKey(b)),
    );
    const filled = fillBucketsAcrossRange(
      mergeByBucket(shown),
      binSeconds,
      RANGE_SECONDS[shownRange],
    );

    // The live overlay has no per-model split, so it only joins the unfiltered view.
    return activeFilter === null
      ? withLiveOverlay(filled, liveOverlay)
      : filled;
  }, [stats, activeFilter, binSeconds, shownRange, liveOverlay]);
  const bucketStarts = useMemo(() => bins.map((b) => b.bucketStart), [bins]);
  const tokenRows = useMemo(
    () =>
      bins.map((b) => {
        const parts = tokenParts(b);

        return TOKEN_SERIES.map((s) => parts[s.key]);
      }),
    [bins],
  );
  const selectedIndex =
    selectedStart === null ? -1 : bucketStarts.indexOf(selectedStart);
  const selected = selectedIndex === -1 ? null : selectedIndex;
  const scope = useMemo(
    () => sumCounters(selected === null ? bins : [bins[selected]]),
    [bins, selected],
  );
  const { binCosts, estimatedCost, unpriced } = useMemo(() => {
    const byStart = new Map<number, number>();
    const unpricedModels = new Set<string>();
    const priceOf = (m: ModelUsage, loading = false): number => {
      const cost = estimateModelTokenCost(rates.get(modelKey(m)), m);
      if (cost === null && !loading) unpricedModels.add(modelKey(m));

      return cost?.total ?? 0;
    };
    for (const b of stats?.buckets ?? []) {
      if (activeFilter !== null && !activeFilter.includes(modelKey(b)))
        continue;
      const start = Math.floor(b.bucketStart / binMs) * binMs;
      byStart.set(start, (byStart.get(start) ?? 0) + priceOf(b));
    }
    const costs = bucketStarts.map((start) => byStart.get(start) ?? 0);
    if (activeFilter === null && costs.length > 0) {
      for (const m of liveOverlay.modelUsage) {
        costs[costs.length - 1] += priceOf(m, liveRatesLoading);
      }
    }

    return {
      binCosts: costs,
      estimatedCost:
        selected === null
          ? costs.reduce((total, cost) => total + cost, 0)
          : costs[selected],
      unpriced: unpricedModels.size,
    };
  }, [
    stats,
    activeFilter,
    binMs,
    bucketStarts,
    selected,
    liveOverlay,
    rates,
    liveRatesLoading,
  ]);

  const averages = useMemo(
    () => perTaskAverages(bins, binCosts),
    [bins, binCosts],
  );
  const chart = useMemo(
    () =>
      metric === null
        ? {
            kind: "area" as const,
            series: TOKEN_SERIES,
            rows: tokenRows,
            formatAxis: formatAxisNumber,
            formatValue: formatNumber,
            detail: undefined,
          }
        : {
            kind: "line" as const,
            series: [PER_TASK_SERIES[metric]],
            rows: averages[metric].map((value) => [value]),
            formatAxis: PER_TASK_SERIES[metric].format,
            formatValue: PER_TASK_SERIES[metric].format,
            detail: (index: number): string => binDetail(bins[index]),
          },
    [averages, bins, metric, tokenRows],
  );

  const selectBin = (index: number): void =>
    setSelectedStart(index === selected ? null : bucketStarts[index]);
  const toggleModel = (key: string): void => {
    const shown = activeFilter ?? [...modelColors.keys()];
    void setView({
      models: shown.includes(key)
        ? shown.filter((k) => k !== key)
        : [...shown, key],
    });
  };

  return (
    <div className="grid gap-8">
      <AllowanceUsage view={{ scope: "project", projectId: projectId }} />
      <section className="grid gap-4">
        <h2 className="text-sm font-semibold text-foreground">Tokens</h2>
        <UsageToolbar
          range={range}
          onRangeChange={(id) => void setView({ range: id, bin: null })}
          modelMenu={
            <ModelMenu
              modelColors={modelColors}
              allShown={activeFilter === null}
              isShown={isShown}
              onToggle={toggleModel}
              onShowAll={() => void setView({ models: null })}
            />
          }
          // The live window slides, so a selected bin can drop off the chart.
          selectedStart={selected === null ? null : selectedStart}
          binSeconds={binSeconds}
          onClearSelection={() => setSelectedStart(null)}
        />

        <UsageStats
          bins={bins}
          binCosts={binCosts}
          selected={selected}
          scope={scope}
          estimatedCost={estimatedCost}
          unpriced={unpriced}
          modelFilter={activeFilter}
          modelsTotal={modelColors.size}
          averages={averages}
          metric={metric}
          onMetric={(picked) =>
            setMetric((current) => (current === picked ? null : picked))
          }
        />

        <div
          className={cn(
            "grid rounded-lg border border-border bg-card",
            selected !== null && "lg:grid-cols-3",
          )}
        >
          <div className={cn("p-3", selected !== null && "lg:col-span-2")}>
            <UsageChart
              {...chart}
              height={400}
              bucketStarts={bucketStarts}
              binSeconds={binSeconds}
              selected={selected}
              onSelect={selectBin}
            />
            <UsageLegend series={chart.series} className="pt-2" />
          </div>
          {selected !== null && (
            <UsageTraceRail
              // A new bin starts with an empty search.
              key={bucketStarts[selected]}
              projectId={projectId}
              stageId={stageId}
              bin={{ startMs: bucketStarts[selected], binSeconds: binSeconds }}
              binTokens={bins[selected].totalTokens}
              models={activeFilter}
              rates={rates}
              onClose={() => setSelectedStart(null)}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function ModelMenu({
  modelColors,
  allShown,
  isShown,
  onToggle,
  onShowAll,
}: {
  modelColors: Map<string, string>;
  allShown: boolean;
  isShown: (key: string) => boolean;
  onToggle: (key: string) => void;
  onShowAll: () => void;
}): React.JSX.Element {
  const keys = [...modelColors.keys()];
  const shown = keys.filter(isShown);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs">
        <span className="flex gap-0.5">
          {shown.map((key) => (
            <span
              key={key}
              className="size-2 rounded-sm bg-(--series-color)"
              style={{ "--series-color": modelColors.get(key) }}
            />
          ))}
        </span>
        {allShown ? "All models" : `${shown.length} of ${keys.length} models`}
        <ChevronDownIcon className="size-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem data-active={allShown} onClick={onShowAll}>
          All models
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {keys.map((key) => (
          <DropdownMenuCheckboxItem
            key={key}
            checked={isShown(key)}
            onCheckedChange={() => onToggle(key)}
          >
            <span
              className="size-2 rounded-sm bg-(--series-color)"
              style={{ "--series-color": modelColors.get(key) }}
            />
            {key.split("::")[1]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Sparkline({
  values,
  selected,
  color,
}: {
  values: Array<number | null>;
  selected: number | null;
  color: string;
}): React.JSX.Element {
  const max = Math.max(0, ...values.map((v) => v ?? 0)) || 1;
  const step = values.length > 1 ? 100 / (values.length - 1) : 100;
  // A lone bin repeats its point: the zero-length line's round cap draws a dot.
  const lines = knownRuns(values).map((run) => ({
    line: (run.length === 1 ? [run[0], run[0]] : run)
      .map(
        ([i, v], j) =>
          `${j === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(26 - (v / max) * 23).toFixed(1)}`,
      )
      .join(""),
    lone: run.length === 1,
    from: (run[0][0] * step).toFixed(1),
    to: (run[run.length - 1][0] * step).toFixed(1),
  }));

  return (
    <svg
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="block h-7 w-full overflow-visible"
      style={{ "--series-color": color }}
    >
      {selected !== null && (
        <rect
          x={Math.max(0, selected * step - step / 2)}
          y={0}
          width={
            Math.min(100, selected * step + step / 2) -
            Math.max(0, selected * step - step / 2)
          }
          height={28}
          className="fill-foreground/10"
        />
      )}
      {lines.map(({ line, lone, from, to }) => (
        <g key={from}>
          {!lone && (
            <path
              d={`${line}L${to},28L${from},28Z`}
              fillOpacity={0.2}
              className="fill-(--series-color)"
            />
          )}
          <path
            d={line}
            fill="none"
            strokeWidth={lone ? 4 : 1.5}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            className="stroke-(--series-color)"
          />
        </g>
      ))}
    </svg>
  );
}

// The tween lives here, so only this row repaints while the values count.
function UsageStats({
  bins,
  binCosts,
  selected,
  scope,
  estimatedCost,
  unpriced,
  modelFilter,
  modelsTotal,
  averages,
  metric,
  onMetric,
}: {
  bins: Counters[];
  binCosts: number[];
  selected: number | null;
  scope: Counters;
  estimatedCost: number;
  unpriced: number;
  modelFilter: string[] | null;
  modelsTotal: number;
  averages: PerTaskAverages;
  metric: PerTaskMetric | null;
  onMetric: (metric: PerTaskMetric) => void;
}): React.JSX.Element {
  const modelsShown = modelFilter?.length ?? modelsTotal;
  const target = useMemo(
    () => [
      [
        scope.totalTokens,
        estimatedCost,
        scope.invocations,
        scope.modelCalls,
        perTask(estimatedCost, scope.invocations),
        perTask(scope.modelCalls, scope.invocations),
        perTask(scope.totalTokens, scope.invocations),
      ],
    ],
    [scope, estimatedCost],
  );
  const values = useTween(target)[0];
  const columns = [
    {
      label: "Tokens",
      value: formatNumber(values[0]),
      detail: `${percent(scope.cachedInputTokens, scope.inputTokens)} served from cache`,
      trend: bins.map((b) => b.totalTokens),
      color: "var(--color-usage-input)",
    },
    {
      label: "Estimated cost",
      value: formatUsd(values[1]),
      detail:
        unpriced > 0
          ? `${unpriced} model${unpriced === 1 ? "" : "s"} not priced`
          : `${modelsShown} of ${modelsTotal} models`,
      trend: binCosts,
      color: "var(--color-usage-output)",
      help: "Each model's tokens at its public per-million USD rate. An estimate for comparing runs, not the bill from your provider.",
    },
    {
      label: "Tasks",
      value: formatNumber(values[2]),
      detail:
        scope.invocations > 0
          ? `${formatMs(perTask(scope.runtimeWallMs, scope.invocations))} average run`
          : "No runs",
      trend: bins.map((b) => b.invocations),
      color: "var(--color-usage-tasks)",
      help: "Agent runs that finished in this window, a subagent's run counted on its own. With all models shown, a run still going is added from the live trace for its first 20 minutes.",
    },
    {
      label: "Model calls",
      value: formatNumber(values[3]),
      detail: `${perTask(scope.modelCalls, scope.invocations).toFixed(1)} per task`,
      trend: bins.map((b) => b.modelCalls),
      color: "var(--color-usage-model-calls)",
    },
  ];
  const modelsDetail =
    unpriced > 0
      ? `${unpriced} model${unpriced === 1 ? "" : "s"} not priced`
      : `${modelsShown} of ${modelsTotal} models`;
  const perTaskColumns: Array<{
    metric: PerTaskMetric;
    value: string;
    detail: string;
  }> = [
    { metric: "cost", value: formatUsd(values[4]), detail: modelsDetail },
    {
      metric: "calls",
      value: values[5].toFixed(1),
      detail: `${formatNumber(scope.invocations)} tasks`,
    },
    {
      metric: "tokens",
      value: formatNumber(values[6]),
      detail: "input and output, cache included",
    },
  ];

  return (
    <div className="@container">
      <div className="grid grid-cols-2 border-y border-border @2xl:grid-cols-4">
        {columns.map((column) => (
          <div
            key={column.label}
            className="grid min-w-0 gap-1 border-border px-4 py-3 @2xl:border-l @2xl:first:border-l-0"
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {column.label}
              {column.help && <HelpMark text={column.help} />}
            </div>
            <div className="text-2xl font-semibold whitespace-nowrap tabular-nums">
              {column.value}
            </div>
            <Sparkline
              values={column.trend}
              selected={selected}
              color={column.color}
            />
            <div className="truncate text-2xs text-muted-foreground">
              {column.detail}
            </div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 border-b border-border">
        {perTaskColumns.map((column) => {
          const series = PER_TASK_SERIES[column.metric];
          const active = metric === column.metric;

          return (
            <div
              key={column.metric}
              className={cn(
                "grid min-w-0 gap-1 border-l border-border px-4 py-3 transition-colors first:border-l-0",
                active && "bg-accent",
              )}
            >
              <div
                className={cn(
                  "flex items-center gap-2 text-xs",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {series.label}
                <HelpMark text={series.help} />
              </div>
              <button
                type="button"
                aria-pressed={active}
                aria-label={`${series.label}: ${column.value}, ${column.detail}`}
                onClick={() => onMetric(column.metric)}
                className="grid min-w-0 cursor-pointer gap-1 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <div className="text-2xl font-semibold whitespace-nowrap tabular-nums">
                  {column.value}
                </div>
                <Sparkline
                  values={averages[column.metric]}
                  selected={selected}
                  color={series.color}
                />
                <div className="truncate text-2xs text-muted-foreground">
                  {column.detail}
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UsageToolbar({
  range,
  onRangeChange,
  modelMenu,
  selectedStart,
  binSeconds,
  onClearSelection,
}: {
  range: Range;
  onRangeChange: (range: Range) => void;
  modelMenu: React.ReactNode;
  selectedStart: number | null;
  binSeconds: number;
  onClearSelection: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl
        options={RANGES}
        value={range}
        onChange={onRangeChange}
        ariaLabel="Time range"
      />
      {modelMenu}
      {selectedStart !== null && (
        <button
          type="button"
          onClick={onClearSelection}
          className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-xs tabular-nums"
        >
          {formatBucketLabel(selectedStart, binSeconds, true)}{" "}
          <span className="text-muted-foreground">✕</span>
        </button>
      )}
    </div>
  );
}

function binDetail(bin: Counters): string {
  return `${formatNumber(bin.invocations)} tasks · ${formatNumber(bin.modelCalls)} calls · ${formatNumber(bin.totalTokens)} tok`;
}

function colorModels(buckets: Bucket[]): Map<string, string> {
  const keys = [...new Set(buckets.map(modelKey))].sort();

  return new Map(
    keys.map((key, i) => [key, SERIES_COLORS[i % SERIES_COLORS.length]]),
  );
}

function emptyCounters(bucketStart: number): Counters {
  return {
    bucketStart: bucketStart,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    invocations: 0,
    modelCalls: 0,
    runtimeWallMs: 0,
  };
}

function fillBucketsAcrossRange(
  merged: Counters[],
  binSeconds: number,
  rangeSeconds: number,
  now: number = Date.now(),
): Counters[] {
  if (!binSeconds) return merged;
  const binMs = binSeconds * 1000;
  const indexed = new Map(
    merged.map((b) => [Math.floor(b.bucketStart / binMs) * binMs, b]),
  );
  const out = bucketStartsAcrossRange(binSeconds, rangeSeconds, now).map(
    (t) => indexed.get(t) ?? emptyCounters(t),
  );

  return out;
}

function formatMs(ms: number): string {
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(2)}s`;

  return `${Math.round(ms)}ms`;
}

// A call counts under its running root span, not the trace a subtask shares, so a
// finished subtask stops counting once its usage row lands: no double count.
function liveOverlayFromTraces(spans: ObservabilitySpanRow[]): LiveOverlay {
  const freshAfter = Date.now() - STALE_RUNNING_TASK_MS;
  const runningRoots = spans.filter(
    (span) =>
      isRootSpanKind(span.kind) &&
      span.status === "running" &&
      span.startTimeMs >= freshAfter,
  );
  if (runningRoots.length === 0) return EMPTY_LIVE_OVERLAY;
  const runningRootsById = new Map(
    runningRoots.map((root) => [root.spanId, root]),
  );
  const totals = { ...EMPTY_LIVE_OVERLAY };
  totals.invocations = runningRoots.length;
  const modelUsage: ModelUsage[] = [];
  for (const span of spans) {
    const root = span.parentSpanId
      ? runningRootsById.get(span.parentSpanId)
      : undefined;
    if (!isModelCallSpan(span) || !root) continue;
    const usage = stepTokens(span);
    const model = runModel(root);
    // Calls are steps, as on the usage row (`stepCount`); a compaction only adds tokens.
    if (span.kind === "model.step") totals.modelCalls += 1;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.reasoningTokens += numberAttribute(span, "model.reasoning_tokens");
    totals.cachedInputTokens += usage.cachedInputTokens;
    totals.cacheWriteTokens += usage.cacheWriteTokens;
    if (model) modelUsage.push({ ...model, ...usage });
  }
  totals.modelUsage = modelUsage;

  return totals;
}

function mergeByBucket(buckets: Bucket[]): Counters[] {
  const map = new Map<number, Counters>();
  for (const b of buckets) {
    let merged = map.get(b.bucketStart);
    if (!merged) {
      merged = emptyCounters(b.bucketStart);
      map.set(b.bucketStart, merged);
    }
    for (const key of COUNTER_KEYS) merged[key] += b[key];
  }

  return Array.from(map.values()).sort((a, b) => a.bucketStart - b.bucketStart);
}

function perTask(n: number, tasks: number): number {
  return tasks > 0 ? n / tasks : 0;
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
}

function sumCounters(bins: Counters[]): Counters {
  const total = emptyCounters(bins[0]?.bucketStart ?? 0);
  for (const b of bins) {
    for (const key of COUNTER_KEYS) total[key] += b[key];
  }

  return total;
}

// The SDK's outputTokens already includes reasoning, so the total is input + output.
function withLiveOverlay(bins: Counters[], live: LiveOverlay): Counters[] {
  if (bins.length === 0 || live.invocations === 0) return bins;
  const last = bins[bins.length - 1];
  const next = bins.slice();
  next[next.length - 1] = {
    ...last,
    inputTokens: last.inputTokens + live.inputTokens,
    outputTokens: last.outputTokens + live.outputTokens,
    reasoningTokens: last.reasoningTokens + live.reasoningTokens,
    cachedInputTokens: last.cachedInputTokens + live.cachedInputTokens,
    cacheWriteTokens: last.cacheWriteTokens + live.cacheWriteTokens,
    totalTokens: last.totalTokens + live.inputTokens + live.outputTokens,
    invocations: last.invocations + live.invocations,
    modelCalls: last.modelCalls + live.modelCalls,
  };

  return next;
}
