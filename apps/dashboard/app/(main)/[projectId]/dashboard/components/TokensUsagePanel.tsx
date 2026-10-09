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
import { useTween } from "@/app/hooks/useTween";
import { formatNumber } from "@/app/lib/formatNumber";
import {
  bucketStartsAcrossRange,
  formatAxisNumber,
  tokenParts,
} from "@/app/lib/usageChart";
import { parseAsEpochMs, parseAsModelKeys } from "@/app/lib/urlState";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { estimateModelTokenCost } from "@broods/convex/model/modelPricing";
import { useQuery } from "convex/react";
import { ChevronDownIcon } from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import { parseAsStringLiteral, useQueryStates } from "nuqs";
import { useMemo, useState } from "react";
import {
  formatBucketLabel,
  TOKEN_SERIES,
  UsageChart,
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
/** One time bin summed over the models shown. */
type Counters = Record<CounterKey, number> & { bucketStart: number };

interface Props {
  projectId: Id<"projects">;
  /** Active stage to scope usage to, or null for the whole project. */
  stageId: Id<"stages"> | null;
  /** Scope + key for the live trace overlay. Omitted = Convex-only (no overlay). */
  projectSlug?: string | undefined;
  stageSlug?: string | undefined;
  apiKey?: string | undefined;
}

interface LiveOverlay {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  // Running roots (tasks + subagent subtasks) and the model steps beneath them.
  invocations: number;
  modelCalls: number;
  // Each step priced at its root's model, so the cost grows with the tokens.
  estimatedCost: number;
}

const RANGE_SECONDS: Record<Range, number> = {
  "1h": 60 * 60,
  "3h": 3 * 60 * 60,
  "1d": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
  "1y": 365 * 24 * 60 * 60,
};

// Mirrors the server's bin sizing so the chart can render an empty (zero-bin)
// grid across the window before the first query resolves.
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

// The panel's view in the URL, so a link opens it: the `range`, the
// `models` filter (null shows every model) and the clicked `bin`, keyed by
// its start so it survives the window sliding.
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

const MODEL_COLORS = [
  "var(--color-usage-model-1)",
  "var(--color-usage-model-2)",
  "var(--color-usage-model-3)",
  "var(--color-usage-model-4)",
  "var(--color-usage-model-5)",
  "var(--color-usage-model-6)",
];

const EMPTY_LIVE_OVERLAY: LiveOverlay = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  invocations: 0,
  modelCalls: 0,
  estimatedCost: 0,
};

// A task still "running" past this likely never reported its terminal span
// (crash/freeze), so excluding it keeps a dead task from inflating the live total
// forever.
const STALE_RUNNING_TASK_MS = 20 * 60 * 1000;

