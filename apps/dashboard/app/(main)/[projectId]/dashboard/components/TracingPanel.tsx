"use client";

import {
  DetailFields,
  DetailPayload,
  type DetailRow,
  PayloadBody,
} from "@/app/components/DetailSections";
import { DetailSplit } from "@/app/components/DetailSplit";
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
  X,
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
  isModelCallSpan,
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

const PAGE_SIZE = 50;

type SpanStatus = ObservabilitySpanRow["status"];

// `error` stays null from the click until the continuation's trace replaces the button.
interface ContinueAttempt {
  error: string | null;
}

interface PayloadSection extends DetailRow {
  open?: boolean;
  summary: string;
}

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

// Not a core span: the dashboard adds it for the gap between a paused run and the next one.
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

// model.tool_results is left out: each tool span's tool.output is what the model saw.
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
  { key: "agent.environment", label: "Environment" },
  {
    key: "agent.tools",
    label: "Tools",
    countKey: "agent.tool_count",
    countLabel: "tools",
  },
];

// Each prepare load is timed on its own; they overlap, so they do not sum to the span.
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

const SPAN_SEARCH_TEXT = new WeakMap<ObservabilitySpanRow, string>();

// Hues checked for protan/deutan separation on both themes, error red included;
// the shades per theme live in the --span-* tokens in globals.css.
const KIND_BAR: Record<ObservabilitySpanRow["kind"], string> = {
  task: "bg-span-task/70",
  cron: "bg-span-cron/70",
  subtask: "bg-span-subtask/70",
  "model.step": "bg-span-model/70",
  "tool.call": "bg-span-tool/70",
  phase: "bg-span-phase/70",
};

const TOOL_ICONS: ReadonlyArray<{ icon: LucideIcon; test: RegExp }> = [
  { icon: Terminal, test: /^(bash|shell|sh|exec|terminal|run_command)/i },
  { icon: FileText, test: /^(read|write|edit|cat|ls|list|glob|grep|search)/i },
  { icon: GitPullRequestArrow, test: /github|gitlab|git_|pull_request/i },
  { icon: MessageCircleQuestionMark, test: /approv|question|ask/i },
];

const NOTE_ICONS: Record<NoteKind, LucideIcon> = {
  thought: Brain,
  answer: MessageSquare,
  question: MessageCircleQuestionMark,
};

const STACK_AVATARS = 4;

const TOOL_SUMMARY_CHARS = 80;

// A root still "running" past this most likely lost its end span (crash, lost publish).
const TASK_MAX_RUNTIME_MS = 16 * 60 * 1000;

const RATE_LIMIT = /rate.?limit|429/i;

const CAUSE_CHARS = 40;

// The prefixes core writes per channel (runtime-keys.ts); any other key came via the API.
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

const STATUS_ALIASES: Readonly<Record<string, SpanStatus>> = {
  ok: "ok",
  done: "ok",
  error: "error",
  failed: "error",
  running: "running",
  waiting: "waiting",
  needs_input: "needs_input",
};

// = min-w-xl, so dragging the detail divider never pushes the waterfall's columns out of view.
const WATERFALL_MIN_WIDTH = 576;

// The Started column's w-22, which a wide row's indent starts past.
const STARTED_COLUMN_WIDTH = "5.5rem";

const LIST_RAIL_KEY = "tracing:list-rail";

const LIVE_TICK_MS = 1000;

const LIVE_HEADROOM = 1.1;

const TimelineScaleContext = createContext<TimelineScale>({
  nowMs: null,
  spanMs: 1,
  startMs: 0,
});

const AXIS_STEPS_MS = [
  100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000,
  300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000,
];
const AXIS_MAX_STEPS = 3;

const AXIS_LAST_TICK_PCT = 94;

// Span keeps 18rem beside Started, Status and Duration (15.25rem); 22–40% of the width.
const TIMELINE_WIDTH = "clamp(22cqw, 100cqw - 33.25rem, 40cqw)";

// Values arrive lowercased.
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

