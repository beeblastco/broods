"use client";

import { CopyRow } from "@/app/components/CopyButton";
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { SectionSummary } from "@/app/components/SectionSummary";
import { StatusDot } from "@/app/components/StatusDot";
import { Button } from "@/app/components/ui/button";
import {
  isRootSpanKind,
  useObservabilityStream,
  type ObservabilitySpanRow,
} from "@/app/hooks/useObservabilityStream";
import { agentEndpointPath, resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { formatNumber } from "@/app/lib/formatNumber";
import { formatDateTime, formatTime, toEpochMs } from "@/app/lib/formatTime";
import { cn } from "@/app/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  emptyStreamMessage,
  ObservabilityToolbar,
  type ToolbarFilterOption,
} from "./ObservabilityToolbar";

interface Props {
  projectSlug: string | undefined;
  stageSlug: string | undefined;
  apiKey: string | undefined;
}

// Task groups rendered before the "Load more" pager.
const PAGE_SIZE = 50;

type StatusFilter = "all" | ObservabilitySpanRow["status"];

// Outcome of one Continue click: in flight, or its result text.
interface ContinueNote {
  pending: boolean;
  text: string;
}

// One line in a span's Details section. Values read in mono (ids, counts,
// model ids) unless the row is `words`.
interface DetailRow {
  key: string;
  label: string;
  value: string;
  words?: true;
}

// One collapsible payload section, with the count line on its header.
interface PayloadSection extends DetailRow {
  summary: string;
}

const STATUS_FILTER_OPTIONS: ToolbarFilterOption[] = [
  { value: "all", label: "All statuses" },
  { value: "running", label: "running" },
  { value: "ok", label: "ok" },
  { value: "error", label: "error" },
];

// Collapsible payload sections. Each row shows the count that describes it, so
// Details never repeats those counts. The per-tool `tool.output` on each child
// span is the authoritative "what the model saw", so the step-level
// model.tool_results is left out as a confusing dupe.
const PAYLOAD_SECTIONS: ReadonlyArray<{
  charsKey?: string;
  countKey?: string;
  countLabel?: string;
  key: string;
  label: string;
}> = [
  {
    key: "model.system",
    label: "System prompt",
    countKey: "model.system_part_count",
    countLabel: "parts",
    charsKey: "model.system_chars",
  },
  {
    key: "agent.tools",
    label: "Tools",
    countKey: "agent.tool_count",
    countLabel: "tools",
  },
  {
    key: "model.input",
    label: "Model input",
    countKey: "agent.message_count",
    countLabel: "messages",
  },
  { key: "model.reasoning", label: "Reasoning" },
  { key: "model.response", label: "Response" },
  { key: "model.tool_calls", label: "Tool calls" },
  { key: "tool.input", label: "Tool input" },
  { key: "tool.output", label: "Tool output" },
];

// Context prepare loads, each timed on its own. They overlap, so they do not
// add up to the span.
const PREPARE_TIMINGS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "prepare.history_ms", label: "history" },
  { key: "prepare.runtime_ms", label: "runtime" },
  { key: "prepare.memory_ms", label: "memory" },
  { key: "prepare.skills_ms", label: "skills" },
  { key: "prepare.subagents_ms", label: "subagents" },
  { key: "prepare.media_ms", label: "media" },
];

interface DetailField {
  extraKey?: string;
  extraLabel?: string;
  key: string;
  label: string;
  words?: true;
}

// Token rows come in two spellings: the task root writes usage.*, a model step
// writes model.*.
const TOKEN_FIELDS: ReadonlyArray<DetailField> = [
  {
    key: "input_tokens",
    label: "Input tokens",
    extraKey: "cached_input_tokens",
    extraLabel: "cached",
  },
  {
    key: "output_tokens",
    label: "Output tokens",
    extraKey: "reasoning_tokens",
    extraLabel: "reasoning",
  },
];

// Labeled Details rows, shown when the span carries `key`; `extraKey` adds a
// second value after it.
const DETAIL_FIELDS: ReadonlyArray<DetailField> = [
  { key: "model.id", label: "Model" },
  { key: "model.provider", label: "Provider", words: true },
  { key: "task.delivery", label: "Delivery", words: true },
  { key: "agent.step_count", label: "Steps" },
  { key: "agent.tool_call_count", label: "Tool call count" },
  ...["usage", "model"].flatMap((prefix) =>
    TOKEN_FIELDS.map((field): DetailField => ({
      key: `${prefix}.${field.key}`,
      label: field.label,
      extraKey: `${prefix}.${field.extraKey}`,
      extraLabel: field.extraLabel,
    })),
  ),
  { key: "model.finish_reason", label: "Finish reason", words: true },
  { key: "tool.success", label: "Succeeded", words: true },
  { key: "task.id", label: "Task id" },
];

