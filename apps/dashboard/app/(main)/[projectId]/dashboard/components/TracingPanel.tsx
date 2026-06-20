"use client";

/** Tracing panel: searchable task timelines with model and tool span details. */
import { Section } from "@/app/components/Section";
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
  RefreshCw,
  Search,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

interface Props {
  projectSlug: string | undefined;
  environmentSlug: string | undefined;
  apiKey: string | undefined;
}

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

/** Group spans into task trees, newest task first. */
function groupSpans(spans: ObservabilitySpanRow[]): Array<{
  root: ObservabilitySpanRow;
  children: ObservabilitySpanRow[];
}> {
  const tasks = spans.filter((span) => span.kind === "task");
  const childrenByTrace = new Map<string, ObservabilitySpanRow[]>();

  for (const span of spans) {
    if (span.kind === "task") continue;
    const children = childrenByTrace.get(span.traceId) ?? [];
    children.push(span);
    childrenByTrace.set(span.traceId, children);
  }

  return tasks
    .map((root) => ({
      root: root,
      children: (childrenByTrace.get(root.traceId) ?? []).sort(
        (left, right) => left.startTimeMs - right.startTimeMs,
      ),
    }))
    .sort((left, right) => right.root.startTimeMs - left.root.startTimeMs);
}

function SpanStatusIcon({ status }: { status: ObservabilitySpanRow["status"] }) {
  if (status === "running") {
    return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-sky-400" />;
  }
  if (status === "error") {
    return <XCircle className="size-3.5 shrink-0 text-red-400" />;
  }

  return <CheckCircle className="size-3.5 shrink-0 text-green-500" />;
}

function spanLabel(span: ObservabilitySpanRow): string {
  if (span.kind === "tool.call") {
    const toolName = span.attributes?.["tool.name"];
    return typeof toolName === "string" ? `Tool: ${toolName}` : "Tool call";
  }
  const stepNumber = span.attributes?.["agent.step_number"];
  return typeof stepNumber === "number" ? `Model step ${stepNumber + 1}` : span.name;
}

