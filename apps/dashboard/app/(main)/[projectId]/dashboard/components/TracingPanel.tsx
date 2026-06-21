"use client";

/** Tracing panel: full-height task timelines with an indented span tree, a waterfall bar column, and model/tool span details. */
import { Badge } from "@/app/components/ui/badge";
import { cn } from "@/app/lib/utils";
import {
  useObservabilityStream,
  type ObservabilitySpanRow,
} from "@/app/hooks/useObservabilityStream";
import {
  CheckCircle,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  MinusCircle,
  XCircle,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { ObservabilityToolbar, type ToolbarFilterOption } from "./ObservabilityToolbar";

interface Props {
  projectSlug: string | undefined;
  environmentSlug: string | undefined;
  apiKey: string | undefined;
}

type StatusFilter = "all" | ObservabilitySpanRow["status"];

const STATUS_FILTER_OPTIONS: ToolbarFilterOption[] = [
  { value: "all", label: "All statuses" },
  { value: "running", label: "running" },
  { value: "ok", label: "ok" },
  { value: "error", label: "error" },
];

const DETAIL_ATTRIBUTES = [
  "model.input",
  "model.reasoning",
  "model.response",
  "model.tool_calls",
  "model.tool_results",
  "tool.input",
  "tool.output",
] as const;

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;

  return `${ms}ms`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Parse a datetime-local input value into epoch ms, or null when empty/invalid. */
function toEpochMs(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();

  return Number.isFinite(ms) ? ms : null;
}

function displayAttribute(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return value;
    }
  }

  return value;
}

function numericAttribute(span: ObservabilitySpanRow, key: string): number | undefined {
  const value = span.attributes?.[key];

  return typeof value === "number" ? value : undefined;
}

function spanKey(span: ObservabilitySpanRow): string {
  return `${span.traceId}:${span.spanId}`;
}

/** A live "running" span under a task that already finished never reported its end. */
function isStale(span: ObservabilitySpanRow, taskRunning: boolean): boolean {
  return span.status === "running" && !taskRunning;
}

/** Text color per span status — shared cue with the logs panel. */
function statusColor(status: ObservabilitySpanRow["status"]): string {
  if (status === "running") return "text-sky-400";
  if (status === "error") return "text-red-400";

  return "text-emerald-400";
}

/** Pill style per span kind so the hierarchy reads at a glance. */
function kindBadge(kind: ObservabilitySpanRow["kind"]): string {
  if (kind === "task") return "bg-violet-500/15 text-violet-300";
  if (kind === "model.step") return "bg-sky-500/15 text-sky-300";
  if (kind === "phase") return "bg-teal-500/15 text-teal-300";

  return "bg-amber-500/15 text-amber-300";
}

/** Solid waterfall-bar fill per kind; mirrors the badge hues. */
function kindBarColor(kind: ObservabilitySpanRow["kind"]): string {
  if (kind === "task") return "bg-violet-500/70";
  if (kind === "model.step") return "bg-sky-500/70";
  if (kind === "phase") return "bg-teal-500/70";

  return "bg-amber-500/70";
}

interface SpanGroup {
  root: ObservabilitySpanRow;
  childrenByParent: Map<string, ObservabilitySpanRow[]>;
  // Absolute time window the waterfall bars are scaled against (covers spans like
  // cold start that begin before the root task span).
  windowStart: number;
  windowSpan: number;
}

/** Group spans into per-task trees keyed by parent span, newest task first. */
function groupSpans(spans: ObservabilitySpanRow[]): SpanGroup[] {
  const tasks = spans.filter((span) => span.kind === "task");
  const childrenByTrace = new Map<string, ObservabilitySpanRow[]>();

  for (const span of spans) {
    if (span.kind === "task") continue;
    const children = childrenByTrace.get(span.traceId) ?? [];
    children.push(span);
    childrenByTrace.set(span.traceId, children);
  }

  return tasks
    .map((root) => {
      const children = childrenByTrace.get(root.traceId) ?? [];
      const spanIds = new Set([root.spanId, ...children.map((child) => child.spanId)]);
      const childrenByParent = new Map<string, ObservabilitySpanRow[]>();
      for (const child of children) {
        // Re-parent orphans (a parent that never arrived) onto the root so they
        // still render instead of disappearing.
        const parentId = child.parentSpanId && spanIds.has(child.parentSpanId)
          ? child.parentSpanId
          : root.spanId;
        const siblings = childrenByParent.get(parentId) ?? [];
        siblings.push(child);
        childrenByParent.set(parentId, siblings);
      }
      for (const siblings of childrenByParent.values()) {
        siblings.sort((left, right) => left.startTimeMs - right.startTimeMs);
      }

      const allSpans = [root, ...children];
      const taskRunning = root.status === "running";
      const windowStart = Math.min(...allSpans.map((span) => span.startTimeMs));
      const windowEnd = Math.max(
        ...allSpans.map((span) =>
          isStale(span, taskRunning) ? span.startTimeMs : span.endTimeMs,
        ),
      );

      return {
        root: root,
        childrenByParent: childrenByParent,
        windowStart: windowStart,
        windowSpan: Math.max(1, windowEnd - windowStart),
      };
    })
    .sort((left, right) => right.root.startTimeMs - left.root.startTimeMs);
}