// Attribute keys the panel already shows as its title, header, a section row, a
// timing chip or a labeled Details row. Details lists every other key raw.
const SHOWN_KEYS: ReadonlySet<string> = new Set([
  ...PAYLOAD_SECTIONS.flatMap((section) => [
    section.key,
    section.countKey,
    section.charsKey,
  ]).filter((key): key is string => key !== undefined),
  ...DETAIL_FIELDS.flatMap((field) => [field.key, field.extraKey]).filter(
    (key): key is string => key !== undefined,
  ),
  ...PREPARE_TIMINGS.map((timing) => timing.key),
  "agent.model_id",
  "agent.model_provider",
  "agent.step_number",
  "model.reasoning_stream_ms",
  "model.stream_ms",
  "model.text_stream_ms",
  "model.tool_input_stream_ms",
  "model.tool_results",
  "model.tool_wait_ms",
  "model.total_tokens",
  "model.ttft_ms",
  "phase.duration_ms",
  "phase.name",
  "prepare.history_rows",
  "step.state",
  "task.input",
  "task.state",
  "tool.duration_ms",
  "tool.name",
  "tool.state",
  "usage.total_tokens",
]);

// Search text per span object, built on first search. See spanSearchText.
const SPAN_SEARCH_TEXT = new WeakMap<ObservabilitySpanRow, string>();

interface KindTheme {
  bar: string;
  // The muted word after a child span's name and in the detail header.
  word: string;
}

// One bar hue per span kind, checked for colorblind (protan/deutan) separation
// on both surfaces, including against the error red that can replace a root
// bar. Bars step deeper where a hue would wash out on one surface (task keeps
// violet-500 on dark: violet-400 collapses into model.step's blue-400 under
// deuteranopia).
const KIND_THEME: Record<ObservabilitySpanRow["kind"], KindTheme> = {
  task: { bar: "bg-violet-500/70", word: "task" },
  cron: { bar: "bg-amber-500/70 dark:bg-amber-300/70", word: "cron" },
  subtask: { bar: "bg-cyan-500/70 dark:bg-cyan-300/70", word: "subagent" },
  "model.step": { bar: "bg-blue-700/70 dark:bg-blue-400/70", word: "model" },
  "tool.call": { bar: "bg-orange-600/70 dark:bg-orange-500/70", word: "tool" },
  phase: { bar: "bg-teal-700/70 dark:bg-teal-500/70", word: "phase" },
};

// A root task/subtask still "running" past this likely never reported its
// terminal span (crash/freeze or a lost publish), so we treat it as finished.
// Otherwise it reads as running forever.
const TASK_MAX_RUNTIME_MS = 16 * 60 * 1000;

interface SpanGroup {
  root: ObservabilitySpanRow;
  childrenByParent: Map<string, ObservabilitySpanRow[]>;
  // Root first, then every child, for search and selection.
  spans: ObservabilitySpanRow[];
  // Absolute time window the waterfall bars are scaled against (covers spans like
  // cold start that begin before the root task span).
  windowStart: number;
  windowSpan: number;
  // Effective task duration used to size the top-level bar on a scale shared
  // across tasks, so a longer task always reads as a longer bar. Running tasks
  // fall back to elapsed window so their bar grows as steps stream in.
  taskDurationMs: number;
}