// A request's first run is the row; its later passes, continuations and waits nest under it.
export interface SpanGroup {
  root: ObservabilitySpanRow;
  status: SpanStatus;
  latest: ObservabilitySpanRow;
  childrenByParent: Map<string, ObservabilitySpanRow[]>;
  spans: ObservabilitySpanRow[];
  windowStart: number;
  windowSpan: number;
  taskDurationMs: number;
  nextRun: ObservabilitySpanRow | null;
  parentTraceId: string | null;
  subagents: SpanGroup[];
}

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

export type TaskQuery = Query<TaskQueryField>;

export interface SpanIssue {
  atMs: number;
  level: Extract<StatusTone, "error" | "warn">;
  label: string;
  text: string;
}

type NoteKind = "thought" | "answer" | "question";

export interface RunIssue {
  issue: SpanIssue;
  path: ObservabilitySpanRow[];
  span: ObservabilitySpanRow;
}

export interface RunIssues {
  all: RunIssue[];
  below: Map<string, RunIssue[]>;
  own: Map<string, SpanIssue>;
}

interface TimelineScale {
  nowMs: number | null;
  spanMs: number;
  startMs: number;
}

interface WaterfallView {
  costs: ReadonlyMap<string, TaskCost | null>;
  focusTraceId: string | null;
  group: SpanGroup;
  issues: RunIssues;
  live: boolean;
  onFocusTrace: (traceId: string) => void;
  onSelect: (key: string) => void;
  selectedKey: string | null;
  toggle: (key: string) => void;
  toggled: Set<string>;
}

interface ListRow {
  group: SpanGroup;
  parent: SpanGroup | null;
}

interface TaskListPaneProps {
  rail: boolean;
  rows: ListRow[];
  selectedGroup: SpanGroup | null;
  stackChoices: ReadonlyMap<string, boolean>;
  onSelect: (root: ObservabilitySpanRow) => void;
  onToggleStack: (root: ObservabilitySpanRow, open: boolean) => void;
  costs: ReadonlyMap<string, TaskCost | null>;
  emptyMessage: string;
  shown: number;
  total: number;
  remaining: number;
  onLoadMore: () => void;
}

export interface TaskCost {
  usd: number;
  partial: boolean;
}

// Primitives and stable callbacks only, so the memoized row skips an unchanged flush.
interface TaskListRowProps {
  root: ObservabilitySpanRow;
  status: SpanStatus;
  tone: StatusTone;
  taskDurationMs: number;
  cause: string | null;
  isSubagent: boolean;
  subagentKeys: string;
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
  const [focusTraceId, setFocusTraceId] = useQueryState(
    "trace",
    parseAsTraceId,
  );
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [railChosen, setRail] = useRemembered(LIST_RAIL_KEY, false);
  const [listKept, setListKept] = useState(false);
  const isMobile = useIsMobile();
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
  // Drop ?trace= on a filter change: a link to a run it hides would reopen with it cleared.
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

  const bounds = useMemo(
    () => effectiveWindow(timeWindow, range, now),
    [timeWindow, range, now],
  );

  const allGroups = useMemo(() => groupSpans(entries), [entries]);
  const groupByTrace = useMemo(() => {
    const byTrace = new Map<string, SpanGroup>();
    for (const group of allGroups) {
      for (const run of [group, ...group.subagents]) {
        for (const traceId of runTraceIds(run)) byTrace.set(traceId, run);
      }
    }

    return byTrace;
  }, [allGroups]);

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
  const selectedSpan =
    selectedGroup?.spans.find((span) => spanKey(span) === selectedKey) ?? null;
  if (!selectedSpan && listKept) setListKept(false);
  const rail =
    !isMobile && (railChosen || (selectedSpan !== null && !listKept));
  const chain = useMemo(
    () => (selectedGroup ? chainFor(selectedGroup, groupByTrace) : []),
    [selectedGroup, groupByTrace],
  );

  const filterSignature = `${filter}|${range}|${timeWindow?.from}|${timeWindow?.to}`;
  const [prevFilterSignature, setPrevFilterSignature] =
    useState(filterSignature);
  if (filterSignature !== prevFilterSignature) {
    setPrevFilterSignature(filterSignature);
    setVisibleCount(PAGE_SIZE);
  }

