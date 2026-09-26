"use client";

import {
  DetailFields,
  DetailPayload,
  type DetailRow,
} from "@/app/components/DetailSections";
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { StatusDot, type StatusTone } from "@/app/components/StatusDot";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
  isRootSpanKind,
  useObservabilityStream,
  type ObservabilitySpanRow,
  type TaskWaitingOn,
} from "@/app/hooks/useObservabilityStream";
import { agentEndpointPath, resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { formatNumber } from "@/app/lib/formatNumber";
import { formatDateTime, formatTime, toEpochMs } from "@/app/lib/formatTime";
import { isEditableTarget } from "@/app/lib/shortcuts";
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

type SpanStatus = ObservabilitySpanRow["status"];
type StatusFilter = "all" | SpanStatus;

// A Continue click on one failed task. `error` is null from the click until
// the continuation's trace arrives, which then replaces the button.
interface ContinueAttempt {
  error: string | null;
}

// One collapsible payload section, with the count line on its header.
interface PayloadSection extends DetailRow {
  summary: string;
}

// A task reads as the request's outcome, so its status column uses these words.
const TASK_STATUS_WORD: Record<SpanStatus, string> = {
  running: "Running",
  waiting: "Waiting",
  needs_input: "Needs input",
  ok: "Done",
  error: "Failed",
};

const STATUS_TONE: Record<SpanStatus, StatusTone> = {
  running: "running",
  waiting: "warn",
  needs_input: "input",
  ok: "ok",
  error: "error",
};

const STATUS_FILTER_OPTIONS: ToolbarFilterOption[] = [
  { value: "all", label: "All statuses" },
  ...(Object.keys(TASK_STATUS_WORD) as SpanStatus[]).map((status) => ({
    value: status,
    label: TASK_STATUS_WORD[status],
  })),
];

// The synthetic span that stands for the time between a run that closed on
// something open and the next run of its task.
const WAIT_SPAN_NAME = "task.wait";

const WAITING_ON_LABEL: Record<TaskWaitingOn, string> = {
  question: "needs input · question",
  approval: "needs input · approval",
  subagent: "waiting · on subagent",
  tool: "waiting · on tool",
};

const WAIT_BAR: Partial<Record<SpanStatus, string>> = {
  waiting: "bg-warning/50",
  needs_input: "bg-needs-input/50",
};

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
  // The live <environment> block the run's last message carried.
  { key: "agent.environment", label: "Environment" },
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
  { key: "task.waiting_on", label: "Waiting on", words: true },
  { key: "task.id", label: "Task id" },
  { key: "task.root_id", label: "Resumes task" },
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
  "wait.open",
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
// deuteranopia). The shades per theme live in the --span-* tokens in globals.css.
const KIND_THEME: Record<ObservabilitySpanRow["kind"], KindTheme> = {
  task: { bar: "bg-span-task/70", word: "task" },
  cron: { bar: "bg-span-cron/70", word: "cron" },
  subtask: { bar: "bg-span-subtask/70", word: "subagent" },
  "model.step": { bar: "bg-span-model/70", word: "model" },
  "tool.call": { bar: "bg-span-tool/70", word: "tool" },
  phase: { bar: "bg-span-phase/70", word: "phase" },
};

// A root task/subtask still "running" past this likely never reported its
// terminal span (crash/freeze or a lost publish), so we treat it as finished.
// Otherwise it reads as running forever.
const TASK_MAX_RUNTIME_MS = 16 * 60 * 1000;

// A provider throttle, shown as "rate limit" and matched by `error:rate_limit`.
const RATE_LIMIT = /rate.?limit|429/i;

// How much of an error the task list shows as the failure cause.
const CAUSE_CHARS = 40;

// Conversation key prefixes core writes per channel (runtime-keys.ts). Any
// other key came in through the API.
const CHANNEL_PREFIXES: ReadonlyArray<{ label: string; prefix: string }> = [
  { prefix: "tg:", label: "Telegram" },
  { prefix: "slack:", label: "Slack" },
  { prefix: "discord:", label: "Discord" },
  { prefix: "matrix:", label: "Matrix" },
  { prefix: "gh:", label: "GitHub" },
  { prefix: "pancake:", label: "Pancake" },
  { prefix: "zalo:", label: "Zalo" },
  { prefix: "cron:", label: "Cron" },
];

// `status:` values, in the span's words and the task list's.
const STATUS_ALIASES: Readonly<Record<string, SpanStatus>> = {
  ok: "ok",
  done: "ok",
  error: "error",
  failed: "error",
  running: "running",
  waiting: "waiting",
  needs_input: "needs_input",
};

// One matcher per `field:value` search token. Values arrive lowercased.
const QUERY_MATCHERS: Record<
  TaskQueryField,
  (group: SpanGroup, value: string) => boolean
> = {
  agent: (group, value) =>
    group.spans.some(
      (span) =>
        isRootSpanKind(span.kind) &&
        (span.agentId ?? "").toLowerCase().startsWith(value),
    ),
  channel: (group, value) =>
    taskChannel(group.root).toLowerCase().startsWith(value),
  conv: (group, value) =>
    group.spans.some(
      (span) =>
        isRootSpanKind(span.kind) &&
        (span.conversationKey ?? "").toLowerCase().includes(value),
    ),
  error: (group, value) =>
    group.spans.some(
      (span) =>
        span.error !== undefined &&
        (RATE_LIMIT.test(value)
          ? RATE_LIMIT.test(span.error)
          : span.error.toLowerCase().includes(value)),
    ),
  status: (group, value) => STATUS_ALIASES[value] === group.status,
  tool: (group, value) =>
    group.spans.some(
      (span) =>
        span.kind === "tool.call" && spanLabel(span).toLowerCase() === value,
    ),
  trace: (group, value) =>
    group.spans.some(
      (span) =>
        isRootSpanKind(span.kind) &&
        span.traceId.toLowerCase().startsWith(value),
    ),
};

// One request: its first run is the row, and every later pass, answer
// continuation, subagent and wait between them nests under it.
export interface SpanGroup {
  root: ObservabilitySpanRow;
  // The request's status: its latest run decides, and a finished request with a
  // subagent still running is waiting on it.
  status: SpanStatus;
  // Whether the latest run is still live, so a stale "running" reads as ended.
  live: boolean;
  // Tool calls that failed, even when the run recovered.
  issueCount: number;
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
  // The next task or cron in the same conversation. Once it exists the failed
  // task was picked up, so it links there instead of offering Continue.
  nextRun: ObservabilitySpanRow | null;
}

type TaskQueryField =
  | "agent"
  | "channel"
  | "conv"
  | "error"
  | "status"
  | "tool"
  | "trace";

// The parsed search box: every `field:value` token must match, and the free
// words, rejoined, must appear in one span's search text.
export interface TaskQuery {
  fields: Array<{ field: TaskQueryField; value: string }>;
  text: string;
}

// Consecutive model steps that all called one tool, shown as one row. `span`
// is the synthetic row: first start to last end, summed duration.
export interface StepFold {
  label: string;
  span: ObservabilitySpanRow;
  steps: ObservabilitySpanRow[];
}

// One sibling row in the waterfall: a span, or a fold of steps.
export type WaterfallItem =
  | { type: "span"; span: ObservabilitySpanRow }
  | { type: "fold"; fold: StepFold };

// What every waterfall row of the selected task reads and calls.
interface WaterfallView {
  expanded: Set<string>;
  focusTraceId: string | null;
  group: SpanGroup;
  onFocusTrace: (traceId: string) => void;
  onSelect: (key: string) => void;
  selectedKey: string | null;
  toggle: (key: string) => void;
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
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [continueAttempts, setContinueAttempts] = useState<
    ReadonlyMap<string, ContinueAttempt>
  >(new Map());

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
    const query = parseTaskQuery(deferredFilter);

    return allGroups.filter((group) => {
      const { root } = group;
      if (statusFilter !== "all" && group.status !== statusFilter) return false;
      if (fromMs !== null && root.startTimeMs < fromMs) return false;
      if (toMs !== null && root.startTimeMs > toMs) return false;

      return matchesTaskQuery(group, query);
    });
  }, [allGroups, deferredFilter, statusFilter, fromMs, toMs]);

  const visibleGroups = useMemo(
    () => groups.slice(0, visibleCount),
    [groups, visibleCount],
  );
  const remaining = groups.length - visibleGroups.length;

  // The task on the right. With no pick, or a pick the filters hid, the first
  // listed task stands in.
  const selectedGroup =
    visibleGroups.find((group) => spanKey(group.root) === selectedTaskKey) ??
    visibleGroups[0] ??
    null;
  // The span open in the side panel, resolved against the selected task so
  // it tracks live updates and closes when its task leaves the view.
  const selectedSpan =
    selectedGroup?.spans.find((span) => spanKey(span) === selectedKey) ?? null;

  // Reset paging when the filters change so "Load more" starts from the top.
  // Render-time adjustment, not an effect.
  const filterSignature = `${filter}|${statusFilter}|${fromMs}|${toMs}`;
  const [prevFilterSignature, setPrevFilterSignature] =
    useState(filterSignature);
  if (filterSignature !== prevFilterSignature) {
    setPrevFilterSignature(filterSignature);
    setVisibleCount(PAGE_SIZE);
  }

  // Arriving from a log's "View trace": select that task, page it into the
  // list, scroll its row into view, then drop the param so a later pick is not
  // re-fought.
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
    const index = groups.findIndex((group) => hasTrace(group, focusTraceId));
    if (index === -1) {
      // The trace is in the buffer but a filter is hiding it: clear the filters
      // so it lists, then let the effect re-run and select it. Only a trace
      // absent from the whole buffer is a candidate for a Tempo fetch.
      if (allGroups.some((group) => hasTrace(group, focusTraceId))) {
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
    setSelectedTaskKey(spanKey(groups[index].root));
    // A task beyond the current page isn't listed yet: page it in and finish
    // on the re-run (visibleCount is a dep).
    if (index >= visibleCount) {
      setVisibleCount(index + 1);

      return;
    }
    const target = document.getElementById(
      `task-${groups[index].root.traceId}`,
    );
    if (!target) return;
    focusedRef.current = focusKey;
    target.scrollIntoView({ block: "nearest" });
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

  // j and k walk the task list. `/` is the toolbar's own table.filter binding.
  // Not in SHORTCUTS: `k` there is the canvas's Add skill, and a key is claimed
  // once.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "j" && event.key !== "k") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[role=dialog]")
      ) {
        return;
      }
      const index = selectedGroup ? groups.indexOf(selectedGroup) : -1;
      const nextIndex = Math.min(
        groups.length - 1,
        Math.max(0, index + (event.key === "j" ? 1 : -1)),
      );
      const next = groups[nextIndex];
      if (!next) return;
      event.preventDefault();
      // Stepping past the last listed task pages the next one in.
      if (nextIndex >= visibleCount) setVisibleCount(nextIndex + 1);
      setSelectedTaskKey(spanKey(next.root));
      requestAnimationFrame(() =>
        document
          .getElementById(`task-${next.root.traceId}`)
          ?.scrollIntoView({ block: "nearest" }),
      );
    }
    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [groups, selectedGroup, visibleCount]);

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

  // Jump to another trace (a subagent's "↳ from parent" link, a next run).
  // Reuses the `?trace=` focus effect above, which selects and scrolls to it.
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

  // Re-enters the failed task's conversation with `continue: true` on the
  // stage's run endpoint. Keyed by trace, so a second click cannot fire while
  // the first is live.
  const continueTask = async (root: ObservabilitySpanRow): Promise<void> => {
    const settle = (error: string | null): void =>
      setContinueAttempts((current) =>
        new Map(current).set(root.traceId, { error: error }),
      );
    const endpoint = resolveCoreEndpoint();
    if (!endpoint.ok) return settle(endpoint.message);
    if (!apiKey || !root.endpointId || !root.agentId || !root.conversationKey) {
      return settle(
        "Cannot continue: the task has no endpoint, agent, or conversation",
      );
    }
    settle(null);
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
      if (response.ok) return;
      const payload = (await response.json()) as {
        error?: string | { message?: string };
      };
      const error =
        typeof payload.error === "string"
          ? payload.error
          : payload.error?.message;
      settle(error ?? `Continue failed (${response.status})`);
    } catch (err) {
      settle(err instanceof Error ? err.message : "Continue failed");
    }
  };

  const clearFilters = (): void => {
    setFilter("");
    setStatusFilter("all");
    setFromTime("");
    setToTime("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <ObservabilityToolbar
        search={filter}
        onSearchChange={setFilter}
        searchPlaceholder="Search tasks, or status: channel: tool: error: trace:"
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
          selectedSpan &&
          selectedGroup && (
            <DetailPanel
              title={spanLabel(selectedSpan)}
              meta={
                <div className="mt-0.5 flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
                  <span>{kindTheme(selectedSpan.kind).word}</span>
                  <StatusDot
                    tone={
                      isStale(selectedSpan, isTaskRunning(selectedGroup.root))
                        ? "ended"
                        : STATUS_TONE[selectedSpan.status]
                    }
                    label={selectedSpan.status}
                  />
                  <span className="font-mono">
                    {spanMetaLine(selectedSpan)}
                  </span>
                </div>
              }
              onClose={() => setSelectedKey(null)}
            >
              <SpanDetails span={selectedSpan} />
            </DetailPanel>
          )
        }
      >
        <div className="flex h-full min-h-0 flex-col md:flex-row">
          <div
            data-scroll-pane
            className="max-h-72 shrink-0 overflow-auto border-b border-border md:max-h-none md:w-80 md:border-r md:border-b-0"
          >
            {visibleGroups.map((group) => (
              <TaskListRow
                key={spanKey(group.root)}
                group={group}
                isSelected={group === selectedGroup}
                onSelect={() => setSelectedTaskKey(spanKey(group.root))}
              />
            ))}
            {groups.length === 0 && (
              <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                {entries.length === 0
                  ? emptyStreamMessage(history, error, "traces", "7 days")
                  : "No tasks match the current filters."}
              </p>
            )}
            {remaining > 0 && (
              <div className="p-2 text-center">
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
          </div>

          <div
            data-scroll-pane
            className="min-h-0 min-w-0 flex-1 overflow-auto"
          >
            {selectedGroup && (
              <TaskWaterfall
                attempt={continueAttempts.get(selectedGroup.root.traceId)}
                onContinue={() => void continueTask(selectedGroup.root)}
                view={{
                  expanded: expanded,
                  focusTraceId: focusTraceId,
                  group: selectedGroup,
                  onFocusTrace: focusTrace,
                  onSelect: (key) =>
                    setSelectedKey((current) => (current === key ? null : key)),
                  selectedKey: selectedKey,
                  toggle: toggle,
                }}
              />
            )}
          </div>
        </div>
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

function formatDuration(ms: number): string {
  // A wait on a person runs minutes to days, where seconds stop reading well.
  if (ms >= 3_600_000) {
    return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  }
  if (ms >= 60_000) {
    return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  }
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

// Only a failed top-level task can be continued: a subtask belongs to its
// parent's run, and a task that finished has nothing to pick up.
function canContinue(group: SpanGroup): boolean {
  return (
    (group.root.kind === "task" || group.root.kind === "cron") &&
    group.status === "error"
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

/**
 * Newest task first. A task is every run one request started: the passes that
 * share its event id, the runs an answer or finished job resumed (task.root_id),
 * and its subagents (parent.trace_id).
 */
export function groupSpans(spans: ObservabilitySpanRow[]): SpanGroup[] {
  const roots = spans.filter((span) => isRootSpanKind(span.kind));
  const rootByTrace = new Map(roots.map((root) => [root.traceId, root]));
  const runsByTask = new Map<string, ObservabilitySpanRow[]>();
  for (const root of roots) {
    const key = taskKey(root, rootByTrace);
    runsByTask.set(key, [...(runsByTask.get(key) ?? []), root]);
  }
  const childrenByTrace = new Map<string, ObservabilitySpanRow[]>();
  for (const span of spans) {
    if (isRootSpanKind(span.kind)) continue;
    const children = childrenByTrace.get(span.traceId) ?? [];
    children.push(span);
    childrenByTrace.set(span.traceId, children);
  }

  const groups = [...runsByTask.values()]
    .map((runs) => taskGroup(runs, childrenByTrace))
    .sort((left, right) => right.root.startTimeMs - left.root.startTimeMs);

  // Walk newest to oldest, so the last task seen per conversation is the next one.
  const newerRun = new Map<string, ObservabilitySpanRow>();
  for (const group of groups) {
    const { root } = group;
    if (root.kind === "subtask" || !root.conversationKey) continue;
    const conversation = `${root.agentId}:${root.conversationKey}`;
    group.nextRun = newerRun.get(conversation) ?? null;
    newerRun.set(conversation, root);
  }

  return groups;
}

/** The task list's failure cause: "rate limit", or the start of the error. */
export function failureCause(group: SpanGroup): string | null {
  if (group.status !== "error") return null;
  const failed = group.spans.filter((span) => span.error);
  const error = (
    failed.findLast((span) => isRootSpanKind(span.kind)) ?? failed[0]
  )?.error;
  if (!error) return null;
  if (RATE_LIMIT.test(error)) return "rate limit";

  return error.length > CAUSE_CHARS
    ? `${error.slice(0, CAUSE_CHARS).trimEnd()}…`
    : error;
}

/**
 * The waterfall's sibling rows: runs of two or more model steps whose tool
 * calls all go to one tool fold into one row, everything else stays a span.
 */
export function foldSteps(
  siblings: ObservabilitySpanRow[],
  childrenByParent: Map<string, ObservabilitySpanRow[]>,
): WaterfallItem[] {
  const runs: Array<{ tool: string | null; spans: ObservabilitySpanRow[] }> =
    [];
  for (const span of siblings) {
    const tool = soleToolName(span, childrenByParent);
    const last = runs.at(-1);
    if (tool !== null && last?.tool === tool) {
      last.spans.push(span);
    } else {
      runs.push({ tool: tool, spans: [span] });
    }
  }

  return runs.flatMap(({ tool, spans }): WaterfallItem[] =>
    tool !== null && spans.length > 1
      ? [{ type: "fold", fold: stepFold(tool, spans, childrenByParent) }]
      : spans.map((span): WaterfallItem => ({ type: "span", span: span })),
  );
}

/** Whether a task passes the search box: every field token, then the free text. */
export function matchesTaskQuery(group: SpanGroup, query: TaskQuery): boolean {
  if (
    !query.fields.every(({ field, value }) =>
      QUERY_MATCHERS[field](group, value),
    )
  ) {
    return false;
  }

  return (
    !query.text ||
    group.spans.some((span) => spanSearchText(span).includes(query.text))
  );
}

/**
 * Splits the search box into `field:value` tokens and free words. An unknown
 * field is a free word; a known field with no value yet is dropped while typing.
 */
export function parseTaskQuery(input: string): TaskQuery {
  const fields: TaskQuery["fields"] = [];
  const words: string[] = [];
  for (const token of input.trim().toLowerCase().split(/\s+/)) {
    if (!token) continue;
    const colon = token.indexOf(":");
    const field = token.slice(0, colon);
    if (colon > 0 && isTaskQueryField(field)) {
      const value = token.slice(colon + 1);
      if (value) fields.push({ field: field, value: value });
      continue;
    }
    words.push(token);
  }

  return { fields: fields, text: words.join(" ") };
}

/** Where a task came in, from its conversation key; a cron root is Cron. */
export function taskChannel(root: ObservabilitySpanRow): string {
  if (root.kind === "cron") return "Cron";
  const key = unscopedConversationKey(root.conversationKey ?? "");

  return (
    CHANNEL_PREFIXES.find(({ prefix }) => key.startsWith(prefix))?.label ??
    "API"
  );
}

/**
 * The conversation key a person would recognise: core scopes stored keys as
 * `acct:<account>:agent:<agent>:<key>`, so the tail is the channel's own key.
 */
function unscopedConversationKey(key: string): string {
  return key.replace(/^acct:[^:]+:agent:[^:]+:/, "");
}

/** Whether any run of the task is that trace. */
function hasTrace(group: SpanGroup, traceId: string): boolean {
  return group.spans.some(
    (span) => isRootSpanKind(span.kind) && span.traceId === traceId,
  );
}

/** The request a root belongs to. A subagent follows its parent up the chain. */
function taskKey(
  root: ObservabilitySpanRow,
  rootByTrace: Map<string, ObservabilitySpanRow>,
): string {
  let current = root;
  const seen = new Set<string>();
  while (current.kind === "subtask" && !seen.has(current.traceId)) {
    seen.add(current.traceId);
    const parent = rootByTrace.get(
      String(current.attributes?.["parent.trace_id"]),
    );
    if (!parent) return current.traceId;
    current = parent;
  }
  const taskId =
    current.attributes?.["task.root_id"] ?? current.attributes?.["task.id"];

  return typeof taskId === "string" && taskId ? taskId : current.traceId;
}

/** One task's rows, window and status, from its runs and their children. */
function taskGroup(
  runs: ObservabilitySpanRow[],
  childrenByTrace: Map<string, ObservabilitySpanRow[]>,
): SpanGroup {
  runs.sort((left, right) => left.startTimeMs - right.startTimeMs);
  const parentRuns = runs.filter((run) => run.kind !== "subtask");
  const root = parentRuns[0] ?? runs[0];
  const runSpanIdByTrace = new Map(
    runs.map((run) => [run.traceId, run.spanId]),
  );
  const waits = parentRuns.flatMap((run, index) =>
    WAIT_BAR[run.status]
      ? [waitSpan(run, parentRuns[index + 1], root.spanId)]
      : [],
  );
  const children = runs.flatMap(
    (run) => childrenByTrace.get(run.traceId) ?? [],
  );
  const members = [
    ...children,
    ...runs.filter((run) => run !== root),
    ...waits,
  ];
  const spanIds = new Set([root.spanId, ...members.map((span) => span.spanId)]);
  const childrenByParent = new Map<string, ObservabilitySpanRow[]>();
  for (const member of members) {
    // A subagent nests under the run that started it, a later pass or a wait
    // under the task row. Orphans (a parent that never arrived) fall back to
    // their own run so they still render.
    const parentId =
      member.parentSpanId && spanIds.has(member.parentSpanId)
        ? member.parentSpanId
        : member.kind === "subtask"
          ? (runSpanIdByTrace.get(
              String(member.attributes?.["parent.trace_id"]),
            ) ?? root.spanId)
          : isRootSpanKind(member.kind)
            ? root.spanId
            : (runSpanIdByTrace.get(member.traceId) ?? root.spanId);
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(member);
    childrenByParent.set(parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((left, right) => left.startTimeMs - right.startTimeMs);
  }

  const last = parentRuns.at(-1) ?? root;
  const live = isTaskRunning(last);
  // An open wait runs until now, which would stretch the window; its row shows
  // the elapsed time instead.
  const timed = [root, ...members].filter(
    (span) => span.attributes?.["wait.open"] !== true,
  );
  const windowStart = Math.min(...timed.map((span) => span.startTimeMs));
  const windowEnd = Math.max(
    ...timed.map((span) =>
      isStale(span, isRootSpanKind(span.kind) ? isTaskRunning(span) : live)
        ? span.startTimeMs
        : span.endTimeMs,
    ),
  );
  const subagentRunning = runs.some(
    (run) => run.kind === "subtask" && isTaskRunning(run),
  );

  return {
    root: root,
    status: last.status === "ok" && subagentRunning ? "waiting" : last.status,
    live: live,
    issueCount: children.filter(
      (span) => span.kind === "tool.call" && span.status === "error",
    ).length,
    childrenByParent: childrenByParent,
    spans: [root, ...members],
    windowStart: windowStart,
    windowSpan: Math.max(1, windowEnd - windowStart),
    taskDurationMs: Math.max(windowEnd - root.startTimeMs, 1),
    nextRun: null,
  };
}

/**
 * The wait after a run that closed on something open: until the next run of the
 * task starts, or still open when there is none.
 */
function waitSpan(
  run: ObservabilitySpanRow,
  next: ObservabilitySpanRow | undefined,
  parentSpanId: string,
): ObservabilitySpanRow {
  const waitingOn = run.attributes?.["task.waiting_on"];
  const endTimeMs = next ? next.startTimeMs : Date.now();

  return {
    traceId: run.traceId,
    spanId: `${run.spanId}:wait`,
    parentSpanId: parentSpanId,
    name: WAIT_SPAN_NAME,
    kind: "phase",
    startTimeMs: run.endTimeMs,
    endTimeMs: endTimeMs,
    durationMs: Math.max(0, endTimeMs - run.endTimeMs),
    status: run.status,
    endpointId: run.endpointId,
    agentId: run.agentId,
    conversationKey: run.conversationKey,
    attributes: {
      "phase.name":
        typeof waitingOn === "string" && waitingOn in WAITING_ON_LABEL
          ? WAITING_ON_LABEL[waitingOn as TaskWaitingOn]
          : TASK_STATUS_WORD[run.status].toLowerCase(),
      ...(typeof waitingOn === "string"
        ? { "task.waiting_on": waitingOn }
        : {}),
      ...(next ? {} : { "wait.open": true }),
    },
  };
}

/** A task's dot: a stale "running" reads as ended. */
function groupTone(group: SpanGroup): StatusTone {
  return group.status === "running" && !group.live
    ? "ended"
    : STATUS_TONE[group.status];
}

/** Whether a search token's prefix names a field the search box understands. */
function isTaskQueryField(field: string): field is TaskQueryField {
  return Object.hasOwn(QUERY_MATCHERS, field);
}

/** The one named tool every tool call of a model step went to, or null. */
function soleToolName(
  span: ObservabilitySpanRow,
  childrenByParent: Map<string, ObservabilitySpanRow[]>,
): string | null {
  if (span.kind !== "model.step") return null;
  const names = new Set(
    (childrenByParent.get(span.spanId) ?? [])
      .filter((child) => child.kind === "tool.call")
      .map((child) => child.attributes?.["tool.name"]),
  );
  const [name] = names;

  return names.size === 1 && typeof name === "string" ? name : null;
}

/** The folded row for steps that all called `tool`, spanning first start to last end. */
function stepFold(
  tool: string,
  steps: ObservabilitySpanRow[],
  childrenByParent: Map<string, ObservabilitySpanRow[]>,
): StepFold {
  const first = steps[0];
  const firstNumber = numericAttribute(first, "agent.step_number");
  const lastNumber = numericAttribute(
    steps[steps.length - 1],
    "agent.step_number",
  );
  const range =
    firstNumber !== undefined && lastNumber !== undefined
      ? `step ${firstNumber + 1}-${lastNumber + 1}`
      : "steps";
  const calls = steps.reduce(
    (count, step) =>
      count +
      (childrenByParent.get(step.spanId) ?? []).filter(
        (child) => child.kind === "tool.call",
      ).length,
    0,
  );
  const endTimeMs = Math.max(...steps.map((step) => step.endTimeMs));

  return {
    label: `${range} ${tool} ×${calls}`,
    steps: steps,
    span: {
      ...first,
      spanId: `${first.spanId}:fold`,
      endTimeMs: endTimeMs,
      durationMs: steps.reduce((sum, step) => sum + step.durationMs, 0),
      // A failed tool call leaves its step ok, so the fold looks at both.
      status: steps.some(
        (step) =>
          step.status === "error" ||
          (childrenByParent.get(step.spanId) ?? []).some(
            (child) => child.status === "error",
          ),
      )
        ? "error"
        : steps.some((step) => step.status === "running")
          ? "running"
          : "ok",
      attributes: {},
    },
  };
}

/** A subagent's parent trace, for its jump link. */
function parentTraceOf(span: ObservabilitySpanRow): string | undefined {
  const parentTraceId = span.attributes?.["parent.trace_id"];

  return span.kind === "subtask" && typeof parentTraceId === "string"
    ? parentTraceId || undefined
    : undefined;
}

/** A row's name. A later run nested under its task reads as resumed. */
function rowLabel(span: ObservabilitySpanRow, isTaskRow: boolean): string {
  return !isTaskRow && (span.kind === "task" || span.kind === "cron")
    ? "resumed"
    : spanLabel(span);
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
  const barColor =
    (span.name === WAIT_SPAN_NAME ? WAIT_BAR[span.status] : undefined) ??
    kindTheme(span.kind).bar;
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
        className="absolute top-1/2 left-(--bar-left) flex h-2 w-(--bar-width) -translate-y-1/2 overflow-hidden rounded-sm"
        style={{ "--bar-left": `${leftPct}%`, "--bar-width": `${widthPct}%` }}
        title={title}
      >
        {ttftFrac > 0 && (
          <div
            className="h-full w-(--ttft-width) shrink-0 bg-info/25"
            style={{ "--ttft-width": `${ttftFrac * 100}%` }}
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
 * Continue for a failed task in the waterfall header: the button, "Continuing…"
 * until the continuation's trace arrives, then a link to that next run.
 */
function ContinueAction({
  attempt,
  nextRun,
  onContinue,
  onFocusTrace,
}: {
  attempt: ContinueAttempt | undefined;
  nextRun: ObservabilitySpanRow | null;
  onContinue: () => void;
  onFocusTrace: (traceId: string) => void;
}): React.JSX.Element {
  const pending = attempt?.error === null && !nextRun;
  const label = nextRun
    ? attempt
      ? "Continued ↗"
      : "Next run ↗"
    : pending
      ? "Continuing…"
      : attempt
        ? "Retry"
        : "Continue";
  const onClick = (): void => {
    if (nextRun) {
      onFocusTrace(nextRun.traceId);
    } else {
      onContinue();
    }
  };

  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={pending}
        onClick={onClick}
        className={cn("cursor-pointer", pending && "cursor-not-allowed")}
      >
        {label}
      </Button>
      {attempt?.error && !nextRun && (
        <span className="text-destructive">{attempt.error}</span>
      )}
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
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {span.error}
        </div>
      )}
      {/* Flat sections: a clickable header row over a soft-tinted payload surface.
          No bordered card around each one, which would nest a box in a box. */}
      {(sections.length > 0 || rows.length > 0) && (
        <div className="min-w-0 divide-y divide-border/40 rounded-md bg-card/30">
          {sections.map(({ key, label, summary, value }) => (
            <DetailPayload
              key={key}
              label={label}
              summary={summary}
              value={value}
            />
          ))}
          {rows.length > 0 && (
            <DetailFields
              label="Details"
              rows={rows}
              summary={
                typeof modelId === "string" ? modelId : `${rows.length} fields`
              }
            />
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

/**
 * One waterfall row. The task row (depth 0) is always open and reads the whole
 * request's status and duration. `label` names a folded run of steps.
 */
function SpanRow({
  span,
  depth,
  label,
  isExpanded,
  hasChildren,
  onToggle,
  isSelected,
  onClick,
  group,
  taskRunning,
  highlighted,
  inSubagent,
  onFocusTrace,
}: {
  span: ObservabilitySpanRow;
  depth: number;
  label?: string;
  isExpanded: boolean;
  hasChildren: boolean;
  onToggle: () => void;
  isSelected: boolean;
  onClick: () => void;
  group: SpanGroup;
  taskRunning: boolean;
  highlighted: boolean;
  inSubagent: boolean;
  onFocusTrace: (traceId: string) => void;
}): React.JSX.Element {
  // A subagent links to its parent only when the parent is not in view to
  // nest under.
  const isTaskRow = depth === 0;
  const name = label ?? rowLabel(span, isTaskRow);
  const parentTraceId = isTaskRow ? parentTraceOf(span) : undefined;
  const durationMs = isTaskRow ? group.taskDurationMs : span.durationMs;

  return (
    <tr
      onClick={onClick}
      className={cn(
        "cursor-pointer border-b border-border/40 transition-colors hover:bg-accent/20",
        isSelected && "bg-accent/30",
        !isRootSpanKind(span.kind) && "text-foreground/80",
        highlighted && "bg-info/10 ring-1 ring-inset ring-info/40",
      )}
    >
      <td
        className={cn(
          "px-3 py-1.5 font-mono whitespace-nowrap tabular-nums text-muted-foreground",
          inSubagent && "border-l-2 border-l-span-subtask/70",
        )}
        title={new Date(span.startTimeMs).toLocaleString()}
      >
        {formatTime(span.startTimeMs)}
      </td>
      <td
        className="py-1.5 pr-3 pl-(--row-indent)"
        style={{ "--row-indent": `${depth * 18 + 12}px` }}
      >
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
          <span className="min-w-0 truncate" title={name}>
            {name}
            <span className="ml-2 text-muted-foreground">
              {kindTheme(span.kind).word}
            </span>
          </span>
          {parentTraceId && (
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
        <RowStatus
          span={span}
          group={isTaskRow ? group : undefined}
          taskRunning={taskRunning}
        />
      </td>
      <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap tabular-nums">
        {durationMs > 0 ? formatDuration(durationMs) : "—"}
      </td>
      <td className="px-3 py-1.5">
        <TimelineBar
          span={
            isTaskRow
              ? {
                  ...span,
                  endTimeMs: span.startTimeMs + durationMs,
                  durationMs: durationMs,
                }
              : span
          }
          windowStart={group.windowStart}
          windowSpan={group.windowSpan}
          taskRunning={taskRunning}
        />
      </td>
    </tr>
  );
}

/**
 * A task row reads the whole request's status as a dot and a word; any other
 * row shows its own span's dot.
 */
function RowStatus({
  span,
  group,
  taskRunning,
}: {
  span: ObservabilitySpanRow;
  group: SpanGroup | undefined;
  taskRunning: boolean;
}): React.JSX.Element {
  if (!group) {
    return (
      <StatusDot
        tone={isStale(span, taskRunning) ? "ended" : STATUS_TONE[span.status]}
        label={span.status}
      />
    );
  }

  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <StatusDot tone={groupTone(group)} label={group.status} />
      {TASK_STATUS_WORD[group.status]}
    </span>
  );
}

/**
 * The selected task on the right: its request, conversation and trace, Continue
 * when it failed, then its waterfall scaled to that task alone.
 */
function TaskWaterfall({
  attempt,
  onContinue,
  view,
}: {
  attempt: ContinueAttempt | undefined;
  onContinue: () => void;
  view: WaterfallView;
}): React.JSX.Element {
  const { root } = view.group;
  const request = spanLabel(root);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium" title={request}>
          {request}
        </span>
        {root.conversationKey && (
          <Badge
            variant="outline"
            className="max-w-48 truncate font-mono"
            title={root.conversationKey}
          >
            {unscopedConversationKey(root.conversationKey)}
          </Badge>
        )}
        <Badge variant="outline" className="font-mono" title={root.traceId}>
          {root.traceId.slice(0, 8)}
        </Badge>
        {canContinue(view.group) && (
          <ContinueAction
            attempt={attempt}
            nextRun={view.group.nextRun}
            onContinue={onContinue}
            onFocusTrace={view.onFocusTrace}
          />
        )}
      </div>
      <table className="w-full min-w-xl table-fixed text-xs">
        <colgroup>
          <col className="w-22" />
          <col />
          <col className="w-20" />
          <col className="w-19" />
          <col className="w-[22%]" />
        </colgroup>
        <thead className="sticky top-0 z-10 border-b border-border bg-card/95">
          <tr className="text-left text-muted-foreground">
            <th className="px-3 py-2 font-medium">Started</th>
            <th className="px-3 py-2 font-medium">Span</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Duration</th>
            <th className="px-3 py-2 font-medium">Timeline</th>
          </tr>
        </thead>
        <tbody>{renderSpanRows(root, 0, view.group.live, false, view)}</tbody>
      </table>
    </>
  );
}

/**
 * One task in the left list: dot, request and duration, then start time,
 * channel, steps, subagents and the failure cause. The id is the `?trace=`
 * focus target.
 */
function TaskListRow({
  group,
  isSelected,
  onSelect,
}: {
  group: SpanGroup;
  isSelected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const { root, spans } = group;
  const steps = spans.filter((span) => span.kind === "model.step").length;
  const subagents = spans.filter((span) => span.kind === "subtask").length;
  const cause = failureCause(group);
  const request = spanLabel(root);

  return (
    <button
      type="button"
      id={`task-${root.traceId}`}
      onClick={onSelect}
      aria-current={isSelected || undefined}
      className={cn(
        "block w-full cursor-pointer border-b border-border/40 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/20",
        isSelected && "bg-accent/30",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <StatusDot tone={groupTone(group)} label={group.status} />
        <span className="min-w-0 flex-1 truncate" title={request}>
          {request}
        </span>
        <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
          {formatDuration(group.taskDurationMs)}
        </span>
      </span>
      <span className="mt-0.5 block truncate pl-4 text-muted-foreground">
        {formatDateTime(root.startTimeMs)} · {taskChannel(root)} · {steps} step
        {steps === 1 ? "" : "s"}
        {subagents > 0 &&
          ` · ${subagents} subagent${subagents === 1 ? "" : "s"}`}
        {cause && <span className="text-destructive"> · {cause}</span>}
      </span>
    </button>
  );
}

/**
 * A span's row, its inline detail when selected, then its children (steps
 * folded) when open. `enclosingRootLive` is whether the nearest enclosing root
 * run is live. A subagent subtask is itself a root: it runs independently (the
 * parent task pass can finalize while the subagent is still working), so it is
 * judged by its own freshness, and its descendants inherit the subtask's
 * liveness, not the parent task's. `inSubagent` marks a subagent and all it ran.
 */
function renderSpanRows(
  span: ObservabilitySpanRow,
  depth: number,
  enclosingRootLive: boolean,
  inSubagent: boolean,
  view: WaterfallView,
): ReactNode[] {
  const key = spanKey(span);
  const isTaskRow = depth === 0;
  const isExpanded = isTaskRow || view.expanded.has(key);
  const isSelected = key === view.selectedKey;
  const children = view.group.childrenByParent.get(span.spanId) ?? [];
  const isRoot = isRootSpanKind(span.kind);
  // A root is judged on its own freshness; a child on its enclosing root's liveness.
  const rootLive = isRoot ? isTaskRunning(span) : enclosingRootLive;
  const subagent = inSubagent || span.kind === "subtask";
  const rows: ReactNode[] = [
    <SpanRow
      key={`row:${key}`}
      span={span}
      depth={depth}
      isExpanded={isExpanded}
      hasChildren={!isTaskRow && children.length > 0}
      onToggle={() => view.toggle(key)}
      isSelected={isSelected}
      onClick={() => view.onSelect(key)}
      group={view.group}
      taskRunning={rootLive}
      highlighted={isRoot && span.traceId === view.focusTraceId}
      inSubagent={subagent}
      onFocusTrace={view.onFocusTrace}
    />,
  ];
  if (!isExpanded) return rows;
  for (const item of foldSteps(children, view.group.childrenByParent)) {
    rows.push(
      ...(item.type === "span"
        ? renderSpanRows(item.span, depth + 1, rootLive, subagent, view)
        : renderFoldRows(item.fold, depth + 1, rootLive, subagent, view)),
    );
  }

  return rows;
}

/** A folded run of steps: one row that opens onto the individual steps. */
function renderFoldRows(
  fold: StepFold,
  depth: number,
  enclosingRootLive: boolean,
  inSubagent: boolean,
  view: WaterfallView,
): ReactNode[] {
  const key = spanKey(fold.span);
  const isExpanded = view.expanded.has(key);
  const rows: ReactNode[] = [
    <SpanRow
      key={`row:${key}`}
      span={fold.span}
      depth={depth}
      label={fold.label}
      isExpanded={isExpanded}
      hasChildren
      onToggle={() => view.toggle(key)}
      isSelected={false}
      onClick={() => view.toggle(key)}
      group={view.group}
      taskRunning={enclosingRootLive}
      highlighted={false}
      inSubagent={inSubagent}
      onFocusTrace={view.onFocusTrace}
    />,
  ];
  if (!isExpanded) return rows;
  for (const step of fold.steps) {
    rows.push(
      ...renderSpanRows(step, depth + 1, enclosingRootLive, inSubagent, view),
    );
  }

  return rows;
}