/**
 * The dashboard Usage tab: the org's monthly allowance per resource, then the
 * stage's tokens: range and model filter, the numbers row, and the token
 * chart that splits to list a clicked bin's traces. Everything below the
 * toolbar follows the clicked bin.
 */
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

  // Reactive subscription: usage totals update live as the harness meters tokens.
  const data = useQuery(api.logs.fetchUsageStats, {
    projectId: projectId,
    stageId: stageId ?? undefined,
    range: range,
  });
  // Hold the last result while another range loads, so the chart morphs from
  // it instead of collapsing to an empty grid first. Only for the same
  // project and stage: another stage's numbers never show under this one.
  const scopeKey = `${projectId}:${stageId ?? ""}`;
  const [held, setHeld] = useState<{ key: string; stats: UsageStats } | null>(
    null,
  );
  if (data !== undefined && data !== held?.stats) {
    setHeld({ key: scopeKey, stats: data });
  }
  const stats = data ?? (held?.key === scopeKey ? held.stats : null);

  // Convex only records usage at task finalize, so a run in flight needs the
  // trace stream to show anything at all. See liveOverlayFromTraces.
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

  const shownRange = stats?.range ?? range;
  const binSeconds = stats?.binSeconds ?? RANGE_BIN_SECONDS[range];
  const binMs = binSeconds * 1000;
  const modelColors = useMemo(() => colorModels(stats?.buckets ?? []), [stats]);
  // The filter applied to what this range and stage have: models that did not
  // run here drop out, and none or all left reads as the unfiltered view.
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
  // Priced per model, since each model has its own rates, then summed per
  // bin so the cost trend line lines up with the chart. The live overlay's
  // cost joins the newest bin whenever the tokens include it.
  const { binCosts, estimatedCost, unpriced } = useMemo(() => {
    const byStart = new Map<number, number>();
    const unpricedModels = new Set<string>();
    for (const b of stats?.buckets ?? []) {
      if (activeFilter !== null && !activeFilter.includes(modelKey(b)))
        continue;
      const cost = estimateModelTokenCost(b.modelProvider, b.modelId, b);
      if (cost === null) unpricedModels.add(modelKey(b));
      const start = Math.floor(b.bucketStart / binMs) * binMs;
      byStart.set(start, (byStart.get(start) ?? 0) + (cost?.total ?? 0));
    }
    const costs = bucketStarts.map((start) => byStart.get(start) ?? 0);
    if (activeFilter === null && costs.length > 0) {
      costs[costs.length - 1] += liveOverlay.estimatedCost;
    }

    return {
      binCosts: costs,
      estimatedCost:
        selected === null
          ? costs.reduce((total, cost) => total + cost, 0)
          : costs[selected],
      unpriced: unpricedModels.size,
    };
  }, [stats, activeFilter, binMs, bucketStarts, selected, liveOverlay]);

  const selectBin = (index: number): void =>
    setSelectedStart(index === selected ? null : bucketStarts[index]);
  // Checkbox semantics: a click adds or removes one model.
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
      <AllowanceUsage />
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
          // Only while that bin is still on the chart; the live window slides.
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
        />

        <div
          className={cn(
            "grid rounded-lg border border-border bg-card",
            selected !== null && "lg:grid-cols-3",
          )}
        >
          <div className={cn("p-3", selected !== null && "lg:col-span-2")}>
            <UsageChart
              kind="area"
              height={400}
              series={TOKEN_SERIES}
              rows={tokenRows}
              bucketStarts={bucketStarts}
              binSeconds={binSeconds}
              selected={selected}
              onSelect={selectBin}
              formatAxis={formatAxisNumber}
              formatValue={formatNumber}
            />
            <Legend series={TOKEN_SERIES} />
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
              onClose={() => setSelectedStart(null)}
            />
          )}
        </div>
      </section>
    </div>
  );
}

/** Swatch and label per series, under each chart. */
function Legend({ series }: { series: UsageChartSeries[] }): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-3 pt-2 text-2xs text-muted-foreground">
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

/** Model filter as one checkbox menu, so the toolbar never wraps however many models ran. */
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