  // A ?trace= focuses once (focusedRef), so a later filter edit is not re-fought.
  const focusedRef = useRef<string | null>(null);
  const fetchedRef = useRef<string | null>(null);
  const [missingTrace, setMissingTrace] = useState<string | null>(null);
  const [prevFocusTraceId, setPrevFocusTraceId] = useState(focusTraceId);
  if (focusTraceId !== prevFocusTraceId) {
    setPrevFocusTraceId(focusTraceId);
    if (focusTraceId) setMissingTrace(null);
  }
  const [refocusNonce, setRefocusNonce] = useState(0);
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- router ?trace=, DOM row scroll
  useEffect(() => {
    if (!focusTraceId) return;
    const focusKey = `${focusTraceId}:${refocusNonce}`;
    if (focusedRef.current === focusKey) return;
    const index = groups.findIndex((group) => hasTrace(group, focusTraceId));
    if (index === -1) {
      const hidden = allGroups.find((group) => hasTrace(group, focusTraceId));
      if (hidden) {
        setFilter("");
        setRange("30d");
        // A trace fetched by id can predate the widest preset: open a window from its start.
        const start = hidden.root.startTimeMs;
        setTimeWindow(
          start < now - rangeMs("30d")
            ? { from: start - 1, to: Number.POSITIVE_INFINITY }
            : null,
        );

        return;
      }
      // Only once the backfill settled, so the two answers cannot race; marked as asked only
      // if the socket sent it.
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
    const target = groupByTrace.get(focusTraceId) ?? groups[index];
    // oxlint-disable-next-line react/set-state-in-effect -- selection follows router ?trace=
    setSelectedTaskKey(spanKey(target.root));
    if (target !== groups[index]) openStack(groups[index]);
    if (index >= visibleCount) {
      setVisibleCount(index + 1);

      return;
    }
    // A subagent's row exists once its stack opens, on the re-run (listRows is a dep).
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

  const openStack = (request: SpanGroup): void => {
    const key = spanKey(request.root);
    setStackChoices((current) => {
      if (current.get(key) !== false) return current;
      const next = new Map(current);
      next.delete(key);

      return next;
    });
  };

  const pickTask = useCallback(
    (root: ObservabilitySpanRow): void => {
      setSelectedTaskKey(spanKey(root));
      setSelectedKey(null);
      focusedRef.current = `${root.traceId}:${refocusNonce}`;
      void setFocusTraceId(root.traceId, {
        limitUrlUpdates: debounce(200),
      });
    },
    [refocusNonce, setFocusTraceId],
  );
  const toggleStack = useCallback(
    (root: ObservabilitySpanRow, open: boolean): void => {
      setStackChoices((current) => new Map(current).set(spanKey(root), open));
    },
    [],
  );

  // Not in SHORTCUTS: `k` there is the canvas's Add skill, and a key is claimed once.
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- window keydown listener
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

  // Bumps the nonce, not the ref, so re-clicking the same link focuses it again.
  const focusTrace = useCallback(
    (traceId: string) => {
      setRefocusNonce((nonce) => nonce + 1);
      void setFocusTraceId(traceId);
    },
    [setFocusTraceId],
  );

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

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <TaskListPane
          // Never a rail while empty: with no trace selected, no header holds the fold.
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

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selectedGroup && (
            <TaskWaterfall
              key={spanKey(selectedGroup.root)}
              attempt={continueAttempts.get(selectedGroup.root.traceId)}
              chain={chain}
              cost={costLabel(costs.get(spanKey(selectedGroup.root)))}
              detail={
                selectedSpan && (
                  <div
                    key={selectedKey}
                    className="min-h-0 flex-1 animate-in overflow-auto p-3 duration-150 fade-in slide-in-from-right-2 motion-reduce:animate-none"
                  >
                    <SpanDetails span={selectedSpan} />
                  </div>
                )
              }
              onCloseDetail={() => setSelectedKey(null)}
              projectSlug={projectSlug}
              stageSlug={stageSlug}
              onContinue={() => void continueTask(selectedGroup.root)}
              onPickRun={pickTask}
              fold={
                <TaskListFold
                  rail={rail}
                  onToggle={() => {
                    setRail(!rail);
                    setListKept(rail);
                  }}
                />
              }
              view={{
                costs: costs,
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
    </div>
  );
}

/** Newest first. A request is every run one event started, resumes (task.root_id) included; a
 * subagent (parent.trace_id) lists under its chain's top request, or alone without one. */
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

  // Newest first, so the last run seen per conversation is the next one.
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

/** `partial`: some step's model has no price (the sum is a floor); null: none has one; absent:
 * no step ran or no rates yet. While `loading`, a step with no rate yet is skipped. */
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
      if (!isModelCallSpan(step)) continue;
      const model = runModels.get(step.traceId);
      const rate = model ? rateByModel.get(modelKey(model)) : undefined;
      if (!rate && loading) continue;
      const priced = estimateModelTokenCost(rate, stepTokens(step));
      const stepCost = priced ? { usd: priced.total, partial: false } : null;
      costs.set(spanKey(step), stepCost);
      cost = addCost(cost, stepCost);
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

export function failureCause(group: SpanGroup): string | null {
  const error = taskError(group);
  if (!error) return null;
  if (RATE_LIMIT.test(error)) return "rate limit";

  return error.length > CAUSE_CHARS
    ? `${error.slice(0, CAUSE_CHARS).trimEnd()}…`
    : error;
}

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

export function taskChannel(root: ObservabilitySpanRow): string {
  if (root.kind === "cron") return "Cron";
  const key = unscopedConversationKey(root.conversationKey ?? "");

  return (
    CHANNEL_PREFIXES.find(({ prefix }) => key.startsWith(prefix))?.label ??
    "API"
  );
}

export function axisTicks(spanMs: number): number[] {
  const step =
    AXIS_STEPS_MS.find((candidate) => spanMs / candidate <= AXIS_MAX_STEPS) ??
    Math.ceil(spanMs / AXIS_MAX_STEPS / 3_600_000) * 3_600_000;

  return Array.from(
    { length: Math.floor(spanMs / step) + 1 },
    (_, index) => index * step,
  );
}

export function runIssues(group: SpanGroup): RunIssues {
  const all: RunIssue[] = [];
  const below = new Map<string, RunIssue[]>();
  const own = new Map<string, SpanIssue>();
  const walk = (
    span: ObservabilitySpanRow,
    path: ObservabilitySpanRow[],
  ): RunIssue[] => {
    const isTaskRow = span === group.root;
    const children = rowChildren(span, isTaskRow, group);
    // The task row is always open, so it is never on a path.
    const inside = isTaskRow ? path : [...path, span];
    const under = children.flatMap((child) => walk(child, inside));
    below.set(span.spanId, under);
    // A failure counts once, where it happened: core closes the open step and tool with the
    // run's error, and the task row (the whole request) only fails when the request did.
    const found = spanIssue(span);
    const passedUp =
      found?.level === "error" &&
      under.some(
        ({ issue }) => issue.level === "error" && issue.text === found.text,
      );
    const issue =
      passedUp || (isTaskRow && group.status !== "error") ? null : found;
    if (!issue) return under;
    own.set(span.spanId, issue);
    const entry = { issue: issue, path: path, span: span };
    all.push(entry);

    return [entry, ...under];
  };
  walk(group.root, []);
  all.sort((left, right) => left.issue.atMs - right.issue.atMs);

  return { all: all, below: below, own: own };
}

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

function addCost(
  sum: TaskCost | null | undefined,
  cost: TaskCost | null,
): TaskCost | null {
  if (cost === null) return sum ? { usd: sum.usd, partial: true } : null;
  if (!sum) return { usd: cost.usd, partial: cost.partial || sum === null };

  return { usd: sum.usd + cost.usd, partial: sum.partial || cost.partial };
}

function allSpans(group: SpanGroup): ObservabilitySpanRow[] {
  return [
    ...group.spans,
    ...group.subagents.flatMap((subagent) => subagent.spans),
  ];
}

function askedStepId(
  run: ObservabilitySpanRow,
  childrenByParent: Map<string, ObservabilitySpanRow[]>,
): string | undefined {
  if (run.attributes?.["task.waiting_on"] !== "question") return undefined;

  return (childrenByParent.get(run.spanId) ?? []).findLast(
    (child) => child.kind === "model.step",
  )?.spanId;
}

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

function canContinue(group: SpanGroup): boolean {
  return (
    (group.root.kind === "task" || group.root.kind === "cron") &&
    group.status === "error"
  );
}

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

function costLabel(cost: TaskCost | null | undefined): string | undefined {
  if (cost === undefined) return undefined;
  if (cost === null) return "not priced";

  return `${formatUsd(cost.usd)}${cost.partial ? "+" : ""}`;
}

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

function flipped(current: Set<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }

  return next;
}

function groupTone(group: SpanGroup): StatusTone {
  return group.status === "running" && !isTaskRunning(group.latest)
    ? "ended"
    : STATUS_TONE[group.status];
}

function hasTrace(group: SpanGroup, traceId: string): boolean {
  return allSpans(group).some(
    (span) => isRootSpanKind(span.kind) && span.traceId === traceId,
  );
}

function isRowOpen(span: ObservabilitySpanRow, toggled: Set<string>): boolean {
  return (span.kind === "model.step") !== toggled.has(spanKey(span));
}

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

function isStale(span: ObservabilitySpanRow, taskRunning: boolean): boolean {
  return span.status === "running" && !taskRunning;
}

function isTaskRunning(root: ObservabilitySpanRow): boolean {
  return (
    root.status === "running" &&
    Date.now() - root.startTimeMs < TASK_MAX_RUNTIME_MS
  );
}

// Core can ship a span kind before this build knows it.
function kindBar(kind: ObservabilitySpanRow["kind"]): string {
  return KIND_BAR[kind] ?? KIND_BAR["tool.call"];
}

function listedModels(groups: SpanGroup[]): ModelRef[] {
  return [...groups, ...groups.flatMap((group) => group.subagents)].flatMap(
    (group) =>
      group.spans.flatMap((span) => {
        const model = isRootSpanKind(span.kind) ? runModel(span) : null;

        return model ? [model] : [];
      }),
  );
}

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

function parentTraceOf(span: ObservabilitySpanRow): string | undefined {
  const parentTraceId = span.attributes?.["parent.trace_id"];

  return span.kind === "subtask" && typeof parentTraceId === "string"
    ? parentTraceId || undefined
    : undefined;
}

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

function rowChildren(
  span: ObservabilitySpanRow,
  isTaskRow: boolean,
  group: SpanGroup,
): ObservabilitySpanRow[] {
  return span.kind === "subtask" && !isTaskRow
    ? []
    : (group.childrenByParent.get(span.spanId) ?? []);
}

function rowLabel(span: ObservabilitySpanRow): string {
  return span.kind === "task" || span.kind === "cron"
    ? "resumed"
    : spanLabel(span);
}

function spanKey(span: ObservabilitySpanRow): string {
  return `${span.traceId}:${span.spanId}`;
}

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

// Safe to cache: the stream replaces a span object when it updates, never mutates it.
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

function spanTokens(span: ObservabilitySpanRow): number | undefined {
  return (
    numericAttribute(span, "usage.total_tokens") ??
    numericAttribute(span, "model.total_tokens")
  );
}

function runTraceIds(group: SpanGroup): string[] {
  return group.spans
    .filter(
      (span) =>
        span === group.root ||
        (isRootSpanKind(span.kind) && span.kind !== "subtask"),
    )
    .map((span) => span.traceId);
}

function stopRowClick(event: MouseEvent): void {
  event.stopPropagation();
}

function subagentName(span: ObservabilitySpanRow): string {
  const agentId = span.attributes?.["agent.id"] ?? span.agentId;

  return typeof agentId === "string" && agentId ? agentId : "subagent";
}

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
  // An open wait runs until now and would stretch the window; its row shows the elapsed time.
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

function taskError(group: SpanGroup): string | null {
  if (group.status !== "error") return null;
  const failed = group.spans.filter((span) => span.error);

  return (
    (failed.findLast((span) => isRootSpanKind(span.kind)) ?? failed[0])
      ?.error ?? null
  );
}

function taskKey(root: ObservabilitySpanRow): string {
  const taskId =
    root.attributes?.["task.root_id"] ?? root.attributes?.["task.id"];

  return typeof taskId === "string" && taskId ? taskId : root.traceId;
}

function timelinePct(ms: number, scale: TimelineScale): number {
  return ((ms - scale.startMs) / scale.spanMs) * 100;
}

function toolIcon(span: ObservabilitySpanRow): LucideIcon {
  const name = spanLabel(span);

  return TOOL_ICONS.find(({ test }) => test.test(name))?.icon ?? Wrench;
}

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

function unscopedConversationKey(key: string): string {
  return key.replace(/^acct:[^:]+:agent:[^:]+:/, "");
}

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

function AvatarStack({
  keys,
  names,
  open,
  onToggle,
}: {
  keys: string[];
  names: string[];
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const shown = keys.slice(0, STACK_AVATARS);

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? "Hide subagents" : "Show subagents"}
      title={names.join(", ")}
      className="flex shrink-0 cursor-pointer items-center self-end rounded pr-3 pb-1.5 pl-1"
    >
      {shown.map((key, index) => (
        <DitherAvatarSVG
          key={key}
          seed={names[index]}
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
      <td
        colSpan={5}
        className="relative pt-0 pr-3 pb-1.5 pl-(--row-indent) text-destructive"
        style={{
          "--row-indent": `calc(${STARTED_COLUMN_WIDTH} + ${depth * 18 + 12}px)`,
        }}
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
      <td
        colSpan={5}
        aria-label={label}
        className="py-1.5 pr-3 pl-(--row-indent)"
        style={{
          "--row-indent": `calc(${STARTED_COLUMN_WIDTH} + ${depth * 18 + 12}px)`,
        }}
      >
        {children}
      </td>
    </tr>
  );
}

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

/** Not clickable, so a drag selects its text; the line above selects the span. */
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
  // Pretty-printing is costly, and the parent re-renders on every message of a live run.
  const { sections, rows } = useMemo(
    () => ({ sections: payloadSections(span), rows: detailRows(span) }),
    [span],
  );
  const modelId = span.attributes?.["model.id"];

  // minmax(0,1fr): a long unbroken payload would otherwise widen the track past the panel.
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <SpanTimings span={span} />
      {span.error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {span.error}
        </div>
      )}
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

function PhaseLine({
  cost,
  isOpen,
  onToggle,
  span,
}: {
  cost: string | undefined;
  isOpen: boolean;
  onToggle: () => void;
  span: ObservabilitySpanRow;
}): React.JSX.Element {
  const name = spanLabel(span);
  const Icon = span.name === WAIT_SPAN_NAME ? MessageCircleQuestionMark : Zap;
  const messages =
    numericAttribute(span, "prepare.history_rows") ??
    numericAttribute(span, "compaction.message_count");
  const tokens = spanTokens(span);
  const line = (
    <TraceLine size="xs">
      <TraceIcon>
        <Icon />
      </TraceIcon>
      <TraceTitle>{name}</TraceTitle>
      {messages !== undefined && (
        <TraceDescription>
          {messages.toLocaleString()} messages
        </TraceDescription>
      )}
      {cost !== undefined && <TraceDescription>{cost}</TraceDescription>}
      {tokens !== undefined && (
        <TraceDescription>{formatNumber(tokens)} tok</TraceDescription>
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

function SpanLine({
  cost,
  hasChildren,
  isOpen,
  isTaskRow,
  onFocusTrace,
  onToggle,
  span,
}: {
  cost: string | undefined;
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
    return (
      <PhaseLine cost={cost} isOpen={isOpen} onToggle={onToggle} span={span} />
    );
  }

  return (
    <StepLine
      cost={cost}
      hasChildren={hasChildren}
      isOpen={isOpen}
      name={rowLabel(span)}
      onToggle={onToggle}
      span={span}
    />
  );
}

function StepLine({
  cost,
  hasChildren,
  isOpen,
  name,
  onToggle,
  span,
}: {
  cost: string | undefined;
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
      {cost !== undefined && tokens !== undefined && (
        <TraceDescription>{cost}</TraceDescription>
      )}
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
  cost,
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
  cost: string | undefined;
  onFocusTrace: (traceId: string) => void;
  issue: SpanIssue | null;
  below: RunIssue[];
  live: boolean;
}): React.JSX.Element {
  const isTaskRow = depth === 0;
  const runsToNow = isTaskRow ? live : span.status === "running" && taskRunning;
  const durationMs = isTaskRow ? group.taskDurationMs : span.durationMs;
  const belowErrors = below.filter(
    ({ issue }) => issue.level === "error",
  ).length;

  return (
    <tr
      onClick={onClick}
      data-span-key={spanKey(span)}
      className={cn(
        "cursor-pointer border-b border-border/40 transition hover:bg-accent/20",
        isSelected && "bg-accent",
        !isRootSpanKind(span.kind) && "text-foreground/80",
        highlighted && "animate-trace-flash",
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
              cost={cost}
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
      {/* "streaming" is token generation only; tool execution is "tool wait". */}
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
        "max-h-72 shrink-0 overflow-x-hidden overflow-y-auto border-b border-border md:max-h-none md:border-r md:border-b-0",
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
            subagentKeys={group.subagents
              .map((subagent) => spanKey(subagent.root))
              .join("\n")}
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

const TaskListRow = memo(function TaskListRow({
  root,
  status,
  tone,
  taskDurationMs,
  cause,
  isSubagent,
  subagentKeys,
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
          keys={subagentKeys.split("\n")}
          names={subagentNames.split("\n")}
          open={stackOpen}
          onToggle={() => onToggleStack(root, !stackOpen)}
        />
      )}
    </div>
  );
});

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

function TaskWaterfall({
  attempt,
  chain,
  cost,
  detail,
  fold,
  onCloseDetail,
  onContinue,
  onPickRun,
  projectSlug,
  stageSlug,
  view: panelView,
}: {
  attempt: ContinueAttempt | undefined;
  chain: SpanGroup[];
  cost: string | undefined;
  detail: ReactNode;
  fold: React.ReactNode;
  onCloseDetail: () => void;
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
  const showSpan = ({ path, span }: RunIssue): void => {
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
                : group.subagents.length > 0
                  ? "Estimated cost, subagents included"
                  : "Estimated cost"
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
        {detail && (
          <button
            type="button"
            onClick={onCloseDetail}
            aria-label="Close details"
            className="-m-1 ml-auto cursor-pointer rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <DetailSplit flush tableMinWidth={WATERFALL_MIN_WIDTH} detail={detail}>
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
      </DetailSplit>
    </>
  );
}

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
  marks: RunIssue[];
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

  // A retried call waits before its first token, so the retry wait leads the bar.
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
        className="absolute top-1/2 left-(--bar-left) flex h-2 w-(--bar-width) -translate-y-1/2 overflow-hidden rounded-sm"
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
        {marks.map(({ issue, span: marked }) => (
          <span
            key={spanKey(marked)}
            className={cn(
              "absolute inset-y-0 left-(--mark-left) w-0.5",
              STATUS_TONE_BG[issue.level],
            )}
            style={{
              "--mark-left": `${Math.min(100, Math.max(0, ((issue.atMs - span.startTimeMs) / shownMs) * 100))}%`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function TimelineAxis({
  issues,
  onPick,
}: {
  issues: RunIssue[];
  onPick: (entry: RunIssue) => void;
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
              "absolute top-0 left-(--tick-left) font-mono tabular-nums",
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
          className="absolute -bottom-2 left-(--now-left) size-1.5 -translate-x-1/2 rounded-full bg-info"
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
              "absolute -bottom-2.5 left-(--mark-left) size-2 -translate-x-1/2 rotate-45 cursor-pointer rounded-xs",
              STATUS_TONE_BG[issue.level],
            )}
            style={{ "--mark-left": `${timelinePct(issue.atMs, scale)}%` }}
          />
        );
      })}
    </div>
  );
}

/** On a live run's tick only the parts that read the scale re-render, not the rows. */
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
  // The clock can trail the stream by a tick, so now never precedes the newest span.
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

function TimelineLines({ issues }: { issues: RunIssue[] }): React.JSX.Element {
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
            "absolute inset-y-0 left-(--line-left) w-px",
            issue.level === "error" ? "bg-destructive/30" : "bg-warning/30",
          )}
          style={{ "--line-left": `${timelinePct(issue.atMs, scale)}%` }}
        />
      ))}
      {scale.nowMs !== null && (
        <span
          className="absolute inset-y-0 left-(--now-left) w-px bg-info/60"
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
      cost={costLabel(view.costs.get(key))}
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

function taskInput(root: ObservabilitySpanRow): string {
  const input = root.attributes?.["task.input"];

  return typeof input === "string" && input ? input : root.traceId;
}
