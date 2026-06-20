"use client";

/**
 * Tracing panel: expandable list of agent task spans streamed live from the
 * gateway observability WS. Each ObservabilitySpanRow where kind === "task"
 * is one root agent task; child model.step and tool.call spans are grouped under it.
 */
import { Section } from "@/app/components/Section";
import { cn } from "@/app/lib/utils";
import {
  useObservabilityStream,
  type ObservabilitySpanRow,
} from "@/app/hooks/useObservabilityStream";
import {
  Activity,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Wifi,
  XCircle,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";

interface Props {
  projectSlug: string | undefined;
  environmentSlug: string | undefined;
  apiKey: string | undefined;
}

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

/** Group spans into a tree: root task span + its children indexed by traceId. */
function groupSpans(spans: ObservabilitySpanRow[]): Array<{
  root: ObservabilitySpanRow;
  children: ObservabilitySpanRow[];
}> {
  const tasks = spans.filter((s) => s.kind === "task");
  const childrenByTrace = new Map<string, ObservabilitySpanRow[]>();

  for (const span of spans) {
    if (span.kind !== "task") {
      const list = childrenByTrace.get(span.traceId) ?? [];
      list.push(span);
      childrenByTrace.set(span.traceId, list);
    }
  }

  return tasks
    .map((root) => ({
      root: root,
      children: (childrenByTrace.get(root.traceId) ?? []).sort(
        (a, b) => a.startTimeMs - b.startTimeMs,
      ),
    }))
    .sort((a, b) => b.root.startTimeMs - a.root.startTimeMs);
}

function SpanStatusIcon({ status }: { status: "ok" | "error" }) {
  if (status === "error") {
    return <XCircle className="size-3.5 text-red-400 shrink-0" />;
  }

  return <CheckCircle className="size-3.5 text-green-500 shrink-0" />;
}

function ChildSpanRow({ span }: { span: ObservabilitySpanRow }) {
  const indent = span.kind === "tool.call" ? "pl-8" : "pl-4";

  return (
    <div
      className={cn(
        "flex items-center gap-2 py-1 text-[11px] font-mono text-muted-foreground border-b border-border/30 last:border-0",
        indent,
      )}
    >
      <SpanStatusIcon status={span.status} />
      <span className="flex-1 truncate" title={span.name}>
        {span.name}
      </span>
      <span className="tabular-nums text-muted-foreground/60 shrink-0">
        {formatDuration(span.durationMs)}
      </span>
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
  const tokenCount =
    typeof root.attributes?.["llm.token.total"] === "number"
      ? root.attributes["llm.token.total"]
      : null;

  return (
    <div className="border-b border-border/40 last:border-0">
      <div
        onClick={onToggle}
        className={cn(
          "flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-accent/20 transition-colors",
          isExpanded && "bg-accent/30",
        )}
      >
        {isExpanded ? (
          <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
        )}
        <SpanStatusIcon status={root.status} />
        <span className="flex-1 text-xs font-mono truncate" title={root.name}>
          {root.name}
        </span>
        {tokenCount !== null && (
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 shrink-0">
            <Zap className="size-3" />
            {tokenCount.toLocaleString()}
          </span>
        )}
        <span className="text-xs tabular-nums text-muted-foreground/70 shrink-0">
          {formatDuration(root.durationMs)}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground/50 shrink-0">
          {formatTime(root.startTimeMs)}
        </span>
      </div>
      {isExpanded && (
        <div className="bg-background/40 border-t border-border/30">
          {root.error && (
            <div className="px-4 py-2 text-xs text-red-400 bg-red-950/20 border-b border-border/30">
              {root.error}
            </div>
          )}
          {root.traceId && (
            <div className="px-4 py-1.5 text-[10px] text-muted-foreground/60 font-mono border-b border-border/30">
              trace: {root.traceId}
            </div>
          )}
          {childSpans.length > 0 ? (
            <div className="px-3 py-1">
              {childSpans.map((child) => (
                <ChildSpanRow key={`${child.traceId}:${child.spanId}`} span={child} />
              ))}
            </div>
          ) : (
            <div className="px-4 py-2 text-xs text-muted-foreground/50">
              No child spans recorded.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TracingPanel({ projectSlug, environmentSlug, apiKey }: Props) {
  const [expandedTraceId, setExpandedTraceId] = useState<string | null>(null);

  const { entries, status, error } = useObservabilityStream({
    stream: "traces",
    projectSlug: projectSlug,
    environmentSlug: environmentSlug,
    apiKey: apiKey,
    backfill: 50,
  });

  const isConnecting = status === "connecting";
  const isLive = status === "live";

  const groups = useMemo(() => groupSpans(entries), [entries]);

  return (
    <div className="grid gap-8">
      <Section description="Agent task traces streamed live from the gateway observability WS. Each row is one task request.">
        <div className="flex items-center justify-end mb-3">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            {status === "error" ? (
              <XCircle className="size-3.5 text-destructive" />
            ) : isConnecting ? (
              <RefreshCw className="size-3.5 animate-spin" />
            ) : isLive ? (
              <Wifi className="size-3.5 text-green-500" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {status === "error"
              ? error ?? "Disconnected"
              : isConnecting
                ? "Connecting…"
                : isLive
                  ? "Live"
                  : "Waiting for credentials…"}
          </span>
        </div>

        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="max-h-[700px] overflow-auto">
            {groups.map(({ root, children }) => (
              <TaskRow
                key={root.traceId}
                root={root}
                childSpans={children}
                isExpanded={expandedTraceId === root.traceId}
                onToggle={() =>
                  setExpandedTraceId((cur) =>
                    cur === root.traceId ? null : root.traceId,
                  )
                }
              />
            ))}
            {groups.length === 0 && (
              <div className="flex items-center justify-center gap-2 px-4 py-10 text-xs text-muted-foreground/60">
                <Activity className="size-4" />
                {isLive ? "Listening for task traces…" : "Connecting to the trace stream…"}
              </div>
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}