export function TracingPanel({
  projectSlug,
  stageSlug,
  apiKey,
}: Props): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const focusTraceId = searchParams.get("trace");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const { entries, status, history, error, refresh, fetchTrace } =
    useObservabilityStream({
      stream: "traces",
      projectSlug: projectSlug,
      stageSlug: stageSlug,
      apiKey: apiKey,
      backfill: 100,
    });

  const fromMs = toEpochMs(fromTime);
  const toMs = toEpochMs(toTime);
  const hasFilters =
    filter.trim() !== "" ||
    statusFilter !== "all" ||
    fromMs !== null ||
    toMs !== null;

  // Every task in the buffer, before filters. Focus resolution runs against
  // this so a filtered-out trace is never mistaken for one absent from history.
  const allGroups = useMemo(() => groupSpans(entries), [entries]);

  // The filter runs on the deferred value, so typing stays responsive while a
  // full buffer is searched.
  const deferredFilter = useDeferredValue(filter);
  const groups = useMemo(() => {
    const needle = deferredFilter.trim().toLowerCase();

    return allGroups.filter((group) => {
      const { root, spans } = group;
      if (statusFilter !== "all" && root.status !== statusFilter) return false;
      if (fromMs !== null && root.startTimeMs < fromMs) return false;
      if (toMs !== null && root.startTimeMs > toMs) return false;

      return (
        !needle || spans.some((span) => spanSearchText(span).includes(needle))
      );
    });
  }, [allGroups, deferredFilter, statusFilter, fromMs, toMs]);

  // Shared duration scale for the top-level task bars so bar length is
  // comparable across tasks (longest visible task fills the column).
  const scaleMaxMs = useMemo(
    () => Math.max(1, ...groups.map((group) => group.taskDurationMs)),
    [groups],
  );

  // Resolve the selected key against the live groups so the panel tracks span
  // updates (running → ok) and closes itself when the span leaves the view.
  const selected = useMemo(() => {
    if (!selectedKey) return null;
    for (const group of groups) {
      const span = group.spans.find(
        (candidate) => spanKey(candidate) === selectedKey,
      );
      if (span) return { span: span, group: group };
    }

    return null;
  }, [groups, selectedKey]);

  // Deliberately no auto-expand: new tasks arrive collapsed, since the row
  // already shows live status and a tree popping open on every task is noisy.

  // Reset paging when the filters change so "Load more" starts from the top.
  // Render-time adjustment, not an effect.
  const filterSignature = `${filter}|${statusFilter}|${fromMs}|${toMs}`;
  const [prevFilterSignature, setPrevFilterSignature] =
    useState(filterSignature);
  if (filterSignature !== prevFilterSignature) {
    setPrevFilterSignature(filterSignature);
    setVisibleCount(PAGE_SIZE);
  }

  // Arriving from a log's "View trace": expand that trace, page it into view,
  // scroll to it, then drop the param so a manual collapse is not re-fought.
  const focusedRef = useRef<string | null>(null);
  // The focus key a one-trace Tempo fetch was already sent for, so a miss
  // ends in a notice instead of another fetch.
  const fetchedRef = useRef<string | null>(null);
  const [missingTrace, setMissingTrace] = useState<string | null>(null);
  // A new focus target retires the notice about the previous one.
  const [prevFocusTraceId, setPrevFocusTraceId] = useState(focusTraceId);
  if (focusTraceId !== prevFocusTraceId) {
    setPrevFocusTraceId(focusTraceId);
    if (focusTraceId) setMissingTrace(null);
  }
  // Bumped by focusTrace to force a re-focus of the same trace (the ref dedup
  // below would otherwise swallow a repeat click on the same "↳ from parent" link).
  const [refocusNonce, setRefocusNonce] = useState(0);
  const dropFocusParam = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("trace");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [searchParams, pathname, router]);
  useEffect(() => {
    if (!focusTraceId) return;
    const focusKey = `${focusTraceId}:${refocusNonce}`;
    if (focusedRef.current === focusKey) return;
    const index = groups.findIndex(
      (group) => group.root.traceId === focusTraceId,
    );
    if (index === -1) {
      // The trace is in the buffer but a filter is hiding it: clear the filters
      // so it renders, then let the effect re-run and scroll to it. Only a
      // trace absent from the whole buffer is a candidate for a Tempo fetch.
      if (allGroups.some((group) => group.root.traceId === focusTraceId)) {
        setFilter("");
        setStatusFilter("all");
        setFromTime("");
        setToTime("");

        return;
      }
      // Not in the recent history: ask Tempo for that one trace, once the
      // backfill has settled so the two answers cannot race. Record the request
      // only if it actually went out, so a closed socket doesn't get reported as
      // a miss without ever asking. A second real miss is reported.
      if (history === "loading" || history === "none") return;
      if (fetchedRef.current !== focusKey) {
        if (fetchTrace(focusTraceId)) fetchedRef.current = focusKey;

        return;
      }
      focusedRef.current = focusKey;
      setMissingTrace(focusTraceId);
      dropFocusParam();

      return;
    }
    const rootKey = `${focusTraceId}:${groups[index].root.spanId}`;
    setExpanded((current) =>
      current.has(rootKey) ? current : new Set([...current, rootKey]),
    );
    // A trace beyond the current page isn't in the DOM yet: page it in and
    // finish on the re-run (visibleCount is a dep). Marking done or dropping
    // the param now would skip the scroll and highlight entirely.
    if (index >= visibleCount) {
      setVisibleCount(index + 1);

      return;
    }
    const target = document.getElementById(`task-${focusTraceId}`);
    if (!target) return;
    focusedRef.current = focusKey;
    target.scrollIntoView({ block: "center" });
    dropFocusParam();
  }, [
    focusTraceId,
    refocusNonce,
    groups,
    allGroups,
    visibleCount,
    history,
    fetchTrace,
    dropFocusParam,
  ]);

  const toggle = (key: string): void => {
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

  // Jump to another trace (a subagent's "↳ from parent" link). Reuses the
  // `?trace=` focus effect above, which expands, pages in, scrolls, and highlights.
  // Bumps the nonce (not the ref) so re-clicking the same link re-focuses.
  const focusTrace = useCallback(
    (traceId: string) => {
      setRefocusNonce((nonce) => nonce + 1);
      const next = new URLSearchParams(searchParams.toString());
      next.set("trace", traceId);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [searchParams, pathname, router],
  );

  const clearFilters = (): void => {
    setFilter("");
    setStatusFilter("all");
    setFromTime("");
    setToTime("");
  };

  const visibleGroups = groups.slice(0, visibleCount);
  const remaining = groups.length - visibleGroups.length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
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
        refreshTitle={error ?? "Refresh traces"}
        isError={status === "error"}
      />

      {missingTrace && (
        <p
          aria-live="polite"
          className="flex shrink-0 items-center gap-2 text-xs text-destructive"
        >
          <span className="truncate font-mono">
            Trace {missingTrace} is not available
            {error ? `: ${error}` : " in this stage's history."}
          </span>
          <button
            type="button"
            onClick={() => setMissingTrace(null)}
            className="cursor-pointer underline underline-offset-2"
          >
            Dismiss
          </button>
        </p>
      )}

      <DetailSplit
        detail={
          selected && (
            <DetailPanel
              title={spanLabel(selected.group.root)}
              meta={
                <div className="mt-0.5 flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
                  <span>
                    {isRootSpanKind(selected.span.kind)
                      ? kindTheme(selected.span.kind).word
                      : `${spanLabel(selected.span)} ${kindTheme(selected.span.kind).word}`}
                  </span>
                  <StatusDot
                    tone={
                      isStale(selected.span, isTaskRunning(selected.group.root))
                        ? "ended"
                        : selected.span.status
                    }
                  />
                  <span className="font-mono">
                    {spanMetaLine(selected.span)}
                  </span>
                  {canContinue(selected.span) && (
                    <ContinueTaskButton
                      key={selected.span.traceId}
                      apiKey={apiKey}
                      projectSlug={projectSlug}
                      root={selected.span}
                      stageSlug={stageSlug}
                    />
                  )}
                </div>
              }
              onClose={() => setSelectedKey(null)}
            >
              <SpanDetails span={selected.span} />
            </DetailPanel>
          )
        }
      >
        <table className="w-full table-fixed text-xs">
          <colgroup>
            <col className="w-33" />
            <col />
            <col className="w-24" />
            <col className="w-19" />
            <col className="w-[26%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur">
            <tr className="text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">Started</th>
              <th className="px-3 py-2 font-medium">Request</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Duration</th>
              <th className="px-3 py-2 font-medium">Timeline</th>
            </tr>
          </thead>
          <tbody>
            {visibleGroups.flatMap((group) =>
              renderSpanRows(
                group.root,
                0,
                group,
                scaleMaxMs,
                expanded,
                toggle,
                selectedKey,
                setSelectedKey,
                focusTraceId,
                isTaskRunning(group.root),
                focusTrace,
              ),
            )}
            {groups.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="h-32 text-center text-xs text-muted-foreground"
                >
                  {entries.length === 0
                    ? emptyStreamMessage(history, error, "traces", "7 days")
                    : "No tasks match the current filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {remaining > 0 && (
          <div className="border-t border-border/40 bg-card/60 p-2 text-center">
            <button
              type="button"
              onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
              className="cursor-pointer rounded-md px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            >
              Load {Math.min(PAGE_SIZE, remaining)} more ·{" "}
              {remaining.toLocaleString()} older task
              {remaining === 1 ? "" : "s"}
            </button>
          </div>
        )}
      </DetailSplit>
    </div>
  );
}

