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
import { useObservabilityView } from "@/app/hooks/useObservabilityView";
import { formatDateTimeMillis } from "@/app/lib/formatTime";
import { tabHref } from "@/app/lib/navigation";
import { effectiveWindow, parseQuery, type Query } from "@/app/lib/queryTokens";
import { LOG_VIEW } from "@/app/lib/urlState";
import { cn } from "@/app/lib/utils";
import { ArrowUpRight } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { memo, useMemo, useState } from "react";
import {
  emptyStreamMessage,
  ObservabilityToolbar,
  type VolumePoint,
} from "./ObservabilityToolbar";

// In the search placeholder's order.
const LOG_QUERY_FIELDS = [
  "level",
  "source",
  "agent",
  "trace",
  "event",
] as const;

type LogQueryField = (typeof LOG_QUERY_FIELDS)[number];

// Values arrive lowercased.
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
  // A key: indices drift as logs stream in, and a refresh swaps the objects.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // A key carries no stage, so a stage switch closes the line.
  const [prevStageSlug, setPrevStageSlug] = useState(stageSlug);
  if (stageSlug !== prevStageSlug) {
    setPrevStageSlug(stageSlug);
    setSelectedKey(null);
  }
  const {
    query: filter,
    setQuery: setFilter,
    range,
    setRange,
    window: timeWindow,
    setWindow: setTimeWindow,
  } = useObservabilityView(LOG_VIEW);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const now = useNow();

  const viewTrace = (traceId: string): void =>
    router.push(
      tabHref(pathname, "tracing", searchParams.toString(), {
        trace: traceId,
      }),
    );

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
    minLevel: wantsDebug ? "DEBUG" : "INFO",
  });

  const bounds = useMemo(
    () => effectiveWindow(timeWindow, range, now),
    [timeWindow, range, now],
  );

  // AGENT, not <agent>: a pasted <agent> is a shell redirect.
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
  const selected = useMemo(
    () => filtered.find((entry) => entryKey(entry) === selectedKey) ?? null,
    [filtered, selectedKey],
  );
  const selectedSummary = useMemo(
    () => (selected ? parseLogMessage(selected.message).summary : null),
    [selected],
  );
  const points = useMemo<VolumePoint[]>(
    () =>
      entries.map((entry) => ({
        ts: entry.ts,
        severity: SEVERITY[entry.level],
      })),
    [entries],
  );

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
        marker={selected?.ts}
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
              onClose={() => setSelectedKey(null)}
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
            {visible.map((entry) => {
              const key = entryKey(entry);

              return (
                <LogRow
                  key={key}
                  entry={entry}
                  isSelected={key === selectedKey}
                  onSelect={setSelectedKey}
                />
              );
            })}
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
          noun={["line", "lines"]}
          pageSize={PAGE_SIZE}
          remaining={remaining}
          onLoad={() => setVisibleCount((count) => count + PAGE_SIZE)}
        />
      </DetailSplit>
    </div>
  );
}

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
    } catch {}
  }

  return { summary: trimmed.slice(0, 200), pretty: trimmed };
}

function shortFunctionName(name: string): string {
  return name.replace(/-ap-[a-z]+-\d+-\d{6,}$/i, "").replace(/^broods-/, "");
}

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

// The stream keeps an entry's object across flushes, so memo skips unchanged rows.
const LogRow = memo(function LogRow({
  entry,
  isSelected,
  onSelect,
}: {
  entry: ObservabilityLogEntry;
  isSelected: boolean;
  onSelect: (key: string) => void;
}): React.JSX.Element {
  const parsed = useMemo(() => parseLogMessage(entry.message), [entry.message]);
  const eventType = parsed.eventType ?? entry.eventType;

  return (
    <tr
      onClick={() => onSelect(entryKey(entry))}
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
});