function SpanStatusIcon({ span, taskRunning }: { span: ObservabilitySpanRow; taskRunning: boolean }) {
  if (isStale(span, taskRunning)) {
    return <MinusCircle className="size-3.5 shrink-0 text-muted-foreground/50" />;
  }
  if (span.status === "running") {
    return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-sky-400" />;
  }
  if (span.status === "error") {
    return <XCircle className="size-3.5 shrink-0 text-red-400" />;
  }

  return <CheckCircle className="size-3.5 shrink-0 text-emerald-400" />;
}

function spanLabel(span: ObservabilitySpanRow): string {
  if (span.kind === "tool.call") {
    const toolName = span.attributes?.["tool.name"];

    return typeof toolName === "string" ? `Tool: ${toolName}` : "Tool call";
  }
  if (span.kind === "model.step") {
    const stepNumber = span.attributes?.["agent.step_number"];

    return typeof stepNumber === "number" ? `Model step ${stepNumber + 1}` : "Model step";
  }
  if (span.kind === "phase") {
    const label = span.attributes?.["phase.name"];

    return typeof label === "string" ? label : span.name;
  }
  const taskId = span.attributes?.["task.id"];

  return typeof taskId === "string" ? taskId : span.traceId;
}

/**
 * One waterfall bar positioned within the task's time window. Model steps split
 * into a muted invoke-wait (time-to-first-token) segment and a solid streaming
 * segment so a slow step shows where the time went.
 */
function TimelineBar({
  span,
  windowStart,
  windowSpan,
  taskRunning,
}: {
  span: ObservabilitySpanRow;
  windowStart: number;
  windowSpan: number;
  taskRunning: boolean;
}) {
  const stale = isStale(span, taskRunning);
  const live = span.status === "running" && taskRunning;
  const end = live ? windowStart + windowSpan : Math.max(span.endTimeMs, span.startTimeMs);
  const leftPct = Math.min(100, Math.max(0, ((span.startTimeMs - windowStart) / windowSpan) * 100));
  const widthPct = Math.max(0.75, Math.min(((end - span.startTimeMs) / windowSpan) * 100, 100 - leftPct));

  const ttftMs = numericAttribute(span, "model.ttft_ms");
  const ttftFrac = ttftMs !== undefined && span.durationMs > 0 ? Math.min(1, ttftMs / span.durationMs) : 0;
  const title = `${spanLabel(span)} · ${formatDuration(span.durationMs)} · started ${formatTime(span.startTimeMs)}${
    ttftMs !== undefined ? ` · invoke wait ${formatDuration(ttftMs)}` : ""
  }`;

  return (
    <div className="relative h-4 w-full">
      <div
        className="absolute top-1/2 flex h-2 -translate-y-1/2 overflow-hidden rounded-sm"
        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        title={title}
      >
        {ttftFrac > 0 && (
          <div className="h-full shrink-0 bg-sky-500/25" style={{ width: `${ttftFrac * 100}%` }} />
        )}
        <div
          className={cn(
            "h-full flex-1",
            stale
              ? "bg-muted-foreground/25"
              : live
                ? cn(kindBarColor(span.kind), "animate-pulse")
                : kindBarColor(span.kind),
          )}
        />
      </div>
    </div>
  );
}

