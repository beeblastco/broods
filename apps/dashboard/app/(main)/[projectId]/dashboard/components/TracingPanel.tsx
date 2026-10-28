"use client";

import {
  DetailFields,
  DetailPayload,
  type DetailRow,
  PayloadBody,
} from "@/app/components/DetailSections";
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { DitherAvatarSVG } from "@/app/components/DitherAvatar";
import {
  STATUS_TONE_BG,
  StatusDot,
  type StatusTone,
} from "@/app/components/StatusDot";
import { IconTooltip } from "@/app/components/IconTooltip";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/app/components/ui/trace";
import {
  isRootSpanKind,
  TRACE_RETENTION_DAYS,
  useObservabilityStream,
  type ObservabilitySpanRow,
  type TaskWaitingOn,
} from "@/app/hooks/useObservabilityStream";
import { agentEndpointPath, resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { formatNumber } from "@/app/lib/formatNumber";
import {
  formatDateTime,
  formatDuration,
  formatTime,
} from "@/app/lib/formatTime";
import {
  effectiveWindow,
  parseQuery,
  rangeMs,
  type Query,
  type RangePreset,
  type TimeWindow,
} from "@/app/lib/queryTokens";
import { isEditableTarget } from "@/app/lib/shortcuts";
import { parseAsTraceId, TRACE_VIEW } from "@/app/lib/urlState";
import { cn } from "@/app/lib/utils";
import { CopyTextButton } from "@/app/components/CopyButton";
import { agentDebugPrompt } from "@/app/lib/agentDebugPrompt";
import {
  ArrowUpRight,
  Brain,
  ChevronRight,
  ChevronsLeft,
  FileText,
  GitPullRequestArrow,
  MessageCircleQuestionMark,
  MessageSquare,
  Terminal,
  TriangleAlert,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { debounce, useQueryState } from "nuqs";
import {
  estimateModelTokenCost,
  type ModelTokenRates,
} from "@broods/convex/model/modelPricing";
import { useModelRates } from "@/app/hooks/useModelRates";
import {
  formatUsd,
  modelKey,
  runModel,
  stepTokens,
  type ModelRef,
} from "@/app/lib/modelCost";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  emptyStreamMessage,
  ObservabilityToolbar,
  type VolumePoint,
} from "./ObservabilityToolbar";
import { LoadMore } from "@/app/components/LoadMore";
import { useNow } from "@/app/hooks/useNow";
import { useObservabilityView } from "@/app/hooks/useObservabilityView";
import { useIsMobile } from "@/app/hooks/useIsMobile";
import { useRemembered } from "@/app/hooks/useRemembered";
import { toErrorMessage } from "@/app/lib/errors";

interface Props {
  projectSlug: string | undefined;
  stageSlug: string | undefined;
  apiKey: string | undefined;
}

// Task groups rendered before the "Load more" pager.
const PAGE_SIZE = 50;

type SpanStatus = ObservabilitySpanRow["status"];

// A Continue click on one failed task. `error` is null from the click until
// the continuation's trace arrives, which then replaces the button.
interface ContinueAttempt {
  error: string | null;
}

// One collapsible payload section, with the count line on its header.
interface PayloadSection extends DetailRow {
  open?: boolean;
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
// model.tool_results is left out as a confusing dupe. What the span produced
// comes first, then what went into the model. `open` sections start expanded.
const PAYLOAD_SECTIONS: ReadonlyArray<{
  charsKey?: string;
  countKey?: string;
  countLabel?: string;
  key: string;
  label: string;
  open?: boolean;
}> = [
  { key: "model.reasoning", label: "Reasoning" },
  { key: "model.response", label: "Response", open: true },
  { key: "model.tool_calls", label: "Tool calls" },
  { key: "tool.input", label: "Tool input", open: true },
  { key: "tool.output", label: "Tool output", open: true },
  // What a run waiting on the person asked them, on its wait row.
  { key: "task.questions", label: "Questions" },
  {
    key: "model.input",
    label: "Model input",
    countKey: "agent.message_count",
    countLabel: "messages",
    open: true,
  },
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

// One bar hue per span kind, checked for colorblind (protan/deutan) separation
// on both surfaces, including against the error red that can replace a root
// bar. Bars step deeper where a hue would wash out on one surface (task keeps
// violet-500 on dark: violet-400 collapses into model.step's blue-400 under
// deuteranopia). The shades per theme live in the --span-* tokens in globals.css.
const KIND_BAR: Record<ObservabilitySpanRow["kind"], string> = {
  task: "bg-span-task/70",
  cron: "bg-span-cron/70",
  subtask: "bg-span-subtask/70",
  "model.step": "bg-span-model/70",
  "tool.call": "bg-span-tool/70",
  phase: "bg-span-phase/70",
};

// The icon a tool call's line opens with, matched on the tool's name; any
// other tool gets the wrench.
const TOOL_ICONS: ReadonlyArray<{ icon: LucideIcon; test: RegExp }> = [
  { icon: Terminal, test: /^(bash|shell|sh|exec|terminal|run_command)/i },
  { icon: FileText, test: /^(read|write|edit|cat|ls|list|glob|grep|search)/i },
  { icon: GitPullRequestArrow, test: /github|gitlab|git_|pull_request/i },
  { icon: MessageCircleQuestionMark, test: /approv|question|ask/i },
];

// The icon a step's note line opens with; the line's title is the kind itself.
const NOTE_ICONS: Record<NoteKind, LucideIcon> = {
  thought: Brain,
  answer: MessageSquare,
  question: MessageCircleQuestionMark,
};

// Avatars a task row stacks before "+N" for the rest of its subagents.
const STACK_AVATARS = 4;

// How many characters of a tool's first string argument its line shows.
const TOOL_SUMMARY_CHARS = 80;

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
  { prefix: "slack-command:", label: "Slack" },
  { prefix: "discord:", label: "Discord" },
  { prefix: "matrix:", label: "Matrix" },
  { prefix: "gchat:", label: "Google Chat" },
  { prefix: "gh:", label: "GitHub" },
  { prefix: "linear:", label: "Linear" },
  { prefix: "pancake:", label: "Pancake" },
  { prefix: "teams:", label: "Teams" },
  { prefix: "twilio:", label: "Twilio" },
  { prefix: "zalo:", label: "Zalo" },
  { prefix: "instagram:", label: "Instagram" },
  { prefix: "messenger:", label: "Messenger" },
  { prefix: "whatsapp:", label: "WhatsApp" },
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

// The task list (w-80) plus the waterfall's min-w-xl, so dragging the detail
// divider never pushes the waterfall's columns out of view.
const TRACE_TABLE_MIN_WIDTH = 896;

// Where the browser remembers that the task list is folded to its rail.
const LIST_RAIL_KEY = "tracing:list-rail";

// A live run's clock: its now line, running bars and durations move once a second.
const LIVE_TICK_MS = 1000;

// Room past the now line on a live run, so the newest bars are not pinned to the edge.
const LIVE_HEADROOM = 1.1;

// The selected run's time scale, from TimelineClock to the parts that move on its tick.
const TimelineScaleContext = createContext<TimelineScale>({
  nowMs: null,
  spanMs: 1,
  startMs: 0,
});

// Time axis steps, smallest first; the axis takes the first that spans the run
// in AXIS_MAX_STEPS or fewer, so at most four labels share a narrow column.
const AXIS_STEPS_MS = [
  100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000,
  300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000,
];
const AXIS_MAX_STEPS = 3;

// A tick this close to the axis end would overflow the column, so it is left out.
const AXIS_LAST_TICK_PCT = 94;

// The Timeline column's width, for its colgroup and the lines over it: up to
// 40% of the waterfall while Span keeps 18rem beside Started, Status and
// Duration (15.25rem), never under 22%.
const TIMELINE_WIDTH = "clamp(22cqw, 100cqw - 33.25rem, 40cqw)";

// One matcher per `field:value` search token. Values arrive lowercased. A task
// matches on its own runs and on its subagents'.
const QUERY_MATCHERS: Record<
  TaskQueryField,
  (group: SpanGroup, value: string) => boolean
> = {
  agent: (group, value) =>
    allSpans(group).some(
      (span) =>
        isRootSpanKind(span.kind) &&
        (span.agentId ?? "").toLowerCase().startsWith(value),
    ),
  channel: (group, value) =>
    taskChannel(group.root).toLowerCase().startsWith(value),
  conv: (group, value) =>
    allSpans(group).some(
      (span) =>
        isRootSpanKind(span.kind) &&
        (span.conversationKey ?? "").toLowerCase().includes(value),
    ),
  error: (group, value) =>
    allSpans(group).some(
      (span) =>
        span.error !== undefined &&
        (RATE_LIMIT.test(value)
          ? RATE_LIMIT.test(span.error)
          : span.error.toLowerCase().includes(value)),
    ),
  status: (group, value) => STATUS_ALIASES[value] === group.status,
  tool: (group, value) =>
    allSpans(group).some(
      (span) =>
        span.kind === "tool.call" && spanLabel(span).toLowerCase() === value,
    ),
  trace: (group, value) =>
    allSpans(group).some(
      (span) =>
        isRootSpanKind(span.kind) &&
        span.traceId.toLowerCase().startsWith(value),
    ),
};

// One run: a request's first run is the row, and every later pass, answer
// continuation and wait between them nests under it. A subagent is its own
// group, listed under the request at the top of its chain, and appears in
// the parent's waterfall as one line that opens it.
export interface SpanGroup {
  root: ObservabilitySpanRow;
  // The run's status: its latest pass decides, and a finished request with a
  // subagent still running is waiting on it.
  status: SpanStatus;
  // The latest pass. It is live while isTaskRunning holds, judged when read
  // so a pass past its limit ends without waiting for the stream.
  latest: ObservabilitySpanRow;
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
  // The trace that started a subagent; null on a request's own run.
  parentTraceId: string | null;
  // Every subagent under this request, at any depth, in start order. Empty on
  // a subagent's own group.
  subagents: SpanGroup[];
}

// The `field:value` tokens the search box understands, in the placeholder's order.
export const TASK_QUERY_FIELDS = [
  "status",
  "channel",
  "agent",
  "tool",
  "error",
  "trace",
  "conv",
] as const;

type TaskQueryField = (typeof TASK_QUERY_FIELDS)[number];

// The parsed search box: every `field:value` token must match, and the free
// words, rejoined, must appear in one span's search text.
export type TaskQuery = Query<TaskQueryField>;

// Something that went wrong on one span: a failure, or retries it got past.
export interface SpanIssue {
  atMs: number;
  level: Extract<StatusTone, "error" | "warn">;
  label: string;
  text: string;
}

// A step's text lines: its reasoning, and its response, which is the question
// when the run stopped on it to ask the person.
type NoteKind = "thought" | "answer" | "question";

// The run's issues in time order, each with the rows above it that must be
// open for it to render; per span id the issues under it; and per span id
// its own.
export interface RunIssues {
  all: Array<{
    issue: SpanIssue;
    path: ObservabilitySpanRow[];
    span: ObservabilitySpanRow;
  }>;
  below: Map<string, SpanIssue[]>;
  own: Map<string, SpanIssue>;
}

// The time scale every bar, axis tick and line of the selected run reads.
// `nowMs` is set while the run is live.
interface TimelineScale {
  nowMs: number | null;
  spanMs: number;
  startMs: number;
}

// What every waterfall row of the selected run reads and calls.
interface WaterfallView {
  /** The run a pick or a link landed on, ringed for a moment. */
  focusTraceId: string | null;
  group: SpanGroup;
  issues: RunIssues;
  live: boolean;
  onFocusTrace: (traceId: string) => void;
  onSelect: (key: string) => void;
  selectedKey: string | null;
  toggle: (key: string) => void;
  // Rows the person flipped from their default: a step starts open, anything
  // else closed.
  toggled: Set<string>;
}

// One row of the task list: a request, or one of its subagents under it.
interface ListRow {
  group: SpanGroup;
  parent: SpanGroup | null;
}

// The task list on the left: its rows, or a rail of their status dots.
interface TaskListPaneProps {
  rail: boolean;
  rows: ListRow[];
  selectedGroup: SpanGroup | null;
  stackChoices: ReadonlyMap<string, boolean>;
  onSelect: (root: ObservabilitySpanRow) => void;
  onToggleStack: (root: ObservabilitySpanRow, open: boolean) => void;
  // Each task's price by `spanKey(root)`, see taskCosts.
  costs: ReadonlyMap<string, TaskCost | null>;
  // What the list says when it has no rows.
  emptyMessage: string;
  // Tasks loaded and in all, counted by request; subagent rows are extra.
  shown: number;
  total: number;
  remaining: number;
  onLoadMore: () => void;
}

/** A task's price in USD; `partial` when some of its steps have no price. */
export interface TaskCost {
  usd: number;
  partial: boolean;
}

// The list row's props, primitives and stable callbacks so the memoized row
// skips a flush that left them as they were.
interface TaskListRowProps {
  root: ObservabilitySpanRow;
  status: SpanStatus;
  tone: StatusTone;
  taskDurationMs: number;
  cause: string | null;
  isSubagent: boolean;
  // The subagents' names, newline-joined so the memo compares one string.
  subagentNames: string;
  isSelected: boolean;
  stackOpen: boolean;
  onSelect: (root: ObservabilitySpanRow) => void;
  onToggleStack: (root: ObservabilitySpanRow, open: boolean) => void;
}

export function TracingPanel({
  projectSlug,
  stageSlug,
  apiKey,
}: Props): React.JSX.Element {
  // The selected task's trace, so a link opens on it (a log's View trace,
  // an agent's link). Written on every pick, dropped when it is missing or a
  // filter changes.
  const [focusTraceId, setFocusTraceId] = useQueryState(
    "trace",
    parseAsTraceId,
  );
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  // The task list folded to a rail of status dots, so one trace gets the width.
  // Desktop only: on a phone the list stacks above the trace, so a rail of
  // full-width dot rows saves nothing.
  const [railChosen, setRail] = useRemembered(LIST_RAIL_KEY, false);
  const isMobile = useIsMobile();
  const rail = railChosen && !isMobile;
  // Whether a request's subagent rows list, where the person chose; with no
  // choice they list while the selected run is that request or under it.
  const [stackChoices, setStackChoices] = useState<
    ReadonlyMap<string, boolean>
  >(new Map());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(null);
  const {
    query: filter,
    setQuery: setFilter,
    range,
    setRange,
    window: timeWindow,
    setWindow: setTimeWindow,
  } = useObservabilityView(TRACE_VIEW);
  // A filter change drops `trace` from the URL: a link carrying a run the new
  // filters hide would reopen with them cleared. The pick on screen stays.
  // Search changes per key, so only the first one writes.
  const dropTrace = (): void => {
    if (focusTraceId !== null) void setFocusTraceId(null);
  };
  const narrowSearch = (next: string): void => {
    setFilter(next);
    dropTrace();
  };
  const narrowRange = (next: RangePreset): void => {
    setRange(next);
    dropTrace();
  };
  const narrowWindow = (next: TimeWindow | null): void => {
    setTimeWindow(next);
    dropTrace();
  };
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const now = useNow();
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

  // Memoized: the filtered list keys on it, and a fresh object each render
  // would rebuild the list, and everything downstream of it, every time.
  const bounds = useMemo(
    () => effectiveWindow(timeWindow, range, now),
    [timeWindow, range, now],
  );

  // Every request in the buffer, before filters. Focus resolution runs against
  // this so a filtered-out trace is never mistaken for one absent from history.
  const allGroups = useMemo(() => groupSpans(entries), [entries]);
  // Every run, a request's or a subagent's, by the traces it ran, for a
  // subagent's chain and a `?trace=` pick.
  const groupByTrace = useMemo(() => {
    const byTrace = new Map<string, SpanGroup>();
    for (const group of allGroups) {
      for (const run of [group, ...group.subagents]) {
        for (const traceId of runTraceIds(run)) byTrace.set(traceId, run);
      }
    }

    return byTrace;
  }, [allGroups]);

  // The filter runs on the deferred value, so typing stays responsive while a
  // full buffer is searched.
  const deferredFilter = useDeferredValue(filter);
  const groups = useMemo(() => {
    const query = parseQuery(deferredFilter, TASK_QUERY_FIELDS);

    return allGroups.filter((group) => {
      const { root } = group;
      if (root.startTimeMs < bounds.from || root.startTimeMs > bounds.to) {
        return false;
      }

      return matchesTaskQuery(group, query);
    });
  }, [allGroups, deferredFilter, bounds]);
  const points = useMemo<VolumePoint[]>(
    () =>
      allGroups.map((group) => ({
        ts: group.root.startTimeMs,
        severity: group.status === "error" ? "error" : "none",
      })),
    [allGroups],
  );

  const visibleGroups = useMemo(
    () => groups.slice(0, visibleCount),
    [groups, visibleCount],
  );
  const remaining = groups.length - visibleGroups.length;

  // The run on the right: the pick, a subagent included. With no pick, or a
  // pick the filters hid, the first listed request stands in.
  const selectedGroup = useMemo(() => {
    for (const group of visibleGroups) {
      if (spanKey(group.root) === selectedTaskKey) return group;
      const subagent = group.subagents.find(
        (candidate) => spanKey(candidate.root) === selectedTaskKey,
      );
      if (subagent) return subagent;
    }

    return visibleGroups[0] ?? null;
  }, [visibleGroups, selectedTaskKey]);
  // The list: every request, and its subagents while its stack is open.
  const listRows = useMemo<ListRow[]>(
    () =>
      visibleGroups.flatMap((group): ListRow[] => [
        { group: group, parent: null },
        ...(isStackOpen(group, selectedGroup, stackChoices)
          ? group.subagents.map((subagent): ListRow => ({
              group: subagent,
              parent: group,
            }))
          : []),
      ]),
    [visibleGroups, selectedGroup, stackChoices],
  );
  const { rates, loading: ratesLoading } = useModelRates(
    listedModels(visibleGroups),
  );
  const costs = useMemo(
    () => taskCosts(visibleGroups, rates, ratesLoading),
    [visibleGroups, rates, ratesLoading],
  );
  // The span open in the side panel, resolved against the selected run so
  // it tracks live updates and closes when its run leaves the view.
  const selectedSpan =
    selectedGroup?.spans.find((span) => spanKey(span) === selectedKey) ?? null;
  // The selected run's chain, a request down to the subagent on screen.
  const chain = useMemo(
    () => (selectedGroup ? chainFor(selectedGroup, groupByTrace) : []),
    [selectedGroup, groupByTrace],
  );

  // Reset paging when the filters change so "Load more" starts from the top.
  // Render-time adjustment, not an effect.
  const filterSignature = `${filter}|${range}|${timeWindow?.from}|${timeWindow?.to}`;
  const [prevFilterSignature, setPrevFilterSignature] =
    useState(filterSignature);
  if (filterSignature !== prevFilterSignature) {
    setPrevFilterSignature(filterSignature);
    setVisibleCount(PAGE_SIZE);
  }

  // A new `?trace=` (a log's "View trace", a link, a pick): select that run,
  // page it into the list and scroll its row into view, once per trace, so a
  // later filter edit is not re-fought.
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
  // below would otherwise swallow a repeat click on the same subagent link).
  const [refocusNonce, setRefocusNonce] = useState(0);
  useEffect(() => {
    if (!focusTraceId) return;
    const focusKey = `${focusTraceId}:${refocusNonce}`;
    if (focusedRef.current === focusKey) return;
    const index = groups.findIndex((group) => hasTrace(group, focusTraceId));
    if (index === -1) {
      // The trace is in the buffer but a filter is hiding it: clear the filters
      // so it lists, then let the effect re-run and select it. Only a trace
      // absent from the whole buffer is a candidate for a Tempo fetch.
      const hidden = allGroups.find((group) => hasTrace(group, focusTraceId));
      if (hidden) {
        setFilter("");
        setRange("30d");
        // A trace fetched by id can predate the widest preset: open a window
        // from its start, else the preset alone lists it.
        const start = hidden.root.startTimeMs;
        setTimeWindow(
          start < now - rangeMs("30d")
            ? { from: start - 1, to: Number.POSITIVE_INFINITY }
            : null,
        );

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
      void setFocusTraceId(null);

      return;
    }
    // A subagent's trace selects the subagent, under its request, whose
    // stack opens again if the person had closed it.
    const target = groupByTrace.get(focusTraceId) ?? groups[index];
    setSelectedTaskKey(spanKey(target.root));
    if (target !== groups[index]) openStack(groups[index]);
    // A request beyond the current page isn't listed yet: page it in and
    // finish on the re-run (visibleCount is a dep).
    if (index >= visibleCount) {
      setVisibleCount(index + 1);

      return;
    }
    // A subagent's row lists once its request's stack opens for it, on the
    // re-run (listRows is a dep).
    const element = document.getElementById(`task-${target.root.traceId}`);
    if (!element) return;
    focusedRef.current = focusKey;
    element.scrollIntoView({ block: "nearest" });
  }, [
    focusTraceId,
    refocusNonce,
    groups,
    allGroups,
    groupByTrace,
    listRows,
    visibleCount,
    history,
    fetchTrace,
    now,
    setFilter,
    setRange,
    setTimeWindow,
    setFocusTraceId,
  ]);

  // Drops a request's closed choice, so its subagent rows list again.
  const openStack = (request: SpanGroup): void => {
    const key = spanKey(request.root);
    setStackChoices((current) => {
      if (current.get(key) !== false) return current;
      const next = new Map(current);
      next.delete(key);

      return next;
    });
  };

  // A click or j/k pick: select the run and put its trace in the URL. The
  // focus effect is told it already ran, so it does not scan and scroll again,
  // and a held j/k writes the URL once it settles.
  const pickTask = useCallback(
    (root: ObservabilitySpanRow): void => {
      setSelectedTaskKey(spanKey(root));
      focusedRef.current = `${root.traceId}:${refocusNonce}`;
      void setFocusTraceId(root.traceId, {
        limitUrlUpdates: debounce(200),
      });
    },
    [refocusNonce, setFocusTraceId],
  );
  // A click on a request's avatar stack: list or hide its subagent rows.
  const toggleStack = useCallback(
    (root: ObservabilitySpanRow, open: boolean): void => {
      setStackChoices((current) => new Map(current).set(spanKey(root), open));
    },
    [],
  );

  // j and k walk the listed rows, open subagents included. `/` is the
  // toolbar's own table.filter binding. Not in SHORTCUTS: `k` there is the
  // canvas's Add skill, and a key is claimed once.
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
      const listed = listRows.findIndex((row) => row.group === selectedGroup);
      // A selected subagent whose stack is closed steps from its request.
      const index =
        listed !== -1
          ? listed
          : listRows.findIndex(
              (row) =>
                selectedGroup !== null &&
                row.group.subagents.includes(selectedGroup),
            );
      const nextIndex = Math.min(
        listRows.length - 1 + (remaining > 0 ? 1 : 0),
        Math.max(0, index + (event.key === "j" ? 1 : -1)),
      );
      event.preventDefault();
      // Stepping past the last listed request pages the next one in; its
      // row exists on the next frame, after the list re-rendered.
      const paged = nextIndex >= listRows.length;
      if (paged) setVisibleCount(visibleCount + 1);
      const next = paged ? groups[visibleCount] : listRows[nextIndex]?.group;
      if (!next) return;
      pickTask(next.root);
      requestAnimationFrame(() =>
        document
          .getElementById(`task-${next.root.traceId}`)
          ?.scrollIntoView({ block: "nearest" }),
      );
    }
    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [groups, listRows, remaining, selectedGroup, visibleCount, pickTask]);

  const toggle = (key: string): void => {
    setToggled((current) => flipped(current, key));
  };

  // Jump to another run (a subagent's line, a next run). Reuses the `?trace=`
  // focus effect above, which selects and scrolls to it. Bumps the nonce (not
  // the ref) so re-clicking the same link re-focuses.
  const focusTrace = useCallback(
    (traceId: string) => {
      setRefocusNonce((nonce) => nonce + 1);
      void setFocusTraceId(traceId);
    },
    [setFocusTraceId],
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
      settle(toErrorMessage(err));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ObservabilityToolbar
        search={filter}
        onSearchChange={narrowSearch}
        searchPlaceholder="Search tasks · status: channel: agent: tool: error: trace: conv:"
        searchFields={TASK_QUERY_FIELDS}
        range={range}
        onRangeChange={narrowRange}
        window={timeWindow}
        onWindowChange={narrowWindow}
        points={points}
        marker={selectedGroup?.root.startTimeMs}
        now={now}
        onRefresh={refresh}
        refreshDisabled={status === "idle"}
        refreshTitle={error ?? "Refresh traces"}
        isError={status === "error"}
      />

      {missingTrace && (
        <p
          aria-live="polite"
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs text-destructive"
        >
          <span className="truncate font-mono">
            Trace {missingTrace} is not available
            {error ? `: ${error}` : " in this stage's history"}. Traces are kept{" "}
            {TRACE_RETENTION_DAYS} days.
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
        flush
        tableMinWidth={TRACE_TABLE_MIN_WIDTH}
        detail={
          selectedSpan &&
          selectedGroup && (
            <DetailPanel
              key={selectedKey}
              title={spanLabel(selectedSpan)}
              meta={
                <div className="mt-0.5 flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
                  {selectedSpan.status !== "ok" && (
                    <StatusDot
                      tone={
                        isStale(selectedSpan, isTaskRunning(selectedGroup.root))
                          ? "ended"
                          : STATUS_TONE[selectedSpan.status]
                      }
                      label={selectedSpan.status}
                    />
                  )}
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
          <TaskListPane
            // An empty list opens with its message: with no trace selected
            // there is no header holding the fold to open it again.
            rail={rail && listRows.length > 0}
            rows={listRows}
            selectedGroup={selectedGroup}
            stackChoices={stackChoices}
            onSelect={pickTask}
            onToggleStack={toggleStack}
            costs={costs}
            emptyMessage={
              entries.length === 0
                ? emptyStreamMessage(history, error, "traces", "7 days")
                : "No tasks match the current filters."
            }
            shown={groups.length}
            total={allGroups.length}
            remaining={remaining}
            onLoadMore={() => setVisibleCount((count) => count + PAGE_SIZE)}
          />

          <div
            data-scroll-pane
            className="min-h-0 min-w-0 flex-1 overflow-auto"
          >
            {selectedGroup && (
              <TaskWaterfall
                key={spanKey(selectedGroup.root)}
                attempt={continueAttempts.get(selectedGroup.root.traceId)}
                chain={chain}
                cost={costLabel(costs.get(spanKey(selectedGroup.root)))}
                projectSlug={projectSlug}
                stageSlug={stageSlug}
                onContinue={() => void continueTask(selectedGroup.root)}
                onPickRun={pickTask}
                fold={
                  <TaskListFold
                    rail={rail}
                    onToggle={() => setRail(!railChosen)}
                  />
                }
                view={{
                  focusTraceId: focusTraceId,
                  group: selectedGroup,
                  onFocusTrace: focusTrace,
                  onSelect: (key) =>
                    setSelectedKey((current) => (current === key ? null : key)),
                  selectedKey: selectedKey,
                  toggle: toggle,
                  toggled: toggled,
                }}
              />
            )}
          </div>
        </div>
      </DetailSplit>
    </div>
  );
}

/**
 * Newest request first. A request is every run one event started: the passes
 * that share its event id and the runs an answer or finished job resumed
 * (task.root_id). A subagent (parent.trace_id) is its own group under the
 * request at the top of its chain; one whose parent never arrived lists on
 * its own.
 */
export function groupSpans(spans: ObservabilitySpanRow[]): SpanGroup[] {
  const roots = spans.filter((span) => isRootSpanKind(span.kind));
  const childrenByTrace = new Map<string, ObservabilitySpanRow[]>();
  for (const span of spans) {
    if (isRootSpanKind(span.kind)) continue;
    const children = childrenByTrace.get(span.traceId) ?? [];
    children.push(span);
    childrenByTrace.set(span.traceId, children);
  }
  const subtasksByParent = new Map<string, ObservabilitySpanRow[]>();
  for (const root of roots) {
    const parentTraceId = parentTraceOf(root);
    if (!parentTraceId) continue;
    const siblings = subtasksByParent.get(parentTraceId) ?? [];
    siblings.push(root);
    subtasksByParent.set(parentTraceId, siblings);
  }
  const runsByTask = new Map<string, ObservabilitySpanRow[]>();
  for (const root of roots) {
    if (root.kind === "subtask") continue;
    const key = taskKey(root);
    runsByTask.set(key, [...(runsByTask.get(key) ?? []), root]);
  }
  const tasks = [...runsByTask.values()].map((runs) =>
    taskGroup(runs, childrenByTrace, subtasksByParent),
  );
  const subagents = roots
    .filter((root) => root.kind === "subtask")
    .map((root) => taskGroup([root], childrenByTrace, subtasksByParent));

  const taskByTrace = new Map(
    tasks.flatMap((task) =>
      runTraceIds(task).map((traceId): [string, SpanGroup] => [traceId, task]),
    ),
  );
  const subagentByTrace = new Map(
    subagents.map((subagent): [string, SpanGroup] => [
      subagent.root.traceId,
      subagent,
    ]),
  );
  const orphans: SpanGroup[] = [];
  for (const subagent of subagents) {
    const owner = ownerOf(subagent, taskByTrace, subagentByTrace);
    if (owner) {
      owner.subagents.push(subagent);
    } else {
      orphans.push(subagent);
    }
  }

  const groups = [...tasks, ...orphans].sort(
    (left, right) => right.root.startTimeMs - left.root.startTimeMs,
  );
  for (const group of groups) {
    group.subagents.sort(
      (left, right) => left.root.startTimeMs - right.root.startTimeMs,
    );
    if (
      group.status === "ok" &&
      group.subagents.some((subagent) => isTaskRunning(subagent.root))
    ) {
      group.status = "waiting";
    }
  }

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

/**
 * Each listed task's price by `spanKey(root)`: its model steps at their run's
 * rates, a request with its subagents. `partial` when some step's model has
 * no price, so the sum is a floor; null when none has one; absent before any
 * step ran or before the first rates arrive. While a new model set `loading`,
 * a step without a rate yet is left out instead of counted as unpriced.
 */
export function taskCosts(
  groups: SpanGroup[],
  rates: Array<ModelRef & ModelTokenRates> | undefined,
  loading = false,
): Map<string, TaskCost | null> {
  const costs = new Map<string, TaskCost | null>();
  if (!rates) return costs;
  const rateByModel = new Map(rates.map((rate) => [modelKey(rate), rate]));
  const ownCost = (group: SpanGroup): TaskCost | null | undefined => {
    const runModels = new Map(
      group.spans
        .filter((span) => isRootSpanKind(span.kind))
        .map((root) => [root.traceId, runModel(root)]),
    );
    let cost: TaskCost | null | undefined;
    for (const step of group.spans) {
      if (step.kind !== "model.step") continue;
      const model = runModels.get(step.traceId);
      const rate = model ? rateByModel.get(modelKey(model)) : undefined;
      if (!rate && loading) continue;
      const priced = estimateModelTokenCost(rate, stepTokens(step));
      cost = addCost(
        cost,
        priced ? { usd: priced.total, partial: false } : null,
      );
    }

    return cost;
  };
  for (const group of groups) {
    let request: TaskCost | null | undefined;
    for (const part of [group, ...group.subagents]) {
      const cost = ownCost(part);
      if (cost === undefined) continue;
      costs.set(spanKey(part.root), cost);
      request = addCost(request, cost);
    }
    if (request !== undefined) costs.set(spanKey(group.root), request);
  }

  return costs;
}

/** The task list's failure cause: "rate limit", or the start of the error. */
export function failureCause(group: SpanGroup): string | null {
  const error = taskError(group);
  if (!error) return null;
  if (RATE_LIMIT.test(error)) return "rate limit";

  return error.length > CAUSE_CHARS
    ? `${error.slice(0, CAUSE_CHARS).trimEnd()}…`
    : error;
}

/** Whether a request passes the search box: every field token, then the free text. */
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
    allSpans(group).some((span) => spanSearchText(span).includes(query.text))
  );
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
 * The time axis ticks for a window `spanMs` long, as offsets from its start.
 * A window past the longest step (a run that waited days on a person) steps
 * in whole hours.
 */
export function axisTicks(spanMs: number): number[] {
  const step =
    AXIS_STEPS_MS.find((candidate) => spanMs / candidate <= AXIS_MAX_STEPS) ??
    Math.ceil(spanMs / AXIS_MAX_STEPS / 3_600_000) * 3_600_000;

  return Array.from(
    { length: Math.floor(spanMs / step) + 1 },
    (_, index) => index * step,
  );
}

/**
 * Every issue in the run in time order, and the issues under each span, read
 * down the same tree the waterfall renders: a subagent is one leaf line.
 * Each issue keeps the rows above it, so a click can open them.
 */
export function runIssues(group: SpanGroup): RunIssues {
  const all: RunIssues["all"] = [];
  const below = new Map<string, SpanIssue[]>();
  const own = new Map<string, SpanIssue>();
  const walk = (
    span: ObservabilitySpanRow,
    path: ObservabilitySpanRow[],
  ): SpanIssue[] => {
    const isTaskRow = span === group.root;
    const children = rowChildren(span, isTaskRow, group);
    // The task row is always open, so it is never on a path.
    const inside = isTaskRow ? path : [...path, span];
    const under = children.flatMap((child) => walk(child, inside));
    below.set(span.spanId, under);
    // A failure counts once, where it happened: core closes the open step and
    // tool with the run's error, so a span that failed with a failure under it
    // passed that one up. The task row stands for the whole request, so a
    // first pass that failed and was continued is not its issue either.
    const found = spanIssue(span);
    const passedUp =
      found?.level === "error" &&
      under.some((item) => item.level === "error" && item.text === found.text);
    const issue =
      passedUp || (isTaskRow && group.status !== "error") ? null : found;
    if (!issue) return under;
    own.set(span.spanId, issue);
    all.push({ issue: issue, path: path, span: span });

    return [issue, ...under];
  };
  walk(group.root, []);
  all.sort((left, right) => left.issue.atMs - right.issue.atMs);

  return { all: all, below: below, own: own };
}

/**
 * What went wrong on a span: it failed, or it retried a model call or a rate
 * limited tool before it went through.
 */
export function spanIssue(span: ObservabilitySpanRow): SpanIssue | null {
  if (span.status === "error") {
    return {
      atMs: span.endTimeMs,
      level: "error",
      label: "Failed",
      text: span.error ?? "",
    };
  }
  const retries = Math.max(
    (numericAttribute(span, "model.attempts") ?? 1) - 1,
    numericAttribute(span, "tool.retry.count") ?? 0,
  );
  if (retries <= 0) return null;

  return {
    atMs:
      span.startTimeMs + (numericAttribute(span, "model.retry_wait_ms") ?? 0),
    level: "warn",
    label: `Retried ${retries}×`,
    text: attemptErrors(span),
  };
}

/** Two prices summed: null only when both are, partial when either is. */
function addCost(
  sum: TaskCost | null | undefined,
  cost: TaskCost | null,
): TaskCost | null {
  if (cost === null) return sum ? { usd: sum.usd, partial: true } : null;
  if (!sum) return { usd: cost.usd, partial: cost.partial || sum === null };

  return { usd: sum.usd + cost.usd, partial: sum.partial || cost.partial };
}

/** A request's spans and its subagents', for search. */
function allSpans(group: SpanGroup): ObservabilitySpanRow[] {
  return [
    ...group.spans,
    ...group.subagents.flatMap((subagent) => subagent.spans),
  ];
}

/** The step whose response is the question a run stopped on, when it stopped on one. */
function askedStepId(
  run: ObservabilitySpanRow,
  childrenByParent: Map<string, ObservabilitySpanRow[]>,
): string | undefined {
  if (run.attributes?.["task.waiting_on"] !== "question") return undefined;

  return (childrenByParent.get(run.spanId) ?? []).findLast(
    (child) => child.kind === "model.step",
  )?.spanId;
}

/** A retried model call's failed attempts on one line; core sends them as a JSON array. */
function attemptErrors(span: ObservabilitySpanRow): string {
  const raw = attributeText(span.attributes?.["model.attempt_errors"]);
  if (!raw) return "";
  try {
    const parsed: unknown = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed.map(String).join(" · ") : raw;
  } catch {
    return raw;
  }
}

function attributeText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return value.toLocaleString();

  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A time axis tick, short enough to sit five to a column: `0`, `500ms`, `15s`, `1m 30s`, `15h`. */
function axisLabel(ms: number): string {
  if (ms === 0) return "0";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${ms / 1000}s`;
  const [major, unit, minor, minorUnit] =
    ms < 3_600_000
      ? [Math.floor(ms / 60_000), "m", (ms % 60_000) / 1000, "s"]
      : [Math.floor(ms / 3_600_000), "h", (ms % 3_600_000) / 60_000, "m"];

  return minor > 0 ? `${major}${unit} ${minor}${minorUnit}` : `${major}${unit}`;
}

// Only a failed top-level task can be continued: a subtask belongs to its
// parent's run, and a task that finished has nothing to pick up.
function canContinue(group: SpanGroup): boolean {
  return (
    (group.root.kind === "task" || group.root.kind === "cron") &&
    group.status === "error"
  );
}

/** A run's chain: the request at the top, then each subagent down to `group`. */
function chainFor(
  group: SpanGroup,
  groupByTrace: Map<string, SpanGroup>,
): SpanGroup[] {
  const chain = [group];
  const seen = new Set<string>();
  let current = group;
  while (current.parentTraceId && !seen.has(current.root.traceId)) {
    seen.add(current.root.traceId);
    const parent = groupByTrace.get(current.parentTraceId);
    if (!parent) break;
    chain.unshift(parent);
    current = parent;
  }

  return chain;
}

/** A run's price as its trace header shows it: `$0.0012`, `$0.0012+` when partial, or "not priced". */
function costLabel(cost: TaskCost | null | undefined): string | undefined {
  if (cost === undefined) return undefined;
  if (cost === null) return "not priced";

  return `${formatUsd(cost.usd)}${cost.partial ? "+" : ""}`;
}

/**
 * The footer's ` · $0.0638 · 1 not priced` over the listed requests, "" before
 * any is priced. With more pages to load it adds "shown", since the count
 * covers every matching task and the price only the loaded ones; a partial
 * price adds "+".
 */
function costTotal(
  rows: ListRow[],
  costs: ReadonlyMap<string, TaskCost | null>,
  paged: boolean,
): string {
  let total: TaskCost | null | undefined;
  let unpriced = 0;
  for (const { group, parent } of rows) {
    if (parent !== null) continue;
    const cost = costs.get(spanKey(group.root));
    if (cost === null) unpriced += 1;
    else if (cost !== undefined) total = addCost(total, cost);
  }
  const price = total
    ? ` · ${formatUsd(total.usd)}${total.partial ? "+" : ""}${paged ? " shown" : ""}`
    : "";

  return `${price}${unpriced > 0 ? ` · ${unpriced} not priced` : ""}`;
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

/** The set with `key` added when absent, removed when present. */
function flipped(current: Set<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }

  return next;
}

/** A task's dot: a stale "running" reads as ended. */
function groupTone(group: SpanGroup): StatusTone {
  return group.status === "running" && !isTaskRunning(group.latest)
    ? "ended"
    : STATUS_TONE[group.status];
}

/** Whether a request or one of its subagents ran that trace. */
function hasTrace(group: SpanGroup, traceId: string): boolean {
  return allSpans(group).some(
    (span) => isRootSpanKind(span.kind) && span.traceId === traceId,
  );
}

/** Whether a waterfall row is open: a step starts open, anything else closed, and `toggled` flips that. */
function isRowOpen(span: ObservabilitySpanRow, toggled: Set<string>): boolean {
  return (span.kind === "model.step") !== toggled.has(spanKey(span));
}

/**
 * Whether a request's subagent rows list: the person's choice for it, else
 * while the selected run is the request or one of its subagents.
 */
function isStackOpen(
  group: SpanGroup,
  selected: SpanGroup | null,
  choices: ReadonlyMap<string, boolean>,
): boolean {
  return (
    choices.get(spanKey(group.root)) ??
    (selected !== null &&
      (selected === group || group.subagents.includes(selected)))
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

/** KIND_BAR lookup with a fallback: core can ship a new span kind before
 * this dashboard build knows it, and that must not take down the panel. */
function kindBar(kind: ObservabilitySpanRow["kind"]): string {
  return KIND_BAR[kind] ?? KIND_BAR["tool.call"];
}

/** Every model the groups' runs name, subagents included. */
function listedModels(groups: SpanGroup[]): ModelRef[] {
  return [...groups, ...groups.flatMap((group) => group.subagents)].flatMap(
    (group) =>
      group.spans.flatMap((span) => {
        const model = isRootSpanKind(span.kind) ? runModel(span) : null;

        return model ? [model] : [];
      }),
  );
}

/** A step's reasoning or response when it has one; core writes the key empty on a step without. */
function noteText(span: ObservabilitySpanRow, key: string): string | undefined {
  const value = span.attributes?.[key];
  if (value === undefined || value === null) return undefined;
  const text = displayAttribute(value);

  return text === "" ? undefined : text;
}

function numericAttribute(
  span: ObservabilitySpanRow,
  key: string,
): number | undefined {
  const value = span.attributes?.[key];

  return typeof value === "number" ? value : undefined;
}

/**
 * The run a subagent lists under: the request at the top of its parent
 * chain, or the subagent at the top when the request never arrived. That
 * top subagent itself lists on its own, as does any subagent in a cycle.
 */
function ownerOf(
  subagent: SpanGroup,
  taskByTrace: Map<string, SpanGroup>,
  subagentByTrace: Map<string, SpanGroup>,
): SpanGroup | undefined {
  const seen = new Set<string>();
  let current = subagent;
  while (current.parentTraceId && !seen.has(current.root.traceId)) {
    seen.add(current.root.traceId);
    const task = taskByTrace.get(current.parentTraceId);
    if (task) return task;
    const parent = subagentByTrace.get(current.parentTraceId);
    if (!parent) return current === subagent ? undefined : current;
    current = parent;
  }

  return undefined;
}

/** A subagent's parent trace, for its link and its place in the list. */
function parentTraceOf(span: ObservabilitySpanRow): string | undefined {
  const parentTraceId = span.attributes?.["parent.trace_id"];

  return span.kind === "subtask" && typeof parentTraceId === "string"
    ? parentTraceId || undefined
    : undefined;
}

// A section shows the count that describes it; the char count is added when
// the span reports one, or stands in when there is no count at all.
function payloadSections(span: ObservabilitySpanRow): PayloadSection[] {
  return PAYLOAD_SECTIONS.flatMap(
    ({ charsKey, countKey, countLabel, ...section }): PayloadSection[] => {
      const value = displayAttribute(span.attributes?.[section.key]);
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

      return [{ ...section, summary: summary, value: value }];
    },
  );
}

/**
 * The spans listed under a row, for the waterfall and its issues alike. A
 * subagent is one leaf line: its own run lists on its own.
 */
function rowChildren(
  span: ObservabilitySpanRow,
  isTaskRow: boolean,
  group: SpanGroup,
): ObservabilitySpanRow[] {
  return span.kind === "subtask" && !isTaskRow
    ? []
    : (group.childrenByParent.get(span.spanId) ?? []);
}

/** A row's name. A later run nested under its task reads as resumed. */
function rowLabel(span: ObservabilitySpanRow): string {
  return span.kind === "task" || span.kind === "cron"
    ? "resumed"
    : spanLabel(span);
}

function spanKey(span: ObservabilitySpanRow): string {
  return `${span.traceId}:${span.spanId}`;
}

/** The span's own name: the request for a root, the agent for a subagent, the tool or step for a child. */
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
  if (span.kind === "subtask") return subagentName(span);
  const input = span.attributes?.["task.input"];
  if (typeof input === "string" && input) return input;
  const taskId = span.attributes?.["task.id"];

  return typeof taskId === "string" ? taskId : span.traceId;
}

/** Duration, total tokens when the span has them, and start time. */
function spanMetaLine(span: ObservabilitySpanRow): string {
  const tokens = spanTokens(span);

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

/** A model step's reasoning and response texts, when it has them; nothing for any other span. */
function stepNotes(span: ObservabilitySpanRow): {
  reasoning: string | undefined;
  response: string | undefined;
} {
  const isStep = span.kind === "model.step";

  return {
    reasoning: isStep ? noteText(span, "model.reasoning") : undefined,
    response: isStep ? noteText(span, "model.response") : undefined,
  };
}

/** Total tokens, in the root's spelling or a model step's. */
function spanTokens(span: ObservabilitySpanRow): number | undefined {
  return (
    numericAttribute(span, "usage.total_tokens") ??
    numericAttribute(span, "model.total_tokens")
  );
}

/**
 * The traces a run itself ran: its root and its resumed passes, never the
 * subagents it delegated to, which are runs of their own.
 */
function runTraceIds(group: SpanGroup): string[] {
  return group.spans
    .filter(
      (span) =>
        span === group.root ||
        (isRootSpanKind(span.kind) && span.kind !== "subtask"),
    )
    .map((span) => span.traceId);
}

/** Keeps a click inside a line's own control from selecting the row. */
function stopRowClick(event: MouseEvent): void {
  event.stopPropagation();
}

/** The agent a subagent run is, for its avatar and name. */
function subagentName(span: ObservabilitySpanRow): string {
  const agentId = span.attributes?.["agent.id"] ?? span.agentId;

  return typeof agentId === "string" && agentId ? agentId : "subagent";
}

/**
 * One run's rows, window and status, from its passes and their children.
 * `subtasksByParent` adds each subagent this run started as one leaf line;
 * the subagent's own spans belong to its own group.
 */
function taskGroup(
  runs: ObservabilitySpanRow[],
  childrenByTrace: Map<string, ObservabilitySpanRow[]>,
  subtasksByParent: Map<string, ObservabilitySpanRow[]>,
): SpanGroup {
  runs.sort((left, right) => left.startTimeMs - right.startTimeMs);
  const root = runs[0];
  const runSpanIdByTrace = new Map(
    runs.map((run) => [run.traceId, run.spanId]),
  );
  const waits = runs.flatMap((run, index) =>
    WAIT_BAR[run.status] ? [waitSpan(run, runs[index + 1], root.spanId)] : [],
  );
  const children = runs.flatMap(
    (run) => childrenByTrace.get(run.traceId) ?? [],
  );
  const delegates = runs.flatMap(
    (run) => subtasksByParent.get(run.traceId) ?? [],
  );
  const members = [
    ...children,
    ...runs.filter((run) => run !== root),
    ...waits,
    ...delegates,
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

  const last = runs.at(-1) ?? root;
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

  return {
    root: root,
    status: last.status,
    latest: last,
    childrenByParent: childrenByParent,
    spans: [root, ...members],
    windowStart: windowStart,
    windowSpan: Math.max(1, windowEnd - windowStart),
    taskDurationMs: Math.max(windowEnd - root.startTimeMs, 1),
    nextRun: null,
    parentTraceId: parentTraceOf(root) ?? null,
    subagents: [],
  };
}

/** The failed task's error: its latest run's, else the first span's that has one. */
function taskError(group: SpanGroup): string | null {
  if (group.status !== "error") return null;
  const failed = group.spans.filter((span) => span.error);

  return (
    (failed.findLast((span) => isRootSpanKind(span.kind)) ?? failed[0])
      ?.error ?? null
  );
}

/** The request a run belongs to: the event it resumed, its own, or its trace. */
function taskKey(root: ObservabilitySpanRow): string {
  const taskId =
    root.attributes?.["task.root_id"] ?? root.attributes?.["task.id"];

  return typeof taskId === "string" && taskId ? taskId : root.traceId;
}

/** Where a moment falls on the timeline, as a percent of its width. */
function timelinePct(ms: number, scale: TimelineScale): number {
  return ((ms - scale.startMs) / scale.spanMs) * 100;
}

/** The icon a tool call's line opens with. */
function toolIcon(span: ObservabilitySpanRow): LucideIcon {
  const name = spanLabel(span);

  return TOOL_ICONS.find(({ test }) => test.test(name))?.icon ?? Wrench;
}

/** The first string argument of a tool call, on one line, for its title. */
function toolSummary(span: ObservabilitySpanRow): string | undefined {
  const input = span.attributes?.["tool.input"];
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      parsed = input;
    }
  }
  const first =
    typeof parsed === "string"
      ? parsed
      : parsed && typeof parsed === "object"
        ? Object.values(parsed).find(
            (value): value is string =>
              typeof value === "string" && value.trim() !== "",
          )
        : undefined;
  if (first === undefined) return undefined;
  const text = first.replace(/\s+/g, " ").trim();

  return text.length > TOOL_SUMMARY_CHARS
    ? `${text.slice(0, TOOL_SUMMARY_CHARS)}…`
    : text;
}

/**
 * The conversation key a person would recognise: core scopes stored keys as
 * `acct:<account>:agent:<agent>:<key>`, so the tail is the channel's own key.
 */
function unscopedConversationKey(key: string): string {
  return key.replace(/^acct:[^:]+:agent:[^:]+:/, "");
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
  const questions = run.attributes?.["task.questions"];
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
      ...(typeof questions === "string" ? { "task.questions": questions } : {}),
      ...(next ? {} : { "wait.open": true }),
    },
  };
}

/**
 * A request's subagents as overlapping avatars, four at most and "+N" for the
 * rest. Clicking it lists or hides their rows; it sits beside the row's own
 * button, not inside it.
 */
function AvatarStack({
  names,
  open,
  onToggle,
}: {
  names: string[];
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const shown = names.slice(0, STACK_AVATARS);

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? "Hide subagents" : "Show subagents"}
      title={names.join(", ")}
      className="flex shrink-0 cursor-pointer items-center self-end rounded pr-3 pb-1.5 pl-1"
    >
      {shown.map((name, index) => (
        <DitherAvatarSVG
          key={`${name}:${index}`}
          seed={name}
          size={14}
          className={cn(
            "shrink-0 ring-2 ring-background",
            index > 0 && "-ml-1.5",
          )}
        />
      ))}
      {names.length > shown.length && (
        <span className="ml-1 font-mono text-3xs text-muted-foreground">
          +{names.length - shown.length}
        </span>
      )}
    </button>
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

/**
 * A failed span's error, on its own line right under the span's row, so it
 * reads without opening anything. Selects the span.
 */
function ErrorRow({
  depth,
  isSelected,
  onClick,
  text,
}: {
  depth: number;
  isSelected: boolean;
  onClick: () => void;
  text: string;
}): React.JSX.Element {
  return (
    <tr
      onClick={onClick}
      className={cn(
        "cursor-pointer border-b border-border/40 transition-colors hover:bg-accent/20",
        isSelected && "bg-accent",
      )}
    >
      {/* Past the Started column (w-22), then the row's own indent. */}
      <td
        colSpan={5}
        className="relative pt-0 pr-3 pb-1.5 pl-(--row-indent) text-destructive"
        style={{ "--row-indent": `calc(5.5rem + ${depth * 18 + 12}px)` }}
        title={text}
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 left-0 w-0.5",
            STATUS_TONE_BG.error,
          )}
        />
        <span className="line-clamp-2 wrap-anywhere">{text}</span>
      </td>
    </tr>
  );
}

/**
 * A row under a step that is not a span of its own: the step's reasoning or
 * its answer, read off the step's attributes. Opens on the text, selects the
 * step.
 */
function NoteRow({
  depth,
  icon,
  isOpen,
  isSelected,
  onClick,
  onToggle,
  title,
}: {
  depth: number;
  icon: LucideIcon;
  isOpen: boolean;
  isSelected: boolean;
  onClick: () => void;
  onToggle: () => void;
  title: string;
}): React.JSX.Element {
  const Icon = icon;

  return (
    <WideRow
      depth={depth}
      isSelected={isSelected}
      label={title}
      onClick={onClick}
    >
      <FoldTrigger isOpen={isOpen} onToggle={onToggle}>
        <TraceLine size="xs">
          <TraceIcon>
            <Icon />
          </TraceIcon>
          <TraceTitle>{title}</TraceTitle>
        </TraceLine>
      </FoldTrigger>
    </WideRow>
  );
}

/**
 * A row across all five columns, indented like a Span cell at `depth`: a
 * step's note line, or an open line's payload. With `onClick` it selects a
 * span, like a row.
 */
function WideRow({
  children,
  depth,
  isSelected,
  label,
  onClick,
}: {
  children: ReactNode;
  depth: number;
  isSelected: boolean;
  label?: string;
  onClick?: () => void;
}): React.JSX.Element {
  return (
    <tr
      onClick={onClick}
      className={cn(
        "border-b border-border/40 transition-colors",
        onClick && "cursor-pointer hover:bg-accent/20",
        isSelected && "bg-accent",
      )}
    >
      {/* Past the Started column (w-22), then the row's own indent. */}
      <td
        colSpan={5}
        aria-label={label}
        className="py-1.5 pr-3 pl-(--row-indent)"
        style={{ "--row-indent": `calc(5.5rem + ${depth * 18 + 12}px)` }}
      >
        {children}
      </td>
    </tr>
  );
}

/** A row's duration cell; a span that runs to now counts up on the clock's tick. */
function RowDuration({
  durationMs,
  runsToNow,
  startMs,
}: {
  durationMs: number;
  runsToNow: boolean;
  startMs: number;
}): React.JSX.Element {
  const { nowMs } = useContext(TimelineScaleContext);
  const shownMs =
    runsToNow && nowMs !== null
      ? Math.max(durationMs, nowMs - startMs)
      : durationMs;

  return (
    <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap tabular-nums">
      {shownMs > 0 ? formatDuration(shownMs) : "—"}
    </td>
  );
}

/**
 * A line's chevron trigger. The open state lives in the waterfall, not here,
 * because what it opens is the `PayloadRow` under the line, not a panel
 * inside the cell: the payload then reads at the table's full width.
 */
function FoldTrigger({
  children,
  isOpen,
  onToggle,
}: {
  children: ReactNode;
  isOpen: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <TraceCollapsible open={isOpen} onOpenChange={onToggle}>
      <TraceCollapsibleTrigger onClick={stopRowClick}>
        {children}
      </TraceCollapsibleTrigger>
    </TraceCollapsible>
  );
}

/**
 * What an open line holds, as its own row under the line so the line keeps
 * its start, duration and bar on one short row and the text gets the whole
 * table width, pane open or not. Hangs off a rule under the line's icon. Not
 * clickable, so a drag selects its text; the line above selects the span.
 */
function PayloadRow({
  children,
  ...row
}: Omit<React.ComponentProps<typeof WideRow>, "onClick">): React.JSX.Element {
  return (
    <WideRow {...row}>
      <div className="ml-2 grid min-w-0 gap-2 border-l pr-1 pl-4 text-xs leading-relaxed text-muted-foreground">
        {children}
      </div>
    </WideRow>
  );
}

/** One payload of an open line, capped in height and scrolling inside itself. */
function PayloadText({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="flex items-center gap-2 text-2xs text-muted-foreground">
        {label}
        <span className="font-mono tabular-nums">
          {formatNumber(value.length)} chars
        </span>
      </span>
      <PayloadBody
        value={value}
        className="max-h-48 rounded-md border border-border/60 px-2"
      />
    </div>
  );
}

/**
 * A task row reads the whole request's status as a dot and a word; any other
 * row shows a dot only when its span is not ok.
 */
function RowStatus({
  span,
  group,
  issue,
  taskRunning,
}: {
  span: ObservabilitySpanRow;
  group: SpanGroup | undefined;
  issue: SpanIssue | null;
  taskRunning: boolean;
}): React.JSX.Element | null {
  if (!group) {
    if (issue) {
      return (
        <span
          className={cn(
            "flex items-center gap-1.5 whitespace-nowrap",
            issue.level === "error" ? "text-destructive" : "text-warning",
          )}
          title={issue.text || undefined}
        >
          <StatusDot tone={issue.level} />
          {issue.label}
        </span>
      );
    }
    if (span.status === "ok") return null;

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
          {sections.map(({ key, label, open, summary, value }) => (
            <DetailPayload
              key={key}
              label={label}
              open={open}
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

/** A context prepare, cold start or wait: its name, the messages it loaded, the questions it asked. */
function PhaseLine({
  isOpen,
  onToggle,
  span,
}: {
  isOpen: boolean;
  onToggle: () => void;
  span: ObservabilitySpanRow;
}): React.JSX.Element {
  const name = spanLabel(span);
  const Icon = span.name === WAIT_SPAN_NAME ? MessageCircleQuestionMark : Zap;
  const historyRows = numericAttribute(span, "prepare.history_rows");
  const line = (
    <TraceLine size="xs">
      <TraceIcon>
        <Icon />
      </TraceIcon>
      <TraceTitle>{name}</TraceTitle>
      {historyRows !== undefined && (
        <TraceDescription>
          {historyRows.toLocaleString()} messages
        </TraceDescription>
      )}
    </TraceLine>
  );
  if (span.attributes?.["task.questions"] === undefined) return line;

  return (
    <FoldTrigger isOpen={isOpen} onToggle={onToggle}>
      {line}
    </FoldTrigger>
  );
}

/**
 * The Span cell: the row's name as a Trace line. A step is a title, its
 * tokens and a chevron that folds its lines; a tool call opens on its input
 * and output; a subagent is its avatar and name and opens its own run; a
 * phase is its name.
 */
function SpanLine({
  hasChildren,
  isOpen,
  isTaskRow,
  onFocusTrace,
  onToggle,
  span,
}: {
  hasChildren: boolean;
  isOpen: boolean;
  isTaskRow: boolean;
  onFocusTrace: (traceId: string) => void;
  onToggle: () => void;
  span: ObservabilitySpanRow;
}): React.JSX.Element {
  if (isTaskRow) {
    const name = spanLabel(span);

    return (
      <span className="block min-w-0 truncate font-medium" title={name}>
        {name}
      </span>
    );
  }
  if (span.kind === "subtask") {
    return <SubagentLine span={span} onFocusTrace={onFocusTrace} />;
  }
  if (span.kind === "tool.call") {
    return <ToolLine isOpen={isOpen} onToggle={onToggle} span={span} />;
  }
  if (span.kind === "phase") {
    return <PhaseLine isOpen={isOpen} onToggle={onToggle} span={span} />;
  }

  return (
    <StepLine
      hasChildren={hasChildren}
      isOpen={isOpen}
      name={rowLabel(span)}
      onToggle={onToggle}
      span={span}
    />
  );
}

/** A model step or a resumed pass: the name, the tokens, and the chevron that folds what ran under it. */
function StepLine({
  hasChildren,
  isOpen,
  name,
  onToggle,
  span,
}: {
  hasChildren: boolean;
  isOpen: boolean;
  name: string;
  onToggle: () => void;
  span: ObservabilitySpanRow;
}): React.JSX.Element {
  const tokens = spanTokens(span);

  return (
    <TraceLine size="xs">
      <TraceTitle strong>{name}</TraceTitle>
      {tokens !== undefined && (
        <TraceDescription>{formatNumber(tokens)} tok</TraceDescription>
      )}
      {hasChildren && (
        <button
          type="button"
          onClick={(event) => {
            stopRowClick(event);
            onToggle();
          }}
          aria-expanded={isOpen}
          aria-label={isOpen ? "Collapse spans" : "Expand spans"}
          className="-m-1 cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight
            className={cn("size-4 transition-transform", isOpen && "rotate-90")}
          />
        </button>
      )}
    </TraceLine>
  );
}

/** A subagent the run started: its avatar, name and duration; opens its own run. */
function SubagentLine({
  onFocusTrace,
  span,
}: {
  onFocusTrace: (traceId: string) => void;
  span: ObservabilitySpanRow;
}): React.JSX.Element {
  const name = subagentName(span);

  return (
    <button
      type="button"
      onClick={(event) => {
        stopRowClick(event);
        onFocusTrace(span.traceId);
      }}
      aria-label={`Open ${name}'s run`}
      title="Open the subagent's run"
      className="max-w-full cursor-pointer"
    >
      <TraceLine size="xs">
        <TraceIcon>
          <DitherAvatarSVG seed={name} size={16} />
        </TraceIcon>
        <TraceTitle>{name}</TraceTitle>
        <TraceDescription>{formatDuration(span.durationMs)}</TraceDescription>
        <TraceIcon>
          <ArrowUpRight />
        </TraceIcon>
      </TraceLine>
    </button>
  );
}

/** A tool call: its icon, name and first argument; opens its input and output under the row. Its error has its own row. */
function ToolLine({
  isOpen,
  onToggle,
  span,
}: {
  isOpen: boolean;
  onToggle: () => void;
  span: ObservabilitySpanRow;
}): React.JSX.Element {
  const name = spanLabel(span);
  const Icon = toolIcon(span);
  const summary = toolSummary(span);

  return (
    <FoldTrigger isOpen={isOpen} onToggle={onToggle}>
      <TraceLine
        size="xs"
        status={span.status === "error" ? "error" : undefined}
      >
        <TraceIcon>
          <Icon />
        </TraceIcon>
        <TraceTitle title={summary ? `${name} ${summary}` : name}>
          {name}
          {summary && (
            <>
              {" "}
              <span className="text-muted-foreground/70">{summary}</span>
            </>
          )}
        </TraceTitle>
      </TraceLine>
    </FoldTrigger>
  );
}

/** What an open tool call or wait row shows under its line: the tool's input and output, or the wait's questions. */
function spanPayload(span: ObservabilitySpanRow): ReactNode {
  const input = span.attributes?.["tool.input"];
  const output = span.attributes?.["tool.output"];
  const questions = span.attributes?.["task.questions"];

  return (
    <>
      {input !== undefined && (
        <PayloadText label="input" value={displayAttribute(input)} />
      )}
      {output !== undefined && (
        <PayloadText label="output" value={displayAttribute(output)} />
      )}
      {questions !== undefined && (
        <PayloadText label="questions" value={displayAttribute(questions)} />
      )}
    </>
  );
}

/**
 * One waterfall row. The task row (depth 0) is always open and reads the whole
 * request's status and duration. An issue on the row marks its edge;
 * `below` counts the issues under it and, while it is closed, marks them on
 * its bar.
 */
function SpanRow({
  span,
  depth,
  isOpen,
  hasChildren,
  onToggle,
  isSelected,
  onClick,
  group,
  taskRunning,
  highlighted,
  onFocusTrace,
  issue,
  below,
  live,
}: {
  span: ObservabilitySpanRow;
  depth: number;
  isOpen: boolean;
  hasChildren: boolean;
  onToggle: () => void;
  isSelected: boolean;
  onClick: () => void;
  group: SpanGroup;
  taskRunning: boolean;
  highlighted: boolean;
  onFocusTrace: (traceId: string) => void;
  issue: SpanIssue | null;
  below: SpanIssue[];
  live: boolean;
}): React.JSX.Element {
  const isTaskRow = depth === 0;
  // A running span runs to now. The task row reads the whole request, which
  // is live while its latest pass is, so it runs to now too.
  const runsToNow = isTaskRow ? live : span.status === "running" && taskRunning;
  const durationMs = isTaskRow ? group.taskDurationMs : span.durationMs;
  const belowErrors = below.filter((item) => item.level === "error").length;

  return (
    <tr
      onClick={onClick}
      data-span-key={spanKey(span)}
      className={cn(
        "cursor-pointer border-b border-border/40 transition hover:bg-accent/20",
        isSelected && "bg-accent",
        !isRootSpanKind(span.kind) && "text-foreground/80",
        highlighted && "animate-trace-flash",
        // A span that arrives while the run is live fades in once.
        live && "starting:opacity-0",
      )}
    >
      <td
        className="relative px-3 py-1.5 font-mono whitespace-nowrap tabular-nums text-muted-foreground"
        title={new Date(span.startTimeMs).toLocaleString()}
      >
        {issue && (
          <span
            aria-hidden="true"
            className={cn(
              "absolute inset-y-0 left-0 w-0.5",
              STATUS_TONE_BG[issue.level],
            )}
          />
        )}
        {formatTime(span.startTimeMs)}
      </td>
      <td
        className="py-1.5 pr-3 pl-(--row-indent)"
        style={{ "--row-indent": `${depth * 18 + 12}px` }}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0">
            <SpanLine
              hasChildren={hasChildren}
              isOpen={isOpen}
              isTaskRow={isTaskRow}
              onFocusTrace={onFocusTrace}
              onToggle={onToggle}
              span={span}
            />
          </span>
          {below.length > 0 && (
            <span
              className={cn(
                "flex shrink-0 cursor-help items-center gap-0.5 font-mono tabular-nums",
                belowErrors > 0 ? "text-destructive" : "text-warning",
              )}
              title={`${belowErrors} failed, ${below.length - belowErrors} retried under this span`}
            >
              <TriangleAlert className="size-3" />
              {below.length}
            </span>
          )}
        </span>
      </td>
      <td className="px-3 py-1.5">
        <RowStatus
          span={span}
          group={isTaskRow ? group : undefined}
          issue={issue}
          taskRunning={taskRunning}
        />
      </td>
      <RowDuration
        durationMs={durationMs}
        runsToNow={runsToNow}
        startMs={span.startTimeMs}
      />
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
          runsToNow={runsToNow}
          taskRunning={taskRunning}
          failed={issue?.level === "error"}
          marks={hasChildren && !isOpen ? below : []}
        />
      </td>
    </tr>
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
 * A bare chevron before the selected trace's title: folds the task list to its
 * rail and back. Padded for a 22px hit area, pulled back so it takes no room.
 * Desktop only.
 */
function TaskListFold({
  rail,
  onToggle,
}: {
  rail: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <IconTooltip label={rail ? "Show the task list" : "Fold the task list"}>
      <button
        type="button"
        onClick={onToggle}
        className="-m-1 hidden shrink-0 cursor-pointer rounded-sm p-1 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring md:block"
      >
        <ChevronsLeft
          className={cn(
            "size-3.5 transition-transform duration-200 motion-reduce:transition-none",
            rail && "rotate-180",
          )}
        />
      </button>
    </IconTooltip>
  );
}

/**
 * The task list, or its rail: one row or one dot per task. The rail keeps the
 * order, the status and the selection of the list in 36px, so one trace gets
 * the width without losing where you are. The selected trace's first button
 * folds it, and the pane slides between the two widths.
 */
function TaskListPane({
  rail,
  rows,
  selectedGroup,
  stackChoices,
  onSelect,
  onToggleStack,
  costs,
  emptyMessage,
  shown,
  total,
  remaining,
  onLoadMore,
}: TaskListPaneProps): React.JSX.Element {
  return (
    <div
      data-scroll-pane
      className={cn(
        "max-h-72 shrink-0 overflow-x-hidden overflow-y-auto border-b border-border transition-box duration-200 ease-out motion-reduce:transition-none md:max-h-none md:border-r md:border-b-0",
        rail ? "md:w-9" : "md:w-80",
      )}
    >
      {rows.map(({ group, parent }) =>
        rail ? (
          <TaskRailDot
            key={spanKey(group.root)}
            root={group.root}
            status={group.status}
            tone={groupTone(group)}
            isSubagent={parent !== null}
            isSelected={group === selectedGroup}
            onSelect={onSelect}
          />
        ) : (
          <TaskListRow
            key={spanKey(group.root)}
            root={group.root}
            status={group.status}
            tone={groupTone(group)}
            taskDurationMs={group.taskDurationMs}
            cause={failureCause(group)}
            isSubagent={parent !== null}
            subagentNames={group.subagents
              .map((subagent) => subagentName(subagent.root))
              .join("\n")}
            isSelected={group === selectedGroup}
            stackOpen={isStackOpen(group, selectedGroup, stackChoices)}
            onSelect={onSelect}
            onToggleStack={onToggleStack}
          />
        ),
      )}
      {!rail && rows.length === 0 && (
        <p className="px-3 py-8 text-center text-xs text-muted-foreground">
          {emptyMessage}
        </p>
      )}
      {!rail && (
        <LoadMore
          shown={shown}
          total={total}
          noun={["task", "tasks"]}
          detail={costTotal(rows, costs, remaining > 0)}
          pageSize={PAGE_SIZE}
          remaining={remaining}
          onLoad={onLoadMore}
        />
      )}
    </div>
  );
}

/**
 * One row of the task list: dot, request and duration, then start time and
 * the failure cause or open wait. A subagent row is indented under its
 * request and names its agent, with its task after the time. A request with
 * subagents ends in their avatar stack. The button's id is the `?trace=` focus
 * target. Memoized on the root span, which the stream keeps across flushes,
 * and the row's primitives.
 */
const TaskListRow = memo(function TaskListRow({
  root,
  status,
  tone,
  taskDurationMs,
  cause,
  isSubagent,
  subagentNames,
  isSelected,
  stackOpen,
  onSelect,
  onToggleStack,
}: TaskListRowProps): React.JSX.Element {
  const request = spanLabel(root);
  const waiting =
    status === "needs_input" || status === "waiting"
      ? TASK_STATUS_WORD[status].toLowerCase()
      : null;

  return (
    <div
      className={cn(
        "flex border-b border-border/40 transition-colors hover:bg-accent/20",
        isSelected && "bg-accent",
      )}
    >
      <button
        type="button"
        id={`task-${root.traceId}`}
        onClick={() => onSelect(root)}
        aria-current={isSelected || undefined}
        className={cn(
          "block min-w-0 flex-1 cursor-pointer py-1.5 pr-3 text-left text-xs",
          isSubagent ? "pl-7" : "pl-3",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot tone={tone} label={status} />
          {isSubagent && (
            <DitherAvatarSVG seed={request} size={14} className="shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate" title={request}>
            {request}
          </span>
          <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
            {formatDuration(taskDurationMs)}
          </span>
        </span>
        <span
          className={cn(
            "mt-0.5 flex min-w-0 gap-2 text-muted-foreground",
            isSubagent ? "pl-9.5" : "pl-4",
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            {formatDateTime(root.startTimeMs)}
            {isSubagent && ` · ${taskInput(root)}`}
            {cause && <span className="text-destructive"> · {cause}</span>}
            {waiting && <span className="text-needs-input"> · {waiting}</span>}
          </span>
        </span>
      </button>
      {subagentNames !== "" && (
        <AvatarStack
          names={subagentNames.split("\n")}
          open={stackOpen}
          onToggle={() => onToggleStack(root, !stackOpen)}
        />
      )}
    </div>
  );
});

/**
 * One task on the rail: its status dot, ringed when selected, indented for a
 * subagent. Hover names the task and its time; the id is the same focus
 * target as the list row, so j/k and a trace link still scroll to it.
 */
function TaskRailDot({
  root,
  status,
  tone,
  isSubagent,
  isSelected,
  onSelect,
}: {
  root: ObservabilitySpanRow;
  status: SpanStatus;
  tone: StatusTone;
  isSubagent: boolean;
  isSelected: boolean;
  onSelect: (root: ObservabilitySpanRow) => void;
}): React.JSX.Element {
  const request = spanLabel(root);

  return (
    <button
      type="button"
      id={`task-${root.traceId}`}
      onClick={() => onSelect(root)}
      aria-current={isSelected || undefined}
      aria-label={request}
      title={`${request}\n${formatDateTime(root.startTimeMs)} · ${status}`}
      className={cn(
        "flex w-full cursor-pointer justify-center border-b border-border/40 py-2 transition-colors hover:bg-accent/20",
        isSelected && "bg-accent",
        isSubagent && "pl-2",
      )}
    >
      <StatusDot
        tone={tone}
        label={status}
        className={cn(
          isSelected && "ring-2 ring-foreground ring-offset-1 ring-offset-card",
        )}
      />
    </button>
  );
}

/**
 * The selected run on the right: its request, or its chain for a subagent,
 * its price, conversation and trace, the copy actions for the user's own coding
 * agent, Continue when a request failed, the count of what went wrong, then
 * its waterfall scaled to that run alone. The header opens with the task
 * list's fold, next to the list it folds.
 */
function TaskWaterfall({
  attempt,
  chain,
  cost,
  fold,
  onContinue,
  onPickRun,
  projectSlug,
  stageSlug,
  view: panelView,
}: {
  attempt: ContinueAttempt | undefined;
  chain: SpanGroup[];
  /** The run's price, see costLabel; undefined before any model step. */
  cost: string | undefined;
  /** The task list's fold button, first in the header. */
  fold: React.ReactNode;
  onContinue: () => void;
  onPickRun: (root: ObservabilitySpanRow) => void;
  projectSlug: string | undefined;
  stageSlug: string | undefined;
  view: Omit<WaterfallView, "issues" | "live">;
}): React.JSX.Element {
  const { group } = panelView;
  const { root } = group;
  const runs = group.spans.filter((span) => isRootSpanKind(span.kind));
  const live = isTaskRunning(group.latest);
  const issues = useMemo(() => runIssues(group), [group]);
  const view: WaterfallView = { ...panelView, issues: issues, live: live };
  const failures = issues.all.filter(({ issue }) => issue.level === "error");
  const retries = issues.all.filter(({ issue }) => issue.level === "warn");
  // Opens an issue's span in the side panel, opens the rows folded above it,
  // and scrolls its row into view once they render.
  const showSpan = ({ path, span }: RunIssues["all"][number]): void => {
    const key = spanKey(span);
    if (key !== view.selectedKey) view.onSelect(key);
    for (const row of path) {
      if (!isRowOpen(row, view.toggled)) view.toggle(spanKey(row));
    }
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-span-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  };
  const request = spanLabel(root);
  const ancestors = chain.slice(0, -1);
  const failedRun = runs.findLast((span) => span.error);
  const run = failedRun ?? runs.at(-1) ?? root;
  const prompt =
    projectSlug && stageSlug
      ? agentDebugPrompt({
          dashboardUrl: window.location.origin,
          projectSlug: projectSlug,
          stageSlug: stageSlug,
          run: run,
          status: view.group.status,
          otherTraceIds: [
            ...new Set(
              runs
                .map((span) => span.traceId)
                .filter((id) => id !== run.traceId),
            ),
          ],
        })
      : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 text-xs">
        {fold}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {ancestors.map((ancestor) => (
            <span
              key={spanKey(ancestor.root)}
              className="flex min-w-0 items-center gap-1.5 text-muted-foreground"
            >
              <button
                type="button"
                onClick={() => onPickRun(ancestor.root)}
                title={spanLabel(ancestor.root)}
                className="max-w-56 cursor-pointer truncate hover:text-foreground hover:underline"
              >
                {spanLabel(ancestor.root)}
              </button>
              <span aria-hidden="true">›</span>
            </span>
          ))}
          <span className="min-w-0 truncate font-medium" title={request}>
            {request}
          </span>
        </span>
        {[
          { found: failures, word: "failed", tone: "text-destructive" },
          { found: retries, word: "retried", tone: "text-warning" },
        ].map(
          ({ found, word, tone }) =>
            found.length > 0 && (
              <button
                key={word}
                type="button"
                onClick={() => showSpan(found[0])}
                title={`Open the first ${word} span`}
                className={cn(
                  "flex cursor-pointer items-center gap-1 font-mono tabular-nums hover:underline",
                  tone,
                )}
              >
                <TriangleAlert className="size-3" />
                {found.length} {word}
              </button>
            ),
        )}
        {cost !== undefined && (
          <span
            className="font-mono tabular-nums text-muted-foreground"
            title={
              cost.endsWith("+")
                ? "Some steps' models have no price"
                : "Estimated cost of this run"
            }
          >
            {cost}
          </span>
        )}
        {root.conversationKey && (
          <Badge
            variant="outline"
            className="max-w-48 truncate font-mono"
            title={root.conversationKey}
          >
            {unscopedConversationKey(root.conversationKey)}
          </Badge>
        )}
        <CopyTextButton
          value={root.traceId}
          label={`Copy trace ID ${root.traceId.slice(0, 8)}`}
          title={`Copy trace ID ${root.traceId}`}
          className="font-mono"
        >
          {root.traceId.slice(0, 8)}
        </CopyTextButton>
        {prompt && (
          <CopyTextButton
            value={prompt}
            label="Copy prompt for agent"
            title="Copy a prompt that has your coding agent read this run with the broods CLI, then fix or audit it"
          >
            Copy prompt for agent
          </CopyTextButton>
        )}
        {canContinue(view.group) && (
          <ContinueAction
            attempt={attempt}
            nextRun={view.group.nextRun}
            onContinue={onContinue}
            onFocusTrace={view.onFocusTrace}
          />
        )}
      </div>
      <TimelineClock group={group} live={live}>
        <div
          className="@container relative min-w-xl"
          style={{ "--timeline-width": TIMELINE_WIDTH }}
        >
          <table className="w-full table-fixed text-xs">
            <colgroup>
              <col className="w-22" />
              <col />
              <col className="w-20" />
              <col className="w-19" />
              <col className="w-(--timeline-width)" />
            </colgroup>
            <thead className="sticky top-0 z-10 border-b border-border bg-card/95">
              <tr className="text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Span</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Duration</th>
                <th className="px-3 py-2">
                  <TimelineAxis issues={issues.all} onPick={showSpan} />
                </th>
              </tr>
            </thead>
            <tbody>{renderSpanRows(root, 0, live, view, undefined)}</tbody>
          </table>
          <TimelineLines issues={issues.all} />
        </div>
      </TimelineClock>
    </>
  );
}

/**
 * One waterfall bar positioned within the task's time window. Model steps split
 * into a muted invoke-wait (time-to-first-token) segment and a solid streaming
 * segment so a slow step shows where the time went.
 */
function TimelineBar({
  span,
  runsToNow,
  taskRunning,
  failed,
  marks,
}: {
  span: ObservabilitySpanRow;
  runsToNow: boolean;
  taskRunning: boolean;
  failed: boolean;
  marks: SpanIssue[];
}): React.JSX.Element {
  const scale = useContext(TimelineScaleContext);
  const stale = isStale(span, taskRunning);
  const live = span.status === "running" && taskRunning;
  const barColor = failed
    ? "bg-destructive/70"
    : ((span.name === WAIT_SPAN_NAME ? WAIT_BAR[span.status] : undefined) ??
      kindBar(span.kind));
  const end = runsToNow
    ? (scale.nowMs ?? scale.startMs + scale.spanMs)
    : Math.max(span.endTimeMs, span.startTimeMs);
  const shownMs = Math.max(1, end - span.startTimeMs);
  const leftPct = Math.min(
    100,
    Math.max(0, timelinePct(span.startTimeMs, scale)),
  );
  const widthPct = Math.max(
    0.75,
    Math.min((shownMs / scale.spanMs) * 100, 100 - leftPct),
  );

  // A retried model call waits before its first token, so the retry wait
  // leads the bar and the rest of the time to first token follows it.
  const retryMs = numericAttribute(span, "model.retry_wait_ms") ?? 0;
  const ttftMs = numericAttribute(span, "model.ttft_ms");
  const retryFrac = Math.min(1, retryMs / shownMs);
  const ttftFrac =
    ttftMs !== undefined
      ? Math.min(1 - retryFrac, Math.max(0, ttftMs - retryMs) / shownMs)
      : 0;
  const title = `${spanLabel(span)} · ${formatDuration(span.durationMs)} · started ${formatTime(span.startTimeMs)}${
    retryMs > 0 ? ` · retry wait ${formatDuration(retryMs)}` : ""
  }${
    ttftMs !== undefined
      ? ` · time to first token ${formatDuration(ttftMs)}`
      : ""
  }`;

  return (
    <div className="relative h-4 w-full">
      <div
        className="absolute top-1/2 left-(--bar-left) flex h-2 w-(--bar-width) -translate-y-1/2 overflow-hidden rounded-sm transition-timeline"
        style={{ "--bar-left": `${leftPct}%`, "--bar-width": `${widthPct}%` }}
        title={title}
      >
        {retryFrac > 0 && (
          <div
            className="h-full w-(--retry-width) shrink-0 bg-warning/50"
            style={{ "--retry-width": `${retryFrac * 100}%` }}
          />
        )}
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
        {marks.map((mark, index) => (
          <span
            key={index}
            className={cn(
              "absolute inset-y-0 left-(--mark-left) w-0.5",
              STATUS_TONE_BG[mark.level],
            )}
            style={{
              "--mark-left": `${Math.min(100, Math.max(0, ((mark.atMs - span.startTimeMs) / shownMs) * 100))}%`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The selected run's time axis, in the Timeline header: ticks that rescale as
 * a live run grows, the now dot, and a marker where each issue happened that
 * opens its span.
 */
function TimelineAxis({
  issues,
  onPick,
}: {
  issues: RunIssues["all"];
  onPick: (entry: RunIssues["all"][number]) => void;
}): React.JSX.Element {
  const scale = useContext(TimelineScaleContext);

  return (
    <div className="relative h-4 w-full font-normal">
      <span className="sr-only">Timeline</span>
      {axisTicks(scale.spanMs)
        .map((offset) => ({
          offset: offset,
          pct: timelinePct(scale.startMs + offset, scale),
        }))
        .filter(({ pct }) => pct <= AXIS_LAST_TICK_PCT)
        .map(({ offset, pct }) => (
          <span
            key={offset}
            className={cn(
              "absolute top-0 left-(--tick-left) font-mono tabular-nums transition-timeline",
              offset > 0 && "-translate-x-1/2",
            )}
            style={{ "--tick-left": `${pct}%` }}
          >
            {axisLabel(offset)}
          </span>
        ))}
      {scale.nowMs !== null && (
        <span
          aria-hidden="true"
          className="absolute -bottom-2 left-(--now-left) size-1.5 -translate-x-1/2 rounded-full bg-info transition-timeline"
          style={{ "--now-left": `${timelinePct(scale.nowMs, scale)}%` }}
        />
      )}
      {issues.map((entry) => {
        const { issue, span } = entry;

        return (
          <button
            key={`${spanKey(span)}:${issue.atMs}`}
            type="button"
            onClick={() => onPick(entry)}
            aria-label={`${issue.label}: ${spanLabel(span)}`}
            title={`${formatTime(issue.atMs)} · ${spanLabel(span)} · ${issue.label}${issue.text ? ` · ${issue.text}` : ""}`}
            className={cn(
              "absolute -bottom-2.5 left-(--mark-left) size-2 -translate-x-1/2 rotate-45 cursor-pointer rounded-xs transition-timeline",
              STATUS_TONE_BG[issue.level],
            )}
            style={{ "--mark-left": `${timelinePct(issue.atMs, scale)}%` }}
          />
        );
      })}
    </div>
  );
}

/**
 * Holds the selected run's time scale for the bars, durations, axis and lines
 * inside it. While the run is live it ticks once a second, so bars grow
 * toward the now line and only those parts re-render, not the rows.
 */
function TimelineClock({
  children,
  group,
  live,
}: {
  children: ReactNode;
  group: SpanGroup;
  live: boolean;
}): React.JSX.Element {
  const now = useNow(live ? LIVE_TICK_MS : null);
  // The clock can trail the stream by a tick, so now is never earlier than
  // the newest span. Keyed per run, a switch to a live run starts it fresh.
  const nowMs = Math.max(group.windowStart + group.windowSpan, now);
  const scale: TimelineScale = live
    ? {
        startMs: group.windowStart,
        spanMs: (nowMs - group.windowStart) * LIVE_HEADROOM,
        nowMs: nowMs,
      }
    : { startMs: group.windowStart, spanMs: group.windowSpan, nowMs: null };

  return <TimelineScaleContext value={scale}>{children}</TimelineScaleContext>;
}

/**
 * The now line and a faint line at each issue, drawn once over the timeline
 * column of every row. `--timeline-left` is where that column's bars start.
 */
function TimelineLines({
  issues,
}: {
  issues: RunIssues["all"];
}): React.JSX.Element {
  const scale = useContext(TimelineScaleContext);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 right-3 left-(--timeline-left)"
      style={{
        "--timeline-left": "calc(100cqw - var(--timeline-width) + 0.75rem)",
      }}
    >
      {issues.map(({ issue, span }) => (
        <span
          key={`${spanKey(span)}:${issue.atMs}`}
          className={cn(
            "absolute inset-y-0 left-(--line-left) w-px transition-timeline",
            issue.level === "error" ? "bg-destructive/30" : "bg-warning/30",
          )}
          style={{ "--line-left": `${timelinePct(issue.atMs, scale)}%` }}
        />
      ))}
      {scale.nowMs !== null && (
        <span
          className="absolute inset-y-0 left-(--now-left) w-px bg-info/60 transition-timeline"
          style={{ "--now-left": `${timelinePct(scale.nowMs, scale)}%` }}
        />
      )}
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
 * A span's row, then what ran under it when open: a step's reasoning, its
 * tool calls and its answer. A step starts open, anything else closed, and
 * `view.toggled` flips that. `enclosingRootLive` is whether the nearest
 * enclosing root run is live; a resumed pass is itself a root and judged on
 * its own freshness. A subagent is one leaf line here: its own run lists on
 * its own.
 */
function renderSpanRows(
  span: ObservabilitySpanRow,
  depth: number,
  enclosingRootLive: boolean,
  view: WaterfallView,
  askingStepId: string | undefined,
): ReactNode[] {
  const key = spanKey(span);
  const isTaskRow = depth === 0;
  const isOpen = isTaskRow || isRowOpen(span, view.toggled);
  const isSelected = key === view.selectedKey;
  const select = (): void => view.onSelect(key);
  const children = rowChildren(span, isTaskRow, view.group);
  const { reasoning, response } = stepNotes(span);
  const hasNotes = reasoning !== undefined || response !== undefined;
  const isRoot = isRootSpanKind(span.kind);
  // A root is judged on its own freshness; a child on its enclosing root's liveness.
  const rootLive = isRoot ? isTaskRunning(span) : enclosingRootLive;
  const asking = isRoot
    ? askedStepId(span, view.group.childrenByParent)
    : askingStepId;
  const issue = view.issues.own.get(span.spanId) ?? null;
  const rows: ReactNode[] = [
    <SpanRow
      key={`row:${key}`}
      span={span}
      depth={depth}
      isOpen={isOpen}
      hasChildren={!isTaskRow && (children.length > 0 || hasNotes)}
      onToggle={() => view.toggle(key)}
      isSelected={isSelected}
      onClick={select}
      group={view.group}
      taskRunning={rootLive}
      highlighted={isRoot && span.traceId === view.focusTraceId}
      onFocusTrace={view.onFocusTrace}
      issue={issue}
      below={view.issues.below.get(span.spanId) ?? []}
      live={view.live}
    />,
  ];
  if (issue?.level === "error" && issue.text) {
    rows.push(
      <ErrorRow
        key={`error:${key}`}
        depth={depth}
        isSelected={isSelected}
        onClick={select}
        text={issue.text}
      />,
    );
  }
  if (!isOpen) return rows;
  if (span.kind === "tool.call" || span.kind === "phase") {
    rows.push(
      <PayloadRow key={`payload:${key}`} depth={depth} isSelected={isSelected}>
        {spanPayload(span)}
      </PayloadRow>,
    );
  }
  if (reasoning !== undefined) {
    rows.push(
      ...noteRows(`reasoning:${key}`, "thought", reasoning, {
        depth: depth + 1,
        isSelected: isSelected,
        onClick: select,
        view: view,
      }),
    );
  }
  for (const child of children) {
    rows.push(...renderSpanRows(child, depth + 1, rootLive, view, asking));
  }
  if (response !== undefined) {
    rows.push(
      ...noteRows(
        `response:${key}`,
        span.spanId === asking ? "question" : "answer",
        response,
        {
          depth: depth + 1,
          isSelected: isSelected,
          onClick: select,
          view: view,
        },
      ),
    );
  }

  return rows;
}

/** A step's thought, answer or question line, then its text as a payload row when open. */
function noteRows(
  key: string,
  kind: NoteKind,
  text: string,
  row: {
    depth: number;
    isSelected: boolean;
    onClick: () => void;
    view: WaterfallView;
  },
): ReactNode[] {
  const isOpen = row.view.toggled.has(key);
  const rows: ReactNode[] = [
    <NoteRow
      key={key}
      depth={row.depth}
      icon={NOTE_ICONS[kind]}
      isOpen={isOpen}
      isSelected={row.isSelected}
      onClick={row.onClick}
      onToggle={() => row.view.toggle(key)}
      title={kind}
    />,
  ];
  if (isOpen) {
    rows.push(
      <PayloadRow
        key={`payload:${key}`}
        depth={row.depth}
        isSelected={row.isSelected}
      >
        <PayloadText label={kind} value={text} />
      </PayloadRow>,
    );
  }

  return rows;
}

/** The request a subagent was given, for its row's second line. */
function taskInput(root: ObservabilitySpanRow): string {
  const input = root.attributes?.["task.input"];

  return typeof input === "string" && input ? input : root.traceId;
}
