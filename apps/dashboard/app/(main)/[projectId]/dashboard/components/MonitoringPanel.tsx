"use client";

import {
  DetailFields,
  DetailPayload,
  type DetailRow,
} from "@/app/components/DetailSections";
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { StatusDot, type StatusTone } from "@/app/components/StatusDot";
import { Button } from "@/app/components/ui/button";
import {
  entryKey,
  isTraceId,
  useObservabilityStream,
  type ObservabilityLogEntry,
} from "@/app/hooks/useObservabilityStream";
import { formatDateTimeMillis, toEpochMs } from "@/app/lib/formatTime";
import { cn } from "@/app/lib/utils";
import { ArrowUpRight } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  emptyStreamMessage,
  ObservabilityToolbar,
  type ToolbarFilterOption,
} from "./ObservabilityToolbar";

const LEVEL_FILTER_OPTIONS: ToolbarFilterOption[] = [
  { value: "all", label: "All levels" },
  { value: "ERROR", label: "error" },
  { value: "WARN", label: "warn" },
  { value: "INFO", label: "info" },
  { value: "DEBUG", label: "debug" },
];

const LEVEL_TONE: Record<ObservabilityLogEntry["level"], StatusTone> = {
  ERROR: "error",
  WARN: "warn",
  INFO: "ok",
  DEBUG: "ended",
};

// Rows rendered before the "Load more" pager; keeps the DOM bounded even when the
// live buffer holds thousands of entries.
const PAGE_SIZE = 100;

type LevelFilter = "all" | ObservabilityLogEntry["level"];

interface Props {
  projectSlug: string | undefined;
  stageSlug: string | undefined;
  apiKey: string | undefined;
}

export function MonitoringPanel({
  projectSlug,
  stageSlug,
  apiKey,
}: Props): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The entry object itself, not an index: indices drift as new logs stream in
  // and would silently repoint the open panel at a different line.
  const [selected, setSelected] = useState<ObservabilityLogEntry | null>(null);
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Memoized so the streaming re-renders don't re-parse the open payload.
  const selectedSummary = useMemo(
    () => (selected ? parseLogMessage(selected.message).summary : null),
    [selected],
  );

  const viewTrace = (traceId: string): void => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", "tracing");
    next.set("trace", traceId);
    router.push(`${pathname}?${next.toString()}`);
  };

  const { entries, status, history, error, refresh } = useObservabilityStream({
    stream: "logs",
    projectSlug: projectSlug,
    stageSlug: stageSlug,
    apiKey: apiKey,
    backfill: 200,
    minLevel: "DEBUG",
  });

  const fromMs = toEpochMs(fromTime);
  const toMs = toEpochMs(toTime);
  const hasFilters =
    filter.trim() !== "" || level !== "all" || fromMs !== null || toMs !== null;

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

  // Reset paging whenever the filters change so "Load more" always starts from
  // the top of the current view. Render-time adjustment, not an effect.
  const filterSignature = `${filter}|${level}|${fromMs}|${toMs}`;
  const [prevFilterSignature, setPrevFilterSignature] =
    useState(filterSignature);
  if (filterSignature !== prevFilterSignature) {
    setPrevFilterSignature(filterSignature);
    setVisibleCount(PAGE_SIZE);
  }

  const visible = filtered.slice(0, visibleCount);
  const remaining = filtered.length - visible.length;
  const selectedTraceId =
    selected && isTraceId(selected.traceId) ? selected.traceId : null;

  const clearFilters = (): void => {
    setFilter("");
    setLevel("all");
    setFromTime("");
    setToTime("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
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
        refreshTitle={error ?? "Refresh logs"}
        isError={status === "error"}
      />

      <DetailSplit
        detail={
          selected && (
            <DetailPanel
              title={selectedSummary}
              meta={
                <div className="mt-0.5 flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
                  <span>{sourceLabel(selected)}</span>
                  <StatusDot
                    tone={LEVEL_TONE[selected.level]}
                    label={selected.level.toLowerCase()}
                  />
                  <span className="font-mono">
                    {formatDateTimeMillis(selected.ts)}
                  </span>
                  {selectedTraceId && (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => viewTrace(selectedTraceId)}
                    >
                      View trace
                      <ArrowUpRight />
                    </Button>
                  )}
                </div>
              }
              onClose={() => setSelected(null)}
            >
              <LogDetails entry={selected} />
            </DetailPanel>
          )
        }
      >
        <table className="w-full table-fixed text-xs">
          <colgroup>
            <col className="w-40" />
            <col className="w-19" />
            <col className="w-36" />
            <col />
          </colgroup>
          <thead className="sticky top-0 z-10 border-b border-border bg-card/95">
            <tr className="text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">Time</th>
              <th className="px-3 py-2 font-medium">Level</th>
              <th className="px-3 py-2 font-medium">Service</th>
              <th className="px-3 py-2 font-medium">Message</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => (
              <LogRow
                key={entryKey(entry)}
                entry={entry}
                isSelected={selected === entry}
                onSelect={() => setSelected(entry)}
              />
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="h-32 text-center text-xs text-muted-foreground"
                >
                  {entries.length === 0
                    ? emptyStreamMessage(history, error, "logs", "30 days")
                    : "No logs match the current filters."}
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
              {remaining.toLocaleString()} older
            </button>
          </div>
        )}
      </DetailSplit>
    </div>
  );
}

