"use client";

/** Monitoring panel: dense log table streamed live from the gateway observability WS. */
import { Section } from "@/app/components/Section";
import { cn } from "@/app/lib/utils";
import {
  useObservabilityStream,
  type ObservabilityLogEntry,
} from "@/app/hooks/useObservabilityStream";
import { AlertTriangle, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";

interface Props {
  projectSlug: string | undefined;
  environmentSlug: string | undefined;
  apiKey: string | undefined;
}

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

function levelColor(level: ObservabilityLogEntry["level"]): string {
  if (level === "ERROR") return "text-red-400";
  if (level === "WARN") return "text-yellow-400";

  return "text-muted-foreground";
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
          <span className={cn("inline-flex items-center gap-1", levelColor(entry.level))}>
            {(entry.level === "ERROR" || entry.level === "WARN") && (
              <AlertTriangle className="size-3" />
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
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-2 rounded bg-muted/40 px-1.5 py-0.5">
              {parsed.eventType ?? entry.eventType}
            </span>
          )}
          {parsed.summary}
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b border-border/40 bg-background/40">
          <td colSpan={4} className="px-3 py-3">
            <div className="flex flex-col gap-2">
              {entry.traceId && (
                <div className="text-[10px] text-muted-foreground/70 font-mono">
                  trace: {entry.traceId}
                </div>
              )}
              {entry.endpointId && (
                <div
                  className="text-[10px] text-muted-foreground/70 break-all"
                  title={entry.endpointId}
                >
                  {entry.endpointId}
                </div>
              )}
              <pre
                className={cn(
                  "whitespace-pre-wrap break-words leading-relaxed bg-background/60 border border-border rounded p-3 max-h-[500px] overflow-auto text-xs",
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

  const { entries, status, error, refresh } = useObservabilityStream({
    stream: "logs",
    projectSlug: projectSlug,
    environmentSlug: environmentSlug,
    apiKey: apiKey,
    backfill: 200,
  });

  const isConnecting = status === "connecting";

  const filtered = useMemo(() => {
    if (!filter.trim()) return entries;
    const needle = filter.toLowerCase();

    return entries.filter(
      (e) =>
        e.message.toLowerCase().includes(needle) ||
        (e.endpointId ?? "").toLowerCase().includes(needle) ||
        (e.service ?? "").toLowerCase().includes(needle) ||
        e.eventType.toLowerCase().includes(needle),
    );
  }, [entries, filter]);

  return (
    <div className="grid gap-8">
      <Section description="Project service logs from channel ingress, agent execution, tools, and runtime services.">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="flex items-center gap-2 flex-1 min-w-[240px]">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={`Search ${entries.length} log${entries.length === 1 ? "" : "s"}…`}
                className="w-full rounded-md border border-border bg-card pl-8 pr-3 py-1.5 text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={status === "idle"}
            aria-label="Refresh durable logs"
            title={error ?? "Refresh from Loki"}
            className={cn(
              "cursor-pointer rounded-md border border-border bg-card p-2 text-muted-foreground transition-colors hover:text-foreground",
              status === "idle" && "cursor-not-allowed opacity-50",
              status === "error" && "text-destructive",
            )}
          >
            <RefreshCw className={cn("size-3.5", isConnecting && "animate-spin")} />
          </button>
        </div>

        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="max-h-[700px] overflow-auto">
            <table className="w-full text-xs font-mono table-fixed">
              <colgroup>
                <col className="w-[170px]" />
                <col className="w-[80px]" />
                <col className="w-[200px]" />
                <col />
              </colgroup>
              <thead className="sticky top-0 bg-card/95 backdrop-blur border-b border-border z-10">
                <tr className="text-left text-muted-foreground/80 text-[10px] uppercase tracking-wide">
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
                  <tr aria-hidden="true">
                    <td colSpan={4} className="h-32" />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Section>
    </div>
  );
}