function attributeText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return value.toLocaleString();

  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Labeled fields first, then the run identity, then every key the panel does not already show. */
function detailRows(span: ObservabilitySpanRow): DetailRow[] {
  const attributes = span.attributes ?? {};
  const labeled = DETAIL_FIELDS.flatMap(
    ({ extraKey, extraLabel, key, label, words }): DetailRow[] => {
      const value = attributeText(attributes[key]);
      if (value === undefined) return [];
      const extra = extraKey ? attributeText(attributes[extraKey]) : undefined;

      return [
        {
          key: key,
          label: label,
          value:
            extra === undefined ? value : `${value} · ${extra} ${extraLabel}`,
          words: words,
        },
      ];
    },
  );
  const identity: DetailRow[] = isRootSpanKind(span.kind)
    ? [
        { key: "trace", label: "Trace", value: span.traceId },
        { key: "agent", label: "Agent", value: span.agentId ?? "unknown" },
        {
          key: "conversation",
          label: "Conversation",
          value: span.conversationKey ?? "none",
        },
      ]
    : [];
  const rest = Object.entries(attributes).flatMap(
    ([key, value]): DetailRow[] => {
      const text = attributeText(value);

      return SHOWN_KEYS.has(key) || text === undefined
        ? []
        : [{ key: key, label: key, value: text }];
    },
  );

  return [...labeled, ...identity, ...rest];
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

/** Date + time for the "Started" column so a task is locatable across days, not just within the hour. */
function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;

  return `${Math.round(ms)}ms`;
}

function numericAttribute(
  span: ObservabilitySpanRow,
  key: string,
): number | undefined {
  const value = span.attributes?.[key];

  return typeof value === "number" ? value : undefined;
}

// A section shows the count that describes it; the char count is added when
// the span reports one, or stands in when there is no count at all.
function payloadSections(span: ObservabilitySpanRow): PayloadSection[] {
  return PAYLOAD_SECTIONS.flatMap(
    ({ charsKey, countKey, countLabel, key, label }): PayloadSection[] => {
      const value = displayAttribute(span.attributes?.[key]);
      if (!value) return [];
      const count = countKey ? numericAttribute(span, countKey) : undefined;
      const reportedChars = charsKey
        ? numericAttribute(span, charsKey)
        : undefined;
      const chars =
        reportedChars ?? (count === undefined ? value.length : undefined);
      const summary = [
        ...(count === undefined
          ? []
          : [`${count.toLocaleString()} ${countLabel}`]),
        ...(chars === undefined ? [] : [`${chars.toLocaleString()} chars`]),
      ].join(" · ");

      return [{ key: key, label: label, summary: summary, value: value }];
    },
  );
}

function spanKey(span: ObservabilitySpanRow): string {
  return `${span.traceId}:${span.spanId}`;
}

/** Duration, total tokens when the span has them, and start time. */
function spanMetaLine(span: ObservabilitySpanRow): string {
  const tokens =
    numericAttribute(span, "usage.total_tokens") ??
    numericAttribute(span, "model.total_tokens");

  return [
    span.durationMs > 0 ? formatDuration(span.durationMs) : "—",
    ...(tokens === undefined ? [] : [`${formatNumber(tokens)} tokens`]),
    formatDateTime(span.startTimeMs),
  ].join(" · ");
}

