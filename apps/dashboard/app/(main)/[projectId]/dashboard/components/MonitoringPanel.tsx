"use client";

/** Monitoring panel: dense, full-height log table streamed live from the gateway observability WS. */
import { Badge } from "@/app/components/ui/badge";
import { cn } from "@/app/lib/utils";
import {
  useObservabilityStream,
  type ObservabilityLogEntry,
} from "@/app/hooks/useObservabilityStream";
import { AlertTriangle } from "lucide-react";
import { useMemo, useState } from "react";
import { ObservabilityToolbar, type ToolbarFilterOption } from "./ObservabilityToolbar";

interface Props {
  projectSlug: string | undefined;
  environmentSlug: string | undefined;
  apiKey: string | undefined;
}

type LevelFilter = "all" | ObservabilityLogEntry["level"];

const LEVEL_FILTER_OPTIONS: ToolbarFilterOption[] = [
  { value: "all", label: "All levels" },
  { value: "ERROR", label: "ERROR" },
  { value: "WARN", label: "WARN" },
  { value: "INFO", label: "INFO" },
  { value: "DEBUG", label: "DEBUG" },
];

function formatDateTime(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  const date = d
    .toLocaleDateString([], { month: "short", day: "2-digit" })
    .toUpperCase();
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const ms3 = String(d.getMilliseconds()).padStart(3, "0");

  return { date: date, time: `${time}.${ms3.slice(0, 2)}` };
}

/** Parse a datetime-local input value into epoch ms, or null when empty/invalid. */
function toEpochMs(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();

  return Number.isFinite(ms) ? ms : null;
}

/**
 * Best-effort prettifier: if the message starts with a JSON object/array,
 * parse and re-stringify with indentation. Falls back to the raw string.
 */
function parseLogMessage(raw: string): {
  summary: string;
  pretty: string;
  eventType?: string;
} {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      const pretty = JSON.stringify(parsed, null, 2);
      const summary =
        (typeof parsed?.message === "string" && parsed.message) ||
        (typeof parsed?.error === "string" && parsed.error) ||
        (typeof parsed?.eventType === "string" && parsed.eventType) ||
        trimmed.slice(0, 200);
      const eventType =
        typeof parsed?.eventType === "string" ? parsed.eventType : undefined;

      return { summary: summary, pretty: pretty, eventType: eventType };
    } catch {
      // fall through
    }
  }

  return { summary: trimmed.slice(0, 200), pretty: trimmed };
}

/** Strip the long region / account suffix from the function name for table density. */
function shortFunctionName(name: string): string {
  return name
    .replace(/-ap-[a-z]+-\d+-\d{6,}$/i, "")
    .replace(/^filthy-panty-/, "");
}

/** Text color per log level — INFO is now distinctly colored, not muted. */
function levelColor(level: ObservabilityLogEntry["level"]): string {
  if (level === "ERROR") return "text-red-400";
  if (level === "WARN") return "text-amber-400";
  if (level === "INFO") return "text-sky-400";

  return "text-muted-foreground";
}

/** Matching dot color so the level reads at a glance even when scanning fast. */
function levelDot(level: ObservabilityLogEntry["level"]): string {
  if (level === "ERROR") return "bg-red-400";
  if (level === "WARN") return "bg-amber-400";
  if (level === "INFO") return "bg-sky-400";

  return "bg-muted-foreground/60";
}