function SpanDetails({ span }: { span: ObservabilitySpanRow }) {
  const attributes = span.attributes ?? {};
  const details = DETAIL_ATTRIBUTES.flatMap((key) => {
    const value = displayAttribute(attributes[key]);

    return value ? [{ key: key, value: value }] : [];
  });
  const metadata = Object.entries(attributes).filter(
    ([key]) => !DETAIL_ATTRIBUTES.includes(key as (typeof DETAIL_ATTRIBUTES)[number]),
  );

  return (
    <div className="grid gap-3 border-t border-border/30 bg-background/60 px-4 py-3">
      {span.error && (
        <div className="rounded border border-red-500/20 bg-red-950/20 p-2 text-xs text-red-400">
          {span.error}
        </div>
      )}
      {details.map(({ key, value }) => (
        <div key={key} className="grid gap-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {key.replaceAll(".", " ")}
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-card p-3 text-[11px] leading-relaxed text-foreground/90">
            {value}
          </pre>
        </div>
      ))}
      {metadata.length > 0 && (
        <div className="grid gap-x-4 gap-y-1 text-[10px] font-mono text-muted-foreground sm:grid-cols-2">
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

function ChildSpanRow({ span }: { span: ObservabilitySpanRow }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-border/30 last:border-0">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent/20"
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <SpanStatusIcon status={span.status} />
        <span className="flex-1 truncate" title={spanLabel(span)}>
          {spanLabel(span)}
        </span>
        <span className="rounded bg-muted/50 px-1.5 py-0.5 text-[9px] uppercase tracking-wide">
          {span.kind}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground/60">
          {span.status === "running" ? "Running" : formatDuration(span.durationMs)}
        </span>
      </button>
      {expanded && <SpanDetails span={span} />}
    </div>
  );
}

function TaskRow({
  root,
  childSpans,
  isExpanded,
  onToggle,
}: {
  root: ObservabilitySpanRow;
  childSpans: ObservabilitySpanRow[];
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const taskId = root.attributes?.["task.id"];
  const taskLabel = typeof taskId === "string" ? taskId : root.traceId;

  return (
    <div className="border-b border-border/40 last:border-0">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_100px_90px_80px] items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/20",
          isExpanded && "bg-accent/30",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <SpanStatusIcon status={root.status} />
          <span className="min-w-0">
            <span className="block truncate text-xs font-mono" title={taskLabel}>
              {taskLabel}
            </span>
            <span className="block truncate text-[10px] text-muted-foreground">
              {root.agentId ?? "Unknown agent"} · {root.conversationKey ?? "No conversation"}
            </span>
          </span>
        </span>
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {root.status}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground/70">
          {root.status === "running" ? "Running" : formatDuration(root.durationMs)}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground/50">
          {formatTime(root.startTimeMs)}
        </span>
      </button>
      {isExpanded && (
        <div className="border-t border-border/30 bg-background/40">
          <div className="grid gap-1 border-b border-border/30 px-4 py-2 text-[10px] font-mono text-muted-foreground sm:grid-cols-2">
            <span>trace: {root.traceId}</span>
            <span className="truncate">agent: {root.agentId ?? "unknown"}</span>
          </div>
          <SpanDetails span={root} />
          {childSpans.map((child) => (
            <ChildSpanRow key={`${child.traceId}:${child.spanId}`} span={child} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TracingPanel({ projectSlug, environmentSlug, apiKey }: Props) {
  const [expandedTraceId, setExpandedTraceId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const { entries, status, error, refresh } = useObservabilityStream({
    stream: "traces",
    projectSlug: projectSlug,
    environmentSlug: environmentSlug,
    apiKey: apiKey,
    backfill: 100,
  });

  const groups = useMemo(() => {
    const allGroups = groupSpans(entries);
    const needle = filter.trim().toLowerCase();
    if (!needle) return allGroups;

    return allGroups.filter(({ root, children }) =>
      [root, ...children].some((span) =>
        [
          span.name,
          span.kind,
          span.status,
          span.traceId,
          span.agentId ?? "",
          span.conversationKey ?? "",
          JSON.stringify(span.attributes ?? {}),
        ].some((value) => value.toLowerCase().includes(needle)),
      ),
    );
  }, [entries, filter]);

  return (
    <div className="grid gap-8">
      <Section description="Task timelines with model input, reasoning, responses, tool calls, and tool results.">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="relative w-full max-w-md">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={`Search ${groups.length} task${groups.length === 1 ? "" : "s"}…`}
              className="w-full rounded-md border border-border bg-card py-1.5 pl-8 pr-3 text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={status === "idle"}
            aria-label="Refresh durable traces"
            title={error ?? "Refresh from Tempo"}
            className={cn(
              "cursor-pointer rounded-md border border-border bg-card p-2 text-muted-foreground transition-colors hover:text-foreground",
              status === "idle" && "cursor-not-allowed opacity-50",
              status === "error" && "text-destructive",
            )}
          >
            <RefreshCw className={cn("size-3.5", status === "connecting" && "animate-spin")} />
          </button>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="grid grid-cols-[minmax(0,1fr)_100px_90px_80px] gap-3 border-b border-border px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground/80">
            <span>Task</span>
            <span>Status</span>
            <span>Duration</span>
            <span>Started</span>
          </div>
          <div className="min-h-32 max-h-[700px] overflow-auto">
            {groups.map(({ root, children }) => (
              <TaskRow
                key={root.traceId}
                root={root}
                childSpans={children}
                isExpanded={expandedTraceId === root.traceId}
                onToggle={() =>
                  setExpandedTraceId((current) => current === root.traceId ? null : root.traceId)
                }
              />
            ))}
          </div>
        </div>
      </Section>
    </div>
  );
}