// Lowercased search text, built once per span object. The stream replaces a
// span object when it updates instead of mutating it, so the cache never serves
// stale text, and a keystroke re-serializes nothing.
function spanSearchText(span: ObservabilitySpanRow): string {
  const cached = SPAN_SEARCH_TEXT.get(span);
  if (cached !== undefined) return cached;
  const text = [
    span.name,
    span.kind,
    span.status,
    span.traceId,
    span.agentId ?? "",
    span.conversationKey ?? "",
    span.error ?? "",
    ...Object.entries(span.attributes ?? {}).map(
      ([key, value]) =>
        `${key} ${typeof value === "string" ? value : JSON.stringify(value)}`,
    ),
  ]
    .join("\n")
    .toLowerCase();
  SPAN_SEARCH_TEXT.set(span, text);

  return text;
}

// Only a failed top-level run can be continued: a subtask belongs to its
// parent's run, and a task that finished has nothing to pick up.
function canContinue(span: ObservabilitySpanRow): boolean {
  return (
    (span.kind === "task" || span.kind === "cron") && span.status === "error"
  );
}

/** A live "running" span under a task that already finished never reported its end. */
function isStale(span: ObservabilitySpanRow, taskRunning: boolean): boolean {
  return span.status === "running" && !taskRunning;
}

function isTaskRunning(root: ObservabilitySpanRow): boolean {
  return (
    root.status === "running" &&
    Date.now() - root.startTimeMs < TASK_MAX_RUNTIME_MS
  );
}

/** KIND_THEME lookup with a fallback: core can ship a new span kind before
 * this dashboard build knows it, and that must not take down the panel. */
function kindTheme(kind: ObservabilitySpanRow["kind"]): KindTheme {
  return KIND_THEME[kind] ?? KIND_THEME["tool.call"];
}

/** Newest task first. */
function groupSpans(spans: ObservabilitySpanRow[]): SpanGroup[] {
  const tasks = spans.filter((span) => isRootSpanKind(span.kind));
  const childrenByTrace = new Map<string, ObservabilitySpanRow[]>();

  for (const span of spans) {
    if (isRootSpanKind(span.kind)) continue;
    const children = childrenByTrace.get(span.traceId) ?? [];
    children.push(span);
    childrenByTrace.set(span.traceId, children);
  }

  return tasks
    .map((root) => {
      const children = childrenByTrace.get(root.traceId) ?? [];
      const spanIds = new Set([
        root.spanId,
        ...children.map((child) => child.spanId),
      ]);
      const childrenByParent = new Map<string, ObservabilitySpanRow[]>();
      for (const child of children) {
        // Re-parent orphans (a parent that never arrived) onto the root so they
        // still render instead of disappearing.
        const parentId =
          child.parentSpanId && spanIds.has(child.parentSpanId)
            ? child.parentSpanId
            : root.spanId;
        const siblings = childrenByParent.get(parentId) ?? [];
        siblings.push(child);
        childrenByParent.set(parentId, siblings);
      }
      for (const siblings of childrenByParent.values()) {
        siblings.sort((left, right) => left.startTimeMs - right.startTimeMs);
      }

      const spans = [root, ...children];
      const taskRunning = isTaskRunning(root);
      const windowStart = Math.min(...spans.map((span) => span.startTimeMs));
      const windowEnd = Math.max(
        ...spans.map((span) =>
          isStale(span, taskRunning) ? span.startTimeMs : span.endTimeMs,
        ),
      );

      const windowSpan = Math.max(1, windowEnd - windowStart);

      return {
        root: root,
        childrenByParent: childrenByParent,
        spans: spans,
        windowStart: windowStart,
        windowSpan: windowSpan,
        taskDurationMs: Math.max(
          root.durationMs,
          taskRunning ? windowEnd - root.startTimeMs : 0,
          1,
        ),
      };
    })
    .sort((left, right) => right.root.startTimeMs - left.root.startTimeMs);
}

/** The span's own name: the request for a root, the tool or step for a child. */
function spanLabel(span: ObservabilitySpanRow): string {
  if (span.kind === "tool.call") {
    const toolName = span.attributes?.["tool.name"];

    return typeof toolName === "string" ? toolName : "tool call";
  }
  if (span.kind === "model.step") {
    const stepNumber = span.attributes?.["agent.step_number"];

    return typeof stepNumber === "number" ? `step ${stepNumber + 1}` : "step";
  }
  if (span.kind === "phase") {
    const label = span.attributes?.["phase.name"];

    return typeof label === "string" ? label : span.name;
  }
  if (span.kind === "subtask") {
    const agentId = span.attributes?.["agent.id"] ?? span.agentId;

    return typeof agentId === "string"
      ? `Subagent: ${agentId}`
      : "Subagent task";
  }
  const input = span.attributes?.["task.input"];
  if (typeof input === "string" && input) return input;
  const taskId = span.attributes?.["task.id"];

  return typeof taskId === "string" ? taskId : span.traceId;
}

/**
 * The top-level task bar, sized on a scale shared across all visible tasks so a
 * longer task always reads as a longer bar (the familiar trace-list convention).
 */
