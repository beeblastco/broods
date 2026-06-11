"use client";

/** Monitoring panel: Vercel-style dense table of ERROR-level CloudWatch logs. */
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { toErrorMessage } from "@/app/lib/errors";
import { cn } from "@/app/lib/utils";
import { api } from "@filthy-panty/convex/_generated/api";
import type { Id } from "@filthy-panty/convex/_generated/dataModel";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { AlertTriangle, RefreshCw, Search, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface Props {
  projectId: Id<"projects">;
  /** Active environment to scope logs to, or null for the whole project. */
  environmentId: Id<"environments"> | null;
}

type LogEntry = FunctionReturnType<typeof api.logs.fetchForProject>[number];

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
  // Append milliseconds for parity with the Vercel logs view.
  const ms3 = String(d.getMilliseconds()).padStart(3, "0");
  return { date, time: `${time}.${ms3.slice(0, 2)}` };
}

/**
 * Best-effort prettifier: if the message starts with a JSON object/array,
 * parse and re-stringify with indentation. Falls back to the raw string.
 * Extracts a short summary (the `message`/`error`/`eventType` field if present).
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
      return { summary, pretty, eventType };
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

function LogRow({
  entry,
  isExpanded,
  onToggle,
}: {
  entry: LogEntry;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const parsed = useMemo(() => parseLogMessage(entry.message), [entry.message]);
  const { date, time } = formatDateTime(entry.timestamp);

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
          <span className="inline-flex items-center gap-1 text-red-400">
            <AlertTriangle className="size-3" />
            {entry.level}
          </span>
        </td>
        <td
          className="px-3 py-1.5 whitespace-nowrap text-muted-foreground/80 max-w-[200px] truncate"
          title={entry.functionName}
        >
          {shortFunctionName(entry.functionName)}
        </td>
        <td className="px-3 py-1.5 text-foreground/90 max-w-0 truncate">
          {parsed.eventType && (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-2 rounded bg-muted/40 px-1.5 py-0.5">
              {parsed.eventType}
            </span>
          )}
          {parsed.summary}
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b border-border/40 bg-background/40">
          <td colSpan={4} className="px-3 py-3">
            <div className="flex flex-col gap-2">
              <div
                className="text-[10px] text-muted-foreground/70 break-all"
                title={entry.functionName}
              >
                {entry.functionName}
              </div>
              <pre className="whitespace-pre-wrap break-words text-red-400 leading-relaxed bg-background/60 border border-border rounded p-3 max-h-[500px] overflow-auto text-xs">
                {parsed.pretty}
              </pre>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function MonitoringPanel({ projectId, environmentId }: Props) {
  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[] | null>(null);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [filter, setFilter] = useState("");

  const fetchForProject = useAction(api.logs.fetchForProject);

  const handleRefresh = useCallback(async () => {
    setIsFetching(true);
    setFetchError(null);
    try {
      const logs = await fetchForProject({
        projectId: projectId,
        environmentId: environmentId ?? undefined,
        errorOnly: true,
      });
      setLogEntries(logs);
    } catch (err) {
      setFetchError(toErrorMessage(err));
    } finally {
      setIsFetching(false);
    }
  }, [fetchForProject, projectId, environmentId]);

  useEffect(() => {
    let active = true;
    // Defer past the synchronous effect tick so the loading-state update in
    // handleRefresh isn't a cascading render, and drop it after unmount.
    void Promise.resolve().then(() => {
      if (active) handleRefresh();
    });

    return () => {
      active = false;
    };
  }, [handleRefresh]);

  const filtered = useMemo(() => {
    if (!logEntries) return [];
    if (!filter.trim()) return logEntries;
    const needle = filter.toLowerCase();
    return logEntries.filter(
      (e) =>
        e.message.toLowerCase().includes(needle) ||
        e.functionName.toLowerCase().includes(needle),
    );
  }, [logEntries, filter]);

  return (
    <div className="grid gap-8">
      <Section
        title="Error Logs"
        description="Live ERROR-level log stream queried directly from AWS CloudWatch."
      >
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="flex items-center gap-2 flex-1 min-w-[240px]">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={`Search ${logEntries?.length ?? 0} log${logEntries?.length === 1 ? "" : "s"}…`}
                className="w-full rounded-md border border-border bg-card pl-8 pr-3 py-1.5 text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="cursor-pointer gap-1.5"
            onClick={handleRefresh}
            disabled={isFetching}
          >
            <RefreshCw
              className={`size-3.5 ${isFetching ? "animate-spin" : ""}`}
            />
            {isFetching ? "Fetching…" : "Refresh"}
          </Button>
        </div>

        {fetchError && (
          <p className="mb-3 text-sm text-destructive">{fetchError}</p>
        )}

        {logEntries === null && !isFetching && (
          <div className="rounded-lg border border-border bg-card px-4 py-6 text-center">
            <p className="text-sm text-muted-foreground">No logs loaded yet.</p>
          </div>
        )}

        {logEntries !== null && logEntries.length === 0 && (
          <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
            <Server className="size-8 mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No errors found.</p>
            <p className="text-xs text-muted-foreground mt-1">
              All deployments are running cleanly in the selected window.
            </p>
          </div>
        )}

        {logEntries !== null && logEntries.length > 0 && (
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
                      key={`${entry.timestamp}-${i}`}
                      entry={entry}
                      isExpanded={expandedIndex === i}
                      onToggle={() =>
                        setExpandedIndex((cur) => (cur === i ? null : i))
                      }
                    />
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 && (
                <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                  No logs match &ldquo;{filter}&rdquo;.
                </div>
              )}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