function LogRow({
  entry,
  isExpanded,
  onToggle,
}: {
  entry: ObservabilityLogEntry;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const parsed = useMemo(() => parseLogMessage(entry.message), [entry.message]);
  const { date, time } = formatDateTime(entry.ts);

  return (
    <>
      <tr
        onClick={onToggle}
        className={cn(
          "cursor-pointer border-b border-border/40 hover:bg-accent/20 transition-colors",
          isExpanded && "bg-accent/30",
        )}
      >
        <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground tabular-nums">
          <span className="text-muted-foreground/60 mr-1">{date}</span>
          {time}
        </td>
        <td className="px-3 py-1.5 whitespace-nowrap">
          <span className={cn("inline-flex items-center gap-1.5 font-medium", levelColor(entry.level))}>
            {entry.level === "ERROR" || entry.level === "WARN" ? (
              <AlertTriangle className="size-3" />
            ) : (
              <span className={cn("size-1.5 rounded-full", levelDot(entry.level))} />
            )}
            {entry.level}
          </span>
        </td>
        <td
          className="px-3 py-1.5 whitespace-nowrap text-muted-foreground/80 max-w-[200px] truncate"
          title={entry.endpointId}
        >
          {entry.service
            ? shortFunctionName(entry.service)
            : entry.endpointId
              ? shortFunctionName(entry.endpointId)
              : entry.agentId ?? "—"}
        </td>
        <td className="px-3 py-1.5 text-foreground/90 max-w-0 truncate">
          {(parsed.eventType ?? entry.eventType) && (
            <Badge variant="secondary" className="mr-2 px-1.5 py-0 text-[10px] uppercase tracking-wide">
              {parsed.eventType ?? entry.eventType}
            </Badge>
          )}
          {parsed.summary}
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b border-border/40 bg-background/40">
          <td colSpan={4} className="px-3 py-3">
            <div className="flex flex-col gap-2">
              {entry.traceId && (
                <div className="text-[11px] text-muted-foreground/70 font-mono">
                  trace: {entry.traceId}
                </div>
              )}
              {entry.endpointId && (
                <div
                  className="text-[11px] text-muted-foreground/70 break-all"
                  title={entry.endpointId}
                >
                  {entry.endpointId}
                </div>
              )}
              <pre
                className={cn(
                  "whitespace-pre-wrap break-words leading-relaxed bg-background/60 border border-border rounded p-3 max-h-[60vh] overflow-auto text-xs",
                  levelColor(entry.level),
                )}
              >
                {parsed.pretty}
              </pre>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function MonitoringPanel({ projectSlug, environmentSlug, apiKey }: Props) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");

  const { entries, status, error, refresh } = useObservabilityStream({
    stream: "logs",
    projectSlug: projectSlug,
    environmentSlug: environmentSlug,
    apiKey: apiKey,
    backfill: 200,
  });

  const fromMs = toEpochMs(fromTime);
  const toMs = toEpochMs(toTime);
  const hasFilters = filter.trim() !== "" || level !== "all" || fromMs !== null || toMs !== null;

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();

    return entries.filter((e) => {
      if (level !== "all" && e.level !== level) return false;
      if (fromMs !== null && e.ts < fromMs) return false;
      if (toMs !== null && e.ts > toMs) return false;
      if (!needle) return true;

      return (
        e.message.toLowerCase().includes(needle) ||
        (e.endpointId ?? "").toLowerCase().includes(needle) ||
        (e.service ?? "").toLowerCase().includes(needle) ||
        e.eventType.toLowerCase().includes(needle)
      );
    });
  }, [entries, filter, level, fromMs, toMs]);

  const clearFilters = () => {
    setFilter("");
    setLevel("all");
    setFromTime("");
    setToTime("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <p className="shrink-0 text-xs text-muted-foreground">
        Project service logs from channel ingress, agent execution, tools, and runtime services.
      </p>

      <ObservabilityToolbar
        search={filter}
        onSearchChange={setFilter}
        searchPlaceholder={`Search ${filtered.length} of ${entries.length} log${entries.length === 1 ? "" : "s"}…`}
        filterAriaLabel="Filter by log level"
        filterValue={level}
        filterOptions={LEVEL_FILTER_OPTIONS}
        onFilterChange={(value) => setLevel(value as LevelFilter)}
        fromTime={fromTime}
        onFromTimeChange={setFromTime}
        toTime={toTime}
        onToTimeChange={setToTime}
        hasFilters={hasFilters}
        onClear={clearFilters}
        onRefresh={refresh}
        refreshDisabled={status === "idle"}
        refreshSpinning={status === "connecting"}
        refreshTitle={error ?? "Refresh from Loki"}
        isError={status === "error"}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-xs font-mono table-fixed">
            <colgroup>
              <col className="w-[170px]" />
              <col className="w-[90px]" />
              <col className="w-[200px]" />
              <col />
            </colgroup>
            <thead className="sticky top-0 bg-card/95 backdrop-blur border-b border-border z-10">
              <tr className="text-left text-muted-foreground/80 text-[11px] uppercase tracking-wide">
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Level</th>
                <th className="px-3 py-2 font-medium">Function</th>
                <th className="px-3 py-2 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry, i) => (
                <LogRow
                  key={`${entry.ts}-${i}`}
                  entry={entry}
                  isExpanded={expandedIndex === i}
                  onToggle={() =>
                    setExpandedIndex((cur) => (cur === i ? null : i))
                  }
                />
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="h-32 text-center text-xs text-muted-foreground/60">
                    {entries.length === 0 ? "Waiting for logs…" : "No logs match the current filters."}
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