function TaskDurationBar({
  group,
  scaleMaxMs,
}: {
  group: SpanGroup;
  scaleMaxMs: number;
}): React.JSX.Element {
  const live = isTaskRunning(group.root);
  const barColor = kindTheme(group.root.kind).bar;
  const widthPct = Math.max(
    1.5,
    Math.min(100, (group.taskDurationMs / scaleMaxMs) * 100),
  );
  const title = `${spanLabel(group.root)} · ${formatDuration(group.taskDurationMs)} · started ${formatTime(group.root.startTimeMs)}`;

  return (
    <div className="relative h-4 w-full">
      <div
        className={cn(
          "absolute top-1/2 h-2 -translate-y-1/2 rounded-sm",
          group.root.status === "error" ? "bg-red-500/70" : barColor,
          live &&
            "ring-1 ring-inset ring-foreground/40 dark:ring-background/70",
        )}
        style={{ width: `${widthPct}%` }}
        title={title}
      />
    </div>
  );
}

/**
 * One waterfall bar positioned within the task's time window. Model steps split
 * into a muted invoke-wait (time-to-first-token) segment and a solid streaming
 * segment so a slow step shows where the time went. A faint track behind the bar
 * marks the full task window so each child reads against the whole span.
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
}): React.JSX.Element {
  const stale = isStale(span, taskRunning);
  const live = span.status === "running" && taskRunning;
  const barColor = kindTheme(span.kind).bar;
  const end = live
    ? windowStart + windowSpan
    : Math.max(span.endTimeMs, span.startTimeMs);
  const leftPct = Math.min(
    100,
    Math.max(0, ((span.startTimeMs - windowStart) / windowSpan) * 100),
  );
  const widthPct = Math.max(
    0.75,
    Math.min(((end - span.startTimeMs) / windowSpan) * 100, 100 - leftPct),
  );

  const ttftMs = numericAttribute(span, "model.ttft_ms");
  const ttftFrac =
    ttftMs !== undefined && span.durationMs > 0
      ? Math.min(1, ttftMs / span.durationMs)
      : 0;
  const title = `${spanLabel(span)} · ${formatDuration(span.durationMs)} · started ${formatTime(span.startTimeMs)}${
    ttftMs !== undefined
      ? ` · time to first token ${formatDuration(ttftMs)}`
      : ""
  }`;

  return (
    <div className="relative h-4 w-full">
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border/60" />
      <div
        className="absolute top-1/2 flex h-2 -translate-y-1/2 overflow-hidden rounded-sm"
        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        title={title}
      >
        {ttftFrac > 0 && (
          <div
            className="h-full shrink-0 bg-blue-500/25"
            style={{ width: `${ttftFrac * 100}%` }}
          />
        )}
        <div
          className={cn(
            "h-full flex-1",
            stale ? "bg-muted-foreground/25" : barColor,
            live &&
              "ring-1 ring-inset ring-foreground/40 dark:ring-background/70",
          )}
        />
      </div>
    </div>
  );
}

function TimingChip({
  label,
  ms,
}: {
  label: string;
  ms: number | undefined;
}): React.JSX.Element | null {
  if (ms === undefined) {
    return null;
  }

  return (
    <span className="whitespace-nowrap">
      {label}{" "}
      <span className="font-mono text-foreground/80">{formatDuration(ms)}</span>
    </span>
  );
}

/**
 * Re-enters the failed task's conversation with `continue: true` on the stage's
 * run endpoint. State lives here so a click never re-renders the task list;
 * the parent keys it by trace so the note resets when the selection moves.
 */
