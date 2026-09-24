"use client";

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
  formatAxisNumber,
  tokenParts,
  type TokenParts,
} from "@/app/lib/usageChart";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import {
  estimateModelTokenCost,
  type ModelCostEstimate,
} from "@broods/convex/model/modelPricing";
import { useQuery } from "convex/react";
import { ChevronDownIcon } from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import { useMemo, useState } from "react";
import { UsageChart, type UsageChartSeries } from "./UsageChart";
import { UsageTraceRail } from "./UsageTraceRail";

type UsageStats = FunctionReturnType<typeof api.logs.fetchUsageStats>;
type Range = UsageStats["range"];
type Bucket = UsageStats["buckets"][number];
type CounterKey = Exclude<
  keyof Bucket,
  "bucketStart" | "modelProvider" | "modelId"
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
  agentSandboxCpuUsec: number;
  toolSandboxCpuUsec: number;
}

interface ModelRow extends Bucket {
  key: string;
  color: string;
  estimatedCost: ModelCostEstimate | null;
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

const RANGES: Range[] = ["1h", "3h", "1d", "7d", "30d", "1y"];

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
  "agentSandboxCpuUsec",
  "toolSandboxCpuUsec",
];

// Stacked bottom to top. The parts add up to totalTokens; see tokenParts.
const TOKEN_SERIES: Array<UsageChartSeries & { key: keyof TokenParts }> = [
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

// Sandbox CPU split: the agent's own sandbox vs the MCP sandbox that runs
// hosted MCP server bundles.
const CPU_SERIES: UsageChartSeries[] = [
  {
    key: "agentSandboxCpuUsec",
    label: "Agent sandbox",
    color: "var(--color-usage-agent-sandbox)",
  },
  {
    key: "toolSandboxCpuUsec",
    label: "MCP sandbox",
    color: "var(--color-usage-mcp-sandbox)",
  },
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
  agentSandboxCpuUsec: 0,
  toolSandboxCpuUsec: 0,
};

// A task still "running" past this likely never reported its terminal span
// (crash/freeze), so excluding it keeps a dead task from inflating the live total
// forever.
const STALE_RUNNING_TASK_MS = 20 * 60 * 1000;

/**
 * The dashboard Usage tab: range and model filter, headline tiles, the token
 * chart with a trace rail for the clicked bin, then per-model totals beside
 * sandbox CPU. Everything below the toolbar follows the clicked bin.
 */
export function TokensUsagePanel({
  projectId,
  stageId,
  projectSlug,
  stageSlug,
  apiKey,
}: Props): React.JSX.Element {
  const [range, setRange] = useState<Range>("1h");
  // Model keys to show; null shows every model.
  const [modelFilter, setModelFilter] = useState<string[] | null>(null);
  // Keyed by bin start, not index, so the selection survives the window sliding.
  const [selectedStart, setSelectedStart] = useState<number | null>(null);

  // Reactive subscription: usage totals update live as the harness meters tokens.
  const data = useQuery(api.logs.fetchUsageStats, {
    projectId: projectId,
    stageId: stageId ?? undefined,
    range: range,
  });
  // Hold the last result while another range loads, so the chart morphs from
  // it instead of collapsing to an empty grid first.
  const [held, setHeld] = useState<UsageStats | null>(null);
  if (data !== undefined && data !== held) setHeld(data);
  const stats = data ?? held;

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
  const isShown = (key: string): boolean =>
    modelFilter === null || modelFilter.includes(key);
  const bins = useMemo(() => {
    const shown = (stats?.buckets ?? []).filter(
      (b) => modelFilter === null || modelFilter.includes(modelKey(b)),
    );
    const filled = fillBucketsAcrossRange(
      mergeByBucket(shown),
      binSeconds,
      RANGE_SECONDS[shownRange],
    );
    // The live overlay has no per-model split, so it only joins the unfiltered view.
    return modelFilter === null ? withLiveOverlay(filled, liveOverlay) : filled;
  }, [stats, modelFilter, binSeconds, shownRange, liveOverlay]);
  const bucketStarts = useMemo(() => bins.map((b) => b.bucketStart), [bins]);
  const tokenRows = useMemo(
    () =>
      bins.map((b) => {
        const parts = tokenParts(b);

        return TOKEN_SERIES.map((s) => parts[s.key]);
      }),
    [bins],
  );
  const cpuRows = useMemo(
    () => bins.map((b) => [b.agentSandboxCpuUsec, b.toolSandboxCpuUsec]),
    [bins],
  );
  const selectedIndex =
    selectedStart === null ? -1 : bucketStarts.indexOf(selectedStart);
  const selected = selectedIndex === -1 ? null : selectedIndex;
  const scope = useMemo(
    () => sumCounters(selected === null ? bins : [bins[selected]]),
    [bins, selected],
  );
  const models = useMemo((): ModelRow[] => {
    const inScope = (stats?.buckets ?? []).filter(
      (b) =>
        selected === null ||
        Math.floor(b.bucketStart / binMs) * binMs === bucketStarts[selected],
    );

    return aggregateByModel(inScope).map((b) => ({
      ...b,
      key: modelKey(b),
      color: modelColors.get(modelKey(b)) ?? MODEL_COLORS[0],
      estimatedCost: estimateModelTokenCost(b.modelProvider, b.modelId, b),
    }));
  }, [stats, selected, binMs, bucketStarts, modelColors]);
  const shownModels = models.filter((m) => isShown(m.key));
  const estimatedCost = shownModels.reduce(
    (total, m) => total + (m.estimatedCost?.total ?? 0),
    0,
  );
  const unpriced = shownModels.filter((m) => m.estimatedCost === null).length;

  const selectBin = (index: number): void =>
    setSelectedStart(index === selected ? null : bucketStarts[index]);
  // Checkbox semantics: a click adds or removes one model. Every model shown,
  // or none left, reads as the unfiltered view.
  const toggleModel = (key: string): void =>
    setModelFilter((current) => {
      const shown = current ?? [...modelColors.keys()];
      const next = shown.includes(key)
        ? shown.filter((k) => k !== key)
        : [...shown, key];

      return next.length === 0 || next.length === modelColors.size
        ? null
        : next;
    });

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5">
          {RANGES.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={range === id}
              onClick={() => {
                setRange(id);
                setSelectedStart(null);
              }}
              className={cn(
                "cursor-pointer rounded px-2.5 py-1 text-xs transition-colors",
                range === id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {id}
            </button>
          ))}
        </div>
        <ModelMenu
          modelColors={modelColors}
          allShown={modelFilter === null}
          isShown={isShown}
          onToggle={toggleModel}
          onShowAll={() => setModelFilter(null)}
        />
        {selected !== null && (
          <button
            type="button"
            onClick={() => setSelectedStart(null)}
            className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-xs tabular-nums"
          >
            {new Date(bucketStarts[selected]).toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}{" "}
            <span className="text-muted-foreground">✕</span>
          </button>
        )}
      </div>

      <UsageStats
        scope={scope}
        estimatedCost={estimatedCost}
        unpriced={unpriced}
      />

      <div className="grid rounded-lg border border-border bg-card lg:grid-cols-3">
        <div className="p-3 lg:col-span-2">
          <UsageChart
            kind="area"
            height={250}
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
        <UsageTraceRail
          projectId={projectId}
          stageId={stageId}
          bin={
            selected === null
              ? null
              : { startMs: bucketStarts[selected], binSeconds: binSeconds }
          }
          binTokens={selected === null ? 0 : bins[selected].totalTokens}
          isModelShown={(provider, id) => isShown(`${provider}::${id}`)}
          onClear={() => setSelectedStart(null)}
        />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-5">
        <ModelTable
          models={models}
          isShown={isShown}
          onToggle={toggleModel}
          className="lg:col-span-3"
        />
        <div className="rounded-lg border border-border bg-card p-3 lg:col-span-2">
          <h3 className="mb-2 text-xs font-medium">Sandbox CPU</h3>
          <UsageChart
            kind="bars"
            height={112}
            tickCount={2}
            series={CPU_SERIES}
            rows={cpuRows}
            bucketStarts={bucketStarts}
            binSeconds={binSeconds}
            selected={selected}
            onSelect={selectBin}
            formatAxis={formatCpuUsec}
            formatValue={formatCpuUsec}
          />
          <Legend series={CPU_SERIES} />
        </div>
      </div>
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

/** Per-model totals for the range or clicked bin; the model name toggles the filter. */
function ModelTable({
  models,
  isShown,
  onToggle,
  className,
}: {
  models: ModelRow[];
  isShown: (key: string) => boolean;
  onToggle: (key: string) => void;
  className: string;
}): React.JSX.Element {
  const shownTotal =
    models.reduce((t, m) => t + (isShown(m.key) ? m.totalTokens : 0), 0) || 1;

  return (
    <div
      className={cn(
        "overflow-x-auto rounded-lg border border-border bg-card",
        className,
      )}
    >
      <table className="w-full min-w-120 text-xs">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="w-1/5 px-3 py-2 font-medium">Share</th>
            <th className="px-3 py-2 text-right font-medium">Tokens</th>
            <th className="px-3 py-2 text-right font-medium">Cache hit</th>
            <th className="px-3 py-2 text-right font-medium">Calls</th>
            <th className="px-3 py-2 text-right font-medium">Est. cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border tabular-nums">
          {models.length === 0 && (
            <tr>
              <td
                colSpan={6}
                className="px-3 py-6 text-center text-muted-foreground"
              >
                Waiting for model activity…
              </td>
            </tr>
          )}
          {models.map((m) => (
            <tr
              key={m.key}
              className={cn(
                "transition-opacity",
                !isShown(m.key) && "opacity-40",
              )}
            >
              <td className="px-3 py-2">
                <button
                  type="button"
                  title="Show or hide this model"
                  onClick={() => onToggle(m.key)}
                  className="flex cursor-pointer items-center gap-1.5 text-left whitespace-nowrap"
                >
                  <span
                    className="size-2 shrink-0 rounded-sm bg-(--series-color)"
                    style={{ "--series-color": m.color }}
                  />
                  {m.modelId}
                  <span className="text-muted-foreground">
                    {m.modelProvider}
                  </span>
                </button>
              </td>
              <td className="px-3 py-2">
                <span className="sr-only">
                  {percent(isShown(m.key) ? m.totalTokens : 0, shownTotal)} of
                  tokens
                </span>
                <div
                  className="h-1.5 w-(--share) rounded-sm bg-(--series-color) transition-all duration-500"
                  style={{
                    "--share": `${isShown(m.key) ? (m.totalTokens / shownTotal) * 100 : 0}%`,
                    "--series-color": m.color,
                  }}
                />
              </td>
              <td className="px-3 py-2 text-right">
                {formatNumber(m.totalTokens)}
              </td>
              <td className="px-3 py-2 text-right">
                {percent(m.cachedInputTokens, m.inputTokens)}
              </td>
              <td className="px-3 py-2 text-right">
                {formatNumber(m.modelCalls)}
              </td>
              <td className="px-3 py-2 text-right">
                {m.estimatedCost
                  ? formatUsd(m.estimatedCost.total)
                  : "Unpriced"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The numbers row for the range or the clicked bin: tokens, cost and tasks
 * large, the rest small beside them. Laid out by its own width, not the
 * window's, and values count to their new number here so only this row
 * repaints during the tween.
 */
function UsageStats({
  scope,
  estimatedCost,
  unpriced,
}: {
  scope: Counters;
  estimatedCost: number;
  unpriced: number;
}): React.JSX.Element {
  const target = useMemo(
    () => [
      [
        scope.totalTokens,
        estimatedCost,
        scope.invocations,
        scope.cachedInputTokens,
        scope.modelCalls,
        scope.agentSandboxCpuUsec,
        scope.cacheWriteTokens,
        scope.runtimeWallMs,
        scope.toolSandboxCpuUsec,
      ],
    ],
    [scope, estimatedCost],
  );
  const values = useTween(target)[0];
  const headline: Array<[string, string]> = [
    ["Tokens", formatNumber(values[0])],
    ["Estimated cost", formatUsd(values[1])],
    ["Tasks", formatNumber(values[2])],
  ];
  const details: Array<[string, string]> = [
    [
      "Cache read",
      `${formatNumber(values[3])} · ${percent(scope.cachedInputTokens, scope.inputTokens)}`,
    ],
    ["Model calls", formatNumber(values[4])],
    ["Agent CPU", formatCpuUsec(values[5])],
    ["Cache write", formatNumber(values[6])],
    ["Runtime", formatMs(values[7])],
    ["MCP CPU", formatCpuUsec(values[8])],
  ];

  return (
    <div className="@container">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <div className="flex gap-8">
          {headline.map(([label, value]) => (
            <div key={label}>
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="text-2xl font-semibold whitespace-nowrap tabular-nums">
                {value}
              </div>
            </div>
          ))}
        </div>
        <dl className="grid w-full grid-cols-2 gap-x-6 gap-y-0.5 text-xs @lg:grid-cols-3 @5xl:w-auto @5xl:border-l @5xl:border-border @5xl:pl-8">
          {details.map(([label, value]) => (
            <div
              key={label}
              className="flex justify-between gap-3 whitespace-nowrap"
            >
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {unpriced > 0 && (
        <p className="mt-1 text-2xs text-muted-foreground">
          {unpriced} model{unpriced === 1 ? " is" : "s are"} left out of the
          estimate because no standard rate is configured.
        </p>
      )}
    </div>
  );
}

/** Per-(provider, model) totals, heaviest first. */
function aggregateByModel(buckets: Bucket[]): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const b of buckets) {
    const existing = map.get(modelKey(b));
    if (!existing) {
      map.set(modelKey(b), { ...b });
      continue;
    }
    for (const key of COUNTER_KEYS) existing[key] += b[key];
  }

  return Array.from(map.values()).sort((a, b) => b.totalTokens - a.totalTokens);
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
    agentSandboxCpuUsec: 0,
    toolSandboxCpuUsec: 0,
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
  const endMs = Math.ceil(now / binMs) * binMs;
  const startMs = endMs - rangeSeconds * 1000;
  const indexed = new Map(
    merged.map((b) => [Math.floor(b.bucketStart / binMs) * binMs, b]),
  );
  const out: Counters[] = [];
  for (let t = startMs; t < endMs; t += binMs) {
    out.push(indexed.get(t) ?? emptyCounters(t));
  }

  return out;
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
 * In-progress overlay taken straight off the live trace stream: Convex usage is
 * only written when a task finalizes, so a long run would otherwise show nothing
 * until it ends. Each model step is scoped to its own root span (a task, a cron
 * run, or a subagent subtask, which share the parent's traceId) so a finished
 * subtask stops counting the moment its usage row lands in Convex, with no double
 * counting. Sandbox CPU is read off the running roots, which the harness
 * re-publishes with live role-split CPU on each step.
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
  const runningRootSpanIds = new Set(runningRoots.map((root) => root.spanId));
  const totals = { ...EMPTY_LIVE_OVERLAY };
  totals.invocations = runningRoots.length;
  for (const root of runningRoots) {
    totals.agentSandboxCpuUsec += numericAttribute(
      root,
      "sandbox.cpu_usec.role.agent",
    );
    totals.toolSandboxCpuUsec += numericAttribute(
      root,
      "sandbox.cpu_usec.role.tool",
    );
  }
  for (const span of spans) {
    if (
      span.kind !== "model.step" ||
      !span.parentSpanId ||
      !runningRootSpanIds.has(span.parentSpanId)
    )
      continue;
    totals.modelCalls += 1;
    totals.inputTokens += numericAttribute(span, "model.input_tokens");
    totals.outputTokens += numericAttribute(span, "model.output_tokens");
    totals.reasoningTokens += numericAttribute(span, "model.reasoning_tokens");
    totals.cachedInputTokens += numericAttribute(
      span,
      "model.cached_input_tokens",
    );
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

/** `provider::model`, the key the filter, colors and table share. */
function modelKey(b: { modelProvider: string; modelId: string }): string {
  return `${b.modelProvider}::${b.modelId}`;
}

function numericAttribute(span: ObservabilitySpanRow, key: string): number {
  const value = span.attributes?.[key];

  return typeof value === "number" ? value : 0;
}

/** Whole-number share for the numbers row and model table, 0% when empty. */
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
 * Fold in-progress tokens, task/model counts, and sandbox CPU into the most
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
    agentSandboxCpuUsec: last.agentSandboxCpuUsec + live.agentSandboxCpuUsec,
    toolSandboxCpuUsec: last.toolSandboxCpuUsec + live.toolSandboxCpuUsec,
  };

  return next;
}