function SpanDetails({ span, depth }: { span: ObservabilitySpanRow; depth: number }) {
  const attributes = span.attributes ?? {};
  const ttftMs = numericAttribute(span, "model.ttft_ms");
  const streamMs = numericAttribute(span, "model.stream_ms");
  const details = DETAIL_ATTRIBUTES.flatMap((key) => {
    const value = displayAttribute(attributes[key]);

    return value ? [{ key: key, value: value }] : [];
  });
  const metadata = Object.entries(attributes).filter(
    ([key]) => !DETAIL_ATTRIBUTES.includes(key as (typeof DETAIL_ATTRIBUTES)[number]),
  );

  return (
    <div
      className="grid gap-3 border-l-2 border-border/50 bg-background/50 py-3 pr-4"
      style={{ paddingLeft: depth * 18 + 28 }}
    >
      {span.kind === "task" && (
        <div className="text-[11px] font-mono text-muted-foreground/70">
          trace: {span.traceId} · agent: {span.agentId ?? "unknown"} · {span.conversationKey ?? "no conversation"}
        </div>
      )}
      {span.kind === "model.step" && ttftMs !== undefined && (
        <div className="flex flex-wrap gap-4 text-[11px] font-mono text-muted-foreground">
          <span>
            invoke wait <span className="text-sky-300">{formatDuration(ttftMs)}</span>
          </span>
          {streamMs !== undefined && (
            <span>
              streaming <span className="text-sky-300">{formatDuration(streamMs)}</span>
            </span>
          )}
        </div>
      )}
      {span.error && (
        <div className="rounded border border-red-500/20 bg-red-950/20 p-2 text-xs text-red-400">
          {span.error}
        </div>
      )}
      {details.map(({ key, value }) => (
        <div key={key} className="grid gap-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {key.replaceAll(".", " ")}
          </div>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-card p-3 text-xs leading-relaxed text-foreground/90">
            {value}
          </pre>
        </div>
      ))}
      {metadata.length > 0 && (
        <div className="grid gap-x-4 gap-y-1 text-[11px] font-mono text-muted-foreground sm:grid-cols-2">
          {metadata.map(([key, value]) => (
            <div key={key} className="flex min-w-0 justify-between gap-3">
              <span className="truncate">{key}</span>
              <span className="max-w-[60%] truncate text-foreground/70" title={String(value)}>
                {String(value)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SpanRow({
  span,
  depth,
  hasChildren,
  isExpanded,
  onToggle,
  windowStart,
  windowSpan,
  taskRunning,
}: {
  span: ObservabilitySpanRow;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  windowStart: number;
  windowSpan: number;
  taskRunning: boolean;
}) {
  const isTask = span.kind === "task";
  const stale = isStale(span, taskRunning);

  return (
    <tr
      onClick={onToggle}
      className={cn(
        "cursor-pointer border-b border-border/40 transition-colors hover:bg-accent/20",
        isExpanded && "bg-accent/30",
        isTask && "font-medium",
      )}
    >
      <td className="py-1.5 pr-3" style={{ paddingLeft: depth * 18 + 12 }}>
        <span className="flex min-w-0 items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <SpanStatusIcon span={span} taskRunning={taskRunning} />
          <span className="min-w-0">
            <span className="block truncate" title={spanLabel(span)}>
              {spanLabel(span)}
            </span>
            {isTask && (
              <span className="block truncate text-[11px] font-normal text-muted-foreground">
                {span.agentId ?? "Unknown agent"} · {span.conversationKey ?? "No conversation"}
              </span>
            )}
          </span>
        </span>
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap">
        <Badge className={cn("px-1.5 py-0 text-[10px] uppercase tracking-wide", kindBadge(span.kind))}>
          {span.kind}
        </Badge>
      </td>
      <td
        className={cn(
          "px-3 py-1.5 whitespace-nowrap font-medium",
          stale ? "text-muted-foreground/60" : statusColor(span.status),
        )}
      >
        {stale ? "ended" : span.status}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap tabular-nums text-muted-foreground/80">
        {span.durationMs > 0 ? formatDuration(span.durationMs) : "—"}
      </td>
      <td className="px-3 py-1.5">
        <TimelineBar
          span={span}
          windowStart={windowStart}
          windowSpan={windowSpan}
          taskRunning={taskRunning}
        />
      </td>
    </tr>
  );
}

/** Recursively render a span row, its detail block, and its children when expanded. */
function renderSpanRows(
  span: ObservabilitySpanRow,
  depth: number,
  group: SpanGroup,
  expanded: Set<string>,
  toggle: (key: string) => void,
): ReactNode[] {
  const key = spanKey(span);
  const isExpanded = expanded.has(key);
  const children = group.childrenByParent.get(span.spanId) ?? [];
  const taskRunning = group.root.status === "running";
  const rows: ReactNode[] = [
    <SpanRow
      key={`row:${key}`}
      span={span}
      depth={depth}
      hasChildren={children.length > 0}
      isExpanded={isExpanded}
      onToggle={() => toggle(key)}
      windowStart={group.windowStart}
      windowSpan={group.windowSpan}
      taskRunning={taskRunning}
    />,
  ];

  if (isExpanded) {
    rows.push(
      <tr key={`detail:${key}`} className="border-b border-border/40 bg-background/30">
        <td colSpan={5} className="p-0">
          <SpanDetails span={span} depth={depth} />
        </td>
      </tr>,
    );
    for (const child of children) {
      rows.push(...renderSpanRows(child, depth + 1, group, expanded, toggle));
    }
  }

  return rows;
}

export function TracingPanel({ projectSlug, environmentSlug, apiKey }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");

  const { entries, status, error, refresh } = useObservabilityStream({
    stream: "traces",
    projectSlug: projectSlug,
    environmentSlug: environmentSlug,
    apiKey: apiKey,
    backfill: 100,
  });

  const fromMs = toEpochMs(fromTime);
  const toMs = toEpochMs(toTime);
  const hasFilters = filter.trim() !== "" || statusFilter !== "all" || fromMs !== null || toMs !== null;

  const groups = useMemo(() => {
    const allGroups = groupSpans(entries);
    const needle = filter.trim().toLowerCase();

    return allGroups.filter((group) => {
      const { root, childrenByParent } = group;
      if (statusFilter !== "all" && root.status !== statusFilter) return false;
      if (fromMs !== null && root.startTimeMs < fromMs) return false;
      if (toMs !== null && root.startTimeMs > toMs) return false;
      if (!needle) return true;

      const allSpans = [root, ...[...childrenByParent.values()].flat()];

      return allSpans.some((span) =>
        [
          span.name,
          span.kind,
          span.status,
          span.traceId,
          span.agentId ?? "",
          span.conversationKey ?? "",
          JSON.stringify(span.attributes ?? {}),
        ].some((value) => value.toLowerCase().includes(needle)),
      );
    });
  }, [entries, filter, statusFilter, fromMs, toMs]);

  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }

      return next;
    });
  };

  const clearFilters = () => {
    setFilter("");
    setStatusFilter("all");
    setFromTime("");
    setToTime("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <p className="shrink-0 text-xs text-muted-foreground">
        Task timelines with model input, reasoning, responses, tool calls, and tool results. Expand a task to walk its step tree; each model step bar shows invoke wait (lighter) then streaming.
      </p>

      <ObservabilityToolbar
        search={filter}
        onSearchChange={setFilter}
        searchPlaceholder={`Search ${groups.length} task${groups.length === 1 ? "" : "s"}…`}
        filterAriaLabel="Filter by status"
        filterValue={statusFilter}
        filterOptions={STATUS_FILTER_OPTIONS}
        onFilterChange={(value) => setStatusFilter(value as StatusFilter)}
        fromTime={fromTime}
        onFromTimeChange={setFromTime}
        toTime={toTime}
        onToTimeChange={setToTime}
        hasFilters={hasFilters}
        onClear={clearFilters}
        onRefresh={refresh}
        refreshDisabled={status === "idle"}
        refreshSpinning={status === "connecting"}
        refreshTitle={error ?? "Refresh from Tempo"}
        isError={status === "error"}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-xs font-mono table-fixed">
            <colgroup>
              <col className="w-[30%]" />
              <col className="w-[84px]" />
              <col className="w-[76px]" />
              <col className="w-[76px]" />
              <col />
            </colgroup>
            <thead className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur">
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground/80">
                <th className="px-3 py-2 font-medium">Task / Span</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Duration</th>
                <th className="px-3 py-2 font-medium">Timeline</th>
              </tr>
            </thead>
            <tbody>
              {groups.flatMap((group) =>
                renderSpanRows(group.root, 0, group, expanded, toggle),
              )}
              {groups.length === 0 && (
                <tr>
                  <td colSpan={5} className="h-32 text-center text-xs text-muted-foreground/60">
                    {entries.length === 0 ? "Waiting for traces…" : "No tasks match the current filters."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