function ContinueTaskButton({
  apiKey,
  projectSlug,
  root,
  stageSlug,
}: {
  apiKey: string | undefined;
  projectSlug: string | undefined;
  root: ObservabilitySpanRow;
  stageSlug: string | undefined;
}): React.JSX.Element {
  const [note, setNote] = useState<ContinueNote | null>(null);
  const continueTask = async (): Promise<void> => {
    const endpoint = resolveCoreEndpoint();
    if (!endpoint.ok) {
      setNote({ pending: false, text: endpoint.message });

      return;
    }
    if (!apiKey || !root.endpointId || !root.agentId || !root.conversationKey) {
      setNote({
        pending: false,
        text: "Cannot continue: the task has no endpoint, agent, or conversation",
      });

      return;
    }
    setNote({ pending: true, text: "Continuing…" });
    try {
      const response = await fetch(
        `${endpoint.httpBaseUrl}${agentEndpointPath({
          endpointId: root.endpointId,
          projectSlug: projectSlug,
          stageSlug: stageSlug,
        })}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agentId: root.agentId,
            eventId: `continue-${crypto.randomUUID()}`,
            conversationKey: root.conversationKey,
            continue: true,
          }),
        },
      );
      const payload = (await response.json()) as {
        status?: string;
        error?: string | { message?: string };
      };
      const error =
        typeof payload.error === "string"
          ? payload.error
          : payload.error?.message;
      setNote({
        pending: false,
        text: response.ok
          ? `Continued: ${payload.status ?? "accepted"}`
          : (error ?? `Continue failed (${response.status})`),
      });
    } catch (err) {
      setNote({
        pending: false,
        text: err instanceof Error ? err.message : "Continue failed",
      });
    }
  };

  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={note?.pending === true}
        onClick={continueTask}
      >
        Continue
      </Button>
      {note && <span className="text-muted-foreground">{note.text}</span>}
    </>
  );
}

function SpanDetails({
  span,
}: {
  span: ObservabilitySpanRow;
}): React.JSX.Element {
  // Pretty-printing a large payload is the expensive part, and the parent
  // re-renders on every stream message while a run is live.
  const { sections, rows } = useMemo(
    () => ({ sections: payloadSections(span), rows: detailRows(span) }),
    [span],
  );
  const modelId = span.attributes?.["model.id"];

  // minmax(0,1fr) lets the grid track shrink below its content's min-content
  // width; without it a long unbroken run in a payload widens the track past
  // the panel and the text spills off the tinted background.
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <SpanTimings span={span} />
      {span.error && (
        <div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:bg-red-950/20 dark:text-red-400">
          {span.error}
        </div>
      )}
      {/* Flat sections: a clickable header row over a soft-tinted payload surface.
          No bordered card around each one, which would nest a box in a box. */}
      {(sections.length > 0 || rows.length > 0) && (
        <div className="min-w-0 divide-y divide-border/40 rounded-md bg-card/30">
          {sections.map(({ key, label, summary, value }) => (
            <details key={key} className="group/detail">
              <SectionSummary label={label} summary={summary} />
              {/* wrap-anywhere, unlike wrap-break-word, also lowers the min-content width. */}
              <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap wrap-anywhere px-3 pb-3 text-xs leading-relaxed text-foreground/90">
                {value}
              </pre>
            </details>
          ))}
          {rows.length > 0 && (
            <details className="group/detail">
              <SectionSummary
                label="Details"
                summary={
                  typeof modelId === "string"
                    ? modelId
                    : `${rows.length} fields`
                }
              />
              <div className="grid px-1 pb-2 text-xs">
                {rows.map(({ key, label, value, words }) => (
                  <CopyRow
                    key={key}
                    value={value}
                    className="grid w-full grid-cols-[7rem_minmax(0,1fr)_auto] px-2 py-1"
                  >
                    <span className="truncate text-muted-foreground">
                      {label}
                    </span>
                    <span
                      className={cn(
                        "truncate text-foreground/80",
                        !words && "font-mono",
                      )}
                    >
                      {value}
                    </span>
                  </CopyRow>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/** Where a context prepare or a model step spent its time, as chips above the sections. */
function SpanTimings({
  span,
}: {
  span: ObservabilitySpanRow;
}): React.JSX.Element | null {
  const historyRows = numericAttribute(span, "prepare.history_rows");
  if (historyRows !== undefined) {
    return (
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {PREPARE_TIMINGS.map(({ key, label }) => (
          <TimingChip
            key={key}
            label={label}
            ms={numericAttribute(span, key)}
          />
        ))}
        <span className="whitespace-nowrap">
          history rows{" "}
          <span className="font-mono text-foreground/80">
            {historyRows.toLocaleString()}
          </span>
        </span>
      </div>
    );
  }
  const ttftMs = numericAttribute(span, "model.ttft_ms");
  if (span.kind !== "model.step" || ttftMs === undefined) return null;
  const streamMs = numericAttribute(span, "model.stream_ms");
  const toolWaitMs = numericAttribute(span, "model.tool_wait_ms");
  const reasoningMs = numericAttribute(span, "model.reasoning_stream_ms") ?? 0;
  const textMs = numericAttribute(span, "model.text_stream_ms") ?? 0;
  const toolInputMs = numericAttribute(span, "model.tool_input_stream_ms") ?? 0;

  return (
    <div className="grid gap-1.5 text-xs text-muted-foreground">
      {/* Step time, split so a slow step shows where it went. "Streaming" is
          ONLY model token generation. Tool execution is the separate "tool
          wait" (and the child tool spans), never folded into streaming. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <TimingChip label="first token" ms={ttftMs} />
        <TimingChip label="streaming" ms={streamMs} />
        <TimingChip
          label="tool wait"
          ms={
            toolWaitMs !== undefined && toolWaitMs > 0 ? toolWaitMs : undefined
          }
        />
      </div>
      {(reasoningMs > 0 || textMs > 0 || toolInputMs > 0) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span>streamed</span>
          <TimingChip
            label="reasoning"
            ms={reasoningMs > 0 ? reasoningMs : undefined}
          />
          <TimingChip label="text" ms={textMs > 0 ? textMs : undefined} />
          <TimingChip
            label="tool input"
            ms={toolInputMs > 0 ? toolInputMs : undefined}
          />
        </div>
      )}
    </div>
  );
}

function SpanRow({
  span,
  depth,
  isExpanded,
  hasChildren,
  onToggle,
  isSelected,
  onSelect,
  group,
  scaleMaxMs,
  taskRunning,
  highlighted,
  onFocusTrace,
}: {
  span: ObservabilitySpanRow;
  depth: number;
  isExpanded: boolean;
  hasChildren: boolean;
  onToggle: () => void;
  isSelected: boolean;
  onSelect: () => void;
  group: SpanGroup;
  scaleMaxMs: number;
  taskRunning: boolean;
  highlighted: boolean;
  onFocusTrace: (traceId: string) => void;
}): React.JSX.Element {
  // Every root gets its own duration bar, anchor id, and subtitle.
  const isRoot = isRootSpanKind(span.kind);
  const label = spanLabel(span);
  const parentTraceId =
    span.kind === "subtask" ? span.attributes?.["parent.trace_id"] : undefined;

  return (
    <tr
      id={isRoot ? `task-${span.traceId}` : undefined}
      onClick={() => {
        // Opens a collapsed row, but closes one only when it is already the
        // selected row, so picking a parent to read it keeps its steps open.
        if (hasChildren && (!isExpanded || isSelected)) onToggle();
        onSelect();
      }}
      className={cn(
        "cursor-pointer border-b border-border/40 transition-colors hover:bg-accent/20",
        isSelected && "bg-accent/30",
        !isRoot && "text-foreground/80",
        highlighted && "bg-sky-500/10 ring-1 ring-inset ring-sky-500/40",
      )}
    >
      <td
        className="px-3 py-1.5 font-mono whitespace-nowrap tabular-nums text-muted-foreground"
        title={new Date(span.startTimeMs).toLocaleString()}
      >
        {isRoot
          ? formatDateTime(span.startTimeMs)
          : formatTime(span.startTimeMs)}
      </td>
      <td className="py-1.5 pr-3" style={{ paddingLeft: depth * 18 + 12 }}>
        <span className="flex min-w-0 items-center gap-2">
          {hasChildren ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggle();
              }}
              aria-label={isExpanded ? "Collapse spans" : "Expand spans"}
              className="-m-1 cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              {isExpanded ? (
                <ChevronDown className="size-3.5 shrink-0" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0" />
              )}
            </button>
          ) : (
            <span className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0 truncate" title={label}>
            {label}
            {isRoot ? (
              <span className="text-muted-foreground">
                {" · "}
                {span.agentId ?? "unknown agent"}
                {" · "}
                {span.conversationKey ?? "no conversation"}
              </span>
            ) : (
              <span className="ml-2 text-muted-foreground">
                {kindTheme(span.kind).word}
              </span>
            )}
          </span>
          {typeof parentTraceId === "string" && parentTraceId && (
            <button
              type="button"
              className="shrink-0 cursor-pointer whitespace-nowrap text-muted-foreground hover:text-foreground hover:underline"
              onClick={(event) => {
                event.stopPropagation();
                onFocusTrace(parentTraceId);
              }}
              title="Jump to the parent task"
            >
              ↳ from parent
            </button>
          )}
        </span>
      </td>
      <td className="px-3 py-1.5">
        <StatusDot tone={isStale(span, taskRunning) ? "ended" : span.status} />
      </td>
      <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap tabular-nums">
        {span.durationMs > 0 ? formatDuration(span.durationMs) : "—"}
      </td>
      <td className="px-3 py-1.5">
        {isRoot ? (
          <TaskDurationBar group={group} scaleMaxMs={scaleMaxMs} />
        ) : (
          <TimelineBar
            span={span}
            windowStart={group.windowStart}
            windowSpan={group.windowSpan}
            taskRunning={taskRunning}
          />
        )}
      </td>
    </tr>
  );
}

/**
 * `enclosingRootLive` is whether the nearest enclosing root run is live. A subagent
 * subtask is itself a root: it runs independently (the parent task pass can finalize
 * while the subagent is still working), so it is judged by its own freshness, and its
 * descendants inherit the subtask's liveness, not the parent task's.
 */
function renderSpanRows(
  span: ObservabilitySpanRow,
  depth: number,
  group: SpanGroup,
  scaleMaxMs: number,
  expanded: Set<string>,
  toggle: (key: string) => void,
  selectedKey: string | null,
  onSelect: (key: string) => void,
  focusTraceId: string | null,
  enclosingRootLive: boolean,
  onFocusTrace: (traceId: string) => void,
): ReactNode[] {
  const key = spanKey(span);
  const isExpanded = expanded.has(key);
  const children = group.childrenByParent.get(span.spanId) ?? [];
  const isRoot = isRootSpanKind(span.kind);
  // A root is judged on its own freshness; a child on its enclosing root's liveness.
  const spanRunning = isRoot ? isTaskRunning(span) : enclosingRootLive;
  const childRootLive = isRoot ? isTaskRunning(span) : enclosingRootLive;
  const rows: ReactNode[] = [
    <SpanRow
      key={`row:${key}`}
      span={span}
      depth={depth}
      isExpanded={isExpanded}
      hasChildren={children.length > 0}
      onToggle={() => toggle(key)}
      isSelected={key === selectedKey}
      onSelect={() => onSelect(key)}
      group={group}
      scaleMaxMs={scaleMaxMs}
      taskRunning={spanRunning}
      highlighted={isRoot && span.traceId === focusTraceId}
      onFocusTrace={onFocusTrace}
    />,
  ];

  if (isExpanded) {
    for (const child of children) {
      rows.push(
        ...renderSpanRows(
          child,
          depth + 1,
          group,
          scaleMaxMs,
          expanded,
          toggle,
          selectedKey,
          onSelect,
          focusTraceId,
          childRootLive,
          onFocusTrace,
        ),
      );
    }
  }

  return rows;
}