/** A small trend line for one number across the range, marking the clicked bin. */
function Sparkline({
  values,
  selected,
  color,
}: {
  values: number[];
  selected: number | null;
  color: string;
}): React.JSX.Element {
  const max = Math.max(0, ...values) || 1;
  const step = values.length > 1 ? 100 / (values.length - 1) : 100;
  const line = values
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(26 - (v / max) * 23).toFixed(1)}`,
    )
    .join("");

  return (
    <svg
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="block h-7 w-full"
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
      <path
        d={`${line}L100,28L0,28Z`}
        fillOpacity={0.2}
        className="fill-(--series-color)"
      />
      <path
        d={line}
        fill="none"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        className="stroke-(--series-color)"
      />
    </svg>
  );
}

/**
 * The numbers row for the range or the clicked bin: four evenly spaced
 * columns, each a large value over a trend line in the chart's colours and
 * one detail line. A column whose number is not what its label suggests
 * carries a "?" with what it counts. Laid out by its own width, not the window's; values count
 * to their new number here, so only this row repaints during the tween.
 */
function UsageStats({
  bins,
  binCosts,
  selected,
  scope,
  estimatedCost,
  unpriced,
  modelFilter,
  modelsTotal,
}: {
  bins: Counters[];
  binCosts: number[];
  selected: number | null;
  scope: Counters;
  estimatedCost: number;
  unpriced: number;
  /** Model keys shown, or null for every model. */
  modelFilter: string[] | null;
  modelsTotal: number;
}): React.JSX.Element {
  const modelsShown = modelFilter?.length ?? modelsTotal;
  const target = useMemo(
    () => [
      [scope.totalTokens, estimatedCost, scope.invocations, scope.modelCalls],
    ],
    [scope, estimatedCost],
  );
  const values = useTween(target)[0];
  const perTask = (n: number): number =>
    scope.invocations > 0 ? n / scope.invocations : 0;
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
          ? `${formatMs(perTask(scope.runtimeWallMs))} average run`
          : "No runs",
      trend: bins.map((b) => b.invocations),
      color: "var(--color-usage-tasks)",
      help: "Agent runs that finished in this window, a subagent's run counted on its own. A run still going is added from the live trace for its first 20 minutes.",
    },
    {
      label: "Model calls",
      value: formatNumber(values[3]),
      detail: `${perTask(scope.modelCalls).toFixed(1)} per task`,
      trend: bins.map((b) => b.modelCalls),
      color: "var(--color-usage-model-calls)",
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
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
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
    </div>
  );
}

/** Range buttons, the model menu, and a chip that clears the clicked bin. */
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
  /** Start of the clicked bin, or null when none is selected. */
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

/** Stable color per model: models sorted by key take the palette in order. */
function colorModels(buckets: Bucket[]): Map<string, string> {
  const keys = [...new Set(buckets.map(modelKey))].sort();

  return new Map(
    keys.map((key, i) => [key, MODEL_COLORS[i % MODEL_COLORS.length]]),
  );
}

/** A zeroed bin, for gaps in the range and as the start of a sum. */
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

/**
 * Fill the selected time window with zero-valued bins so the X-axis spans
 * the full range (1h shows the whole hour, 1d shows the whole day, etc.).
 * Existing populated bins are merged in at their aligned timestamps.
 */
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
 * In-progress overlay taken straight off the live trace stream: Convex usage is
 * only written when a task finalizes, so a long run would otherwise show nothing
 * until it ends. Each model step is scoped to its own root span (a task, a cron
 * run, or a subagent subtask, which share the parent's traceId) so a finished
 * subtask stops counting the moment its usage row lands in Convex, with no double
 * counting.
 */
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
  for (const span of spans) {
    const root = span.parentSpanId
      ? runningRootsById.get(span.parentSpanId)
      : undefined;
    if (span.kind !== "model.step" || !root) continue;
    const usage = {
      inputTokens: numericAttribute(span, "model.input_tokens"),
      outputTokens: numericAttribute(span, "model.output_tokens"),
      cachedInputTokens: numericAttribute(span, "model.cached_input_tokens"),
      cacheWriteTokens: 0,
    };
    const { "model.provider": provider, "model.id": modelId } =
      root.attributes ?? {};
    totals.modelCalls += 1;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.reasoningTokens += numericAttribute(span, "model.reasoning_tokens");
    totals.cachedInputTokens += usage.cachedInputTokens;
    if (typeof provider === "string" && typeof modelId === "string") {
      totals.estimatedCost +=
        estimateModelTokenCost(provider, modelId, usage)?.total ?? 0;
    }
  }

  return totals;
}

/** Merge per-(model, provider) rows into one aggregate per time bucket. */
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

/** `provider::model`, the key the model filter, its colors and the trace query share. */
function modelKey(b: { modelProvider: string; modelId: string }): string {
  return `${b.modelProvider}::${b.modelId}`;
}

function numericAttribute(span: ObservabilitySpanRow, key: string): number {
  const value = span.attributes?.[key];

  return typeof value === "number" ? value : 0;
}

/** Whole-number share for the numbers row, 0% when empty. */
function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
}

/** Totals across bins: the whole range, or the one clicked bin. */
function sumCounters(bins: Counters[]): Counters {
  const total = emptyCounters(bins[0]?.bucketStart ?? 0);
  for (const b of bins) {
    for (const key of COUNTER_KEYS) total[key] += b[key];
  }

  return total;
}

/**
 * Fold in-progress tokens and task/model counts into the most
 * recent bin so the charts and tiles grow while a run is in flight. The SDK's
 * outputTokens already includes reasoning, so the total is input + output.
 */
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
    totalTokens: last.totalTokens + live.inputTokens + live.outputTokens,
    invocations: last.invocations + live.invocations,
    modelCalls: last.modelCalls + live.modelCalls,
  };

  return next;
}