/** The copyable rows under Details: where the line came from. The level is in the header. */
function detailRows(entry: ObservabilityLogEntry): DetailRow[] {
  const rows: DetailRow[] = [];
  if (isTraceId(entry.traceId)) {
    rows.push({ key: "traceId", label: "Trace id", value: entry.traceId });
  }
  if (entry.endpointId) {
    rows.push({
      key: "endpointId",
      label: "Endpoint",
      value: entry.endpointId,
    });
  }
  if (entry.agentId) {
    rows.push({ key: "agentId", label: "Agent", value: entry.agentId });
  }
  if (entry.service) {
    rows.push({ key: "service", label: "Service", value: entry.service });
  }
  rows.push({
    key: "eventType",
    label: "Event type",
    value: entry.eventType,
    words: true,
  });

  return rows;
}

/** `pretty` is the raw string unchanged when the message is not JSON. */
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

/** The region and account suffix is dead weight in a dense table. */
function shortFunctionName(name: string): string {
  return name.replace(/-ap-[a-z]+-\d+-\d{6,}$/i, "").replace(/^broods-/, "");
}

/** Where the line came from: service, else endpoint, else agent. */
function sourceLabel(entry: ObservabilityLogEntry): string {
  if (entry.service) return shortFunctionName(entry.service);
  if (entry.endpointId) return shortFunctionName(entry.endpointId);

  return entry.agentId ?? "—";
}

function LogDetails({
  entry,
}: {
  entry: ObservabilityLogEntry;
}): React.JSX.Element {
  const parsed = useMemo(() => parseLogMessage(entry.message), [entry.message]);
  const rows = detailRows(entry);

  return (
    <div className="min-w-0 divide-y divide-border/40 rounded-md bg-card/30">
      <DetailPayload
        label="Message"
        summary={`${parsed.pretty.length.toLocaleString()} chars`}
        value={parsed.pretty}
      />
      <DetailFields
        label="Details"
        rows={rows}
        summary={`${rows.length} fields`}
      />
    </div>
  );
}

function LogRow({
  entry,
  isSelected,
  onSelect,
}: {
  entry: ObservabilityLogEntry;
  isSelected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const parsed = useMemo(() => parseLogMessage(entry.message), [entry.message]);
  const eventType = parsed.eventType ?? entry.eventType;

  return (
    <tr
      onClick={onSelect}
      className={cn(
        "cursor-pointer border-b border-border/40 transition-colors hover:bg-accent/20",
        isSelected && "bg-accent/30",
      )}
    >
      <td className="px-3 py-1.5 font-mono whitespace-nowrap tabular-nums text-muted-foreground">
        {formatDateTimeMillis(entry.ts)}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={LEVEL_TONE[entry.level]} />
          {entry.level.toLowerCase()}
        </span>
      </td>
      <td
        className="px-3 py-1.5 whitespace-nowrap truncate text-muted-foreground"
        title={entry.endpointId}
      >
        {sourceLabel(entry)}
      </td>
      <td className="px-3 py-1.5 max-w-0 truncate text-foreground/90">
        {parsed.summary}
        {eventType && (
          <span className="ml-1.5 text-muted-foreground">{eventType}</span>
        )}
      </td>
    </tr>
  );
}
