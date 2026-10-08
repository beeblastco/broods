"use client";

import { CopyButton } from "@/app/components/CopyButton";
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
import { LoadMore } from "@/app/components/LoadMore";
import { useNow } from "@/app/hooks/useNow";
import { formatDateTimeMillis } from "@/app/lib/formatTime";
import {
  effectiveWindow,
  parseQuery,
  type Query,
  type RangePreset,
  type TimeWindow,
} from "@/app/lib/queryTokens";
import { cn } from "@/app/lib/utils";
import { ArrowUpRight } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  emptyStreamMessage,
  ObservabilityToolbar,
  type VolumePoint,
} from "./ObservabilityToolbar";

// The `field:value` tokens the search box understands, in the placeholder's order.
const LOG_QUERY_FIELDS = [
  "level",
  "source",
  "agent",
  "trace",
  "event",
] as const;

type LogQueryField = (typeof LOG_QUERY_FIELDS)[number];

// One matcher per token. Values arrive lowercased.
const QUERY_MATCHERS: Record<
  LogQueryField,
  (entry: ObservabilityLogEntry, value: string) => boolean
> = {
  agent: (entry, value) =>
    (entry.agentId ?? "").toLowerCase().startsWith(value),
  event: (entry, value) => entry.eventType.toLowerCase().includes(value),
  level: (entry, value) => entry.level.toLowerCase() === value,
  source: (entry, value) =>
    sourceLabel(entry).toLowerCase().startsWith(value) ||
    (entry.service ?? "").toLowerCase().startsWith(value) ||
    (entry.endpointId ?? "").toLowerCase().startsWith(value),
  trace: (entry, value) =>
    (entry.traceId ?? "").toLowerCase().startsWith(value),
};

const SEVERITY: Record<
  ObservabilityLogEntry["level"],
  VolumePoint["severity"]
> = {
  ERROR: "error",
  WARN: "warn",
  INFO: "none",
  DEBUG: "none",
};

const LEVEL_TONE: Record<ObservabilityLogEntry["level"], StatusTone> = {
  ERROR: "error",
  WARN: "warn",
  INFO: "ok",
  DEBUG: "ended",
};

// Rows rendered before the "Load more" pager; keeps the DOM bounded even when the
// live buffer holds thousands of entries.
const PAGE_SIZE = 100;

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
  // The backfill reaches 30 days back, so the widest preset shows all of it.
  const [range, setRange] = useState<RangePreset>("30d");
  const [timeWindow, setTimeWindow] = useState<TimeWindow | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const now = useNow();

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

  const query = useMemo(() => parseQuery(filter, LOG_QUERY_FIELDS), [filter]);
  const wantsDebug = query.fields.some(
    ({ field, value }) => field === "level" && value === "debug",
  );

  const { entries, status, history, error, refresh } = useObservabilityStream({
    stream: "logs",
    projectSlug: projectSlug,
    stageSlug: stageSlug,
    apiKey: apiKey,
    backfill: 200,
    // Debug lines stay on the server until a `level:debug` token asks for them.
    minLevel: wantsDebug ? "DEBUG" : "INFO",
  });

  // Memoized: the filtered list keys on it, and a fresh object each render
  // would rebuild the list, and everything downstream of it, every time.
  const bounds = useMemo(
    () => effectiveWindow(timeWindow, range, now),
    [timeWindow, range, now],
  );

  // The CLI line that sends a first run to this stage, shown while it has no
  // logs. AGENT stands in for the agent name; <agent> would be a shell redirect.
  const firstRunCommand = `broods run AGENT "hello"${stageSlug ? ` --stage ${stageSlug}` : ""}`;

  const filtered = useMemo(
    () =>
      entries.filter(
        (entry) =>
          entry.ts >= bounds.from &&
          entry.ts <= bounds.to &&
          matchesLogQuery(entry, query),
      ),
    [entries, query, bounds],
  );
  const points = useMemo<VolumePoint[]>(
    () =>
      entries.map((entry) => ({
        ts: entry.ts,
        severity: SEVERITY[entry.level],
      })),
    [entries],
  );

  // Reset paging whenever the filters change so "Load more" always starts from
  // the top of the current view. Render-time adjustment, not an effect.
  const filterSignature = `${filter}|${range}|${timeWindow?.from}|${timeWindow?.to}`;
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ObservabilityToolbar
        search={filter}
        onSearchChange={setFilter}
        searchPlaceholder="Search logs · level: source: agent: trace: event:"
        searchFields={LOG_QUERY_FIELDS}
        range={range}
        onRangeChange={setRange}
        window={timeWindow}
        onWindowChange={setTimeWindow}
        points={points}
        now={now}
        onRefresh={refresh}
        refreshDisabled={status === "idle"}
        refreshTitle={error ?? "Refresh logs"}
        isError={status === "error"}
      />

      <DetailSplit
        flush
        detail={
          selected && (
            <DetailPanel
              key={entryKey(selected)}
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
                  {entries.length === 0 && history === "loaded" && (
                    <div className="mt-2 flex items-center justify-center gap-1">
                      <code className="font-mono text-foreground">
                        {firstRunCommand}
                      </code>
                      <CopyButton value={firstRunCommand} label="command" />
                      <span>Replace AGENT with your agent&apos;s name.</span>
                    </div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <LoadMore
          shown={filtered.length}
          total={entries.length}
          noun="lines"
          pageSize={PAGE_SIZE}
          remaining={remaining}
          onLoad={() => setVisibleCount((count) => count + PAGE_SIZE)}
        />
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

/** Whether a line passes the search box: every field token, then the free text. */
function matchesLogQuery(
  entry: ObservabilityLogEntry,
  query: Query<LogQueryField>,
): boolean {
  if (
    !query.fields.every(({ field, value }) =>
      QUERY_MATCHERS[field](entry, value),
    )
  ) {
    return false;
  }
  if (!query.text) return true;

  return (
    entry.message.toLowerCase().includes(query.text) ||
    (entry.endpointId ?? "").toLowerCase().includes(query.text) ||
    (entry.service ?? "").toLowerCase().includes(query.text) ||
    entry.eventType.toLowerCase().includes(query.text)
  );
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
