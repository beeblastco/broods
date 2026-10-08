"use client";

import { CopyTextarea } from "@/app/components/CopyTextarea";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  DataTableSub,
  TIME_WORDS,
} from "@/app/components/DataTable";
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { DetailRows, type DetailRow } from "@/app/components/DetailSections";
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { EmptyState } from "@/app/components/EmptyState";
import { SearchInput } from "@/app/components/SearchInput";
import { StatusWord, type StatusTone } from "@/app/components/StatusDot";
import { FilterButton, Toolbar } from "@/app/components/Toolbar";
import { Button } from "@/app/components/ui/button";
import { Who, type Actor } from "@/app/components/Who";
import { useListState } from "@/app/hooks/useListState";
import { useNow } from "@/app/hooks/useNow";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { useSubmit } from "@/app/hooks/useSubmit";
import {
  describeSchedule,
  nextFireAt,
  untilLabel,
} from "@/app/lib/cronSchedule";
import { formatDate, formatDateTime } from "@/app/lib/formatTime";
import type { SortKey } from "@/app/lib/tableState";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  dashboardHref,
  relativeTime,
} from "../../sandbox/components/sandboxFormat";
import { CronDialog, eventsToText } from "./CronDialog";

// The `field:value` tokens the search box understands.
const QUERY_FIELDS = ["agent", "status", "timezone"] as const;

// Six columns of short text; below this the detail panel would wrap them.
const TABLE_MIN_WIDTH = 640;

// A job with no zone of its own runs in UTC, so that is what the panel says.
const DEFAULT_TIMEZONE = "UTC";

// Sort words for the next-run column; the last-run column reads oldest and newest.
const NEXT_WORDS: [string, string] = ["Soonest first", "Latest first"];

// The tallest bar of the run histogram stops here, so its label stays readable.
const BAR_MAX_PERCENT = 70;

type Cron = FunctionReturnType<typeof api.agent.crons.listForProject>[number];
type CronRun = FunctionReturnType<
  typeof api.agent.crons.listRunsForProject
>[number];
type RunStatus = NonNullable<Cron["lastStatus"]>;
type Field = (typeof QUERY_FIELDS)[number];
type Column = "name" | "agent" | "schedule" | "status" | "next" | "last";

/** A job with the facts the list derives once per tick: its agent's name and its next fire. */
interface CronRow {
  cron: Cron;
  agentName: string;
  zone: string;
  /** When it fires next, paused or not; null once a one-shot has fired. */
  next: number | null;
}

// The last run as a word and a dot; never run reads as nothing.
const RUN_WORD: Record<RunStatus, string> = {
  started: "running",
  completed: "ok",
  failed: "failed",
};

const RUN_TONE: Record<RunStatus, StatusTone> = {
  started: "running",
  completed: "ok",
  failed: "error",
};

// One bar per run in the histogram, the color saying how it ended.
const RUN_BAR: Record<RunStatus, string> = {
  started: "bg-info/70",
  completed: "bg-muted",
  failed: "bg-destructive/70",
};

// What a `status:` token may name: the job's own state, or its last run's.
const STATUS_WORDS: Record<string, (cron: Cron) => boolean> = {
  active: (cron) => cron.status === "active",
  paused: (cron) => cron.status === "paused",
  running: (cron) => cron.lastStatus === "started",
  ok: (cron) => cron.lastStatus === "completed",
  failed: (cron) => cron.lastStatus === "failed",
};

const SORT_KEY: Record<Column, (row: CronRow) => SortKey> = {
  name: (row) => row.cron.name,
  agent: (row) => row.agentName,
  schedule: (row) =>
    describeSchedule(row.cron.scheduleExpression, row.cron.timezone),
  status: (row) => (row.cron.status === "active" ? 0 : 1),
  next: (row) => row.next,
  last: (row) => row.cron.lastInvokedAt ?? null,
};

interface Props {
  projectId: Id<"projects">;
  crons: Cron[];
  agents: Array<Pick<Doc<"agents">, "_id" | "name">>;
  /** Opens the create dialog; absent when the viewer cannot create. */
  onCreate?: () => void;
}

/**
 * The scheduler, laid out like Monitoring: a search bar, a flush table whose
 * headers sort on click, and a detail panel for the selected job with what
 * the row does not show: its zone, prompt, run history, and the danger zone.
 */
export function CronsTable({
  projectId,
  crons,
  agents,
  onCreate,
}: Props): React.JSX.Element {
  const now = useNow();
  const [selectedId, setSelectedId] = useState<Id<"crons"> | null>(null);

  const rows = useMemo((): CronRow[] => {
    const names = new Map(agents.map((agent) => [agent._id, agent.name]));

    return crons.map((cron) => ({
      cron: cron,
      agentName: names.get(cron.agentId) ?? "(unknown)",
      zone: cron.timezone ?? DEFAULT_TIMEZONE,
      next: nextFireAt(cron, now),
    }));
  }, [crons, agents, now]);
  const list = useListState({
    rows: rows,
    fields: QUERY_FIELDS,
    initialSort: { column: "next", dir: "asc" },
    sortKey: SORT_KEY,
    matches: matchesField,
    text: searchText,
    remember: `scheduler:${projectId}`,
  });
  const selected = rows.find((row) => row.cron._id === selectedId) ?? null;
  const filters = {
    agent: list.filterFor("agent", [
      ...new Set(rows.map((row) => row.agentName.toLowerCase())),
    ]),
    status: list.filterFor("status", Object.keys(STATUS_WORDS)),
    timezone: list.filterFor("timezone", [
      ...new Set(rows.map((row) => row.zone.toLowerCase())),
    ]),
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <SearchInput
          value={list.query}
          onChange={list.setQuery}
          fields={QUERY_FIELDS}
          placeholder="Search schedulers · agent: status: timezone:"
        />
        <FilterButton
          columns={[
            { label: "Agent", filter: filters.agent },
            { label: "Status", filter: filters.status },
            { label: "Timezone", filter: filters.timezone },
          ]}
        />
        {onCreate && (
          <Button size="sm" className="cursor-pointer" onClick={onCreate}>
            <Plus className="size-4" />
            New scheduler
          </Button>
        )}
      </Toolbar>

      <DetailSplit
        flush
        tableMinWidth={TABLE_MIN_WIDTH}
        detail={
          selected && (
            <CronPanel
              projectId={projectId}
              row={selected}
              agents={agents}
              onClose={() => setSelectedId(null)}
            />
          )
        }
      >
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead plain sort={list.sortFor("name")}>
                Name
              </DataTableHead>
              <DataTableHead plain sort={list.sortFor("agent")}>
                Agent
              </DataTableHead>
              <DataTableHead plain sort={list.sortFor("schedule")}>
                Schedule
              </DataTableHead>
              <DataTableHead plain sort={list.sortFor("status")}>
                Status
              </DataTableHead>
              <DataTableHead plain sort={list.sortFor("last", TIME_WORDS)}>
                Last run
              </DataTableHead>
              <DataTableHead
                plain
                align="right"
                sort={list.sortFor("next", NEXT_WORDS)}
              >
                Next run
              </DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {list.shown.map(({ cron, agentName, next }) => (
              <DataTableRow
                key={cron._id}
                selected={selectedId === cron._id}
                onClick={() =>
                  setSelectedId(selectedId === cron._id ? null : cron._id)
                }
              >
                <DataTableCell className="max-w-64 font-medium">
                  <div className="truncate">{cron.name}</div>
                  {cron.description && (
                    <DataTableSub title={cron.description}>
                      {cron.description}
                    </DataTableSub>
                  )}
                </DataTableCell>
                <DataTableCell>
                  <Who
                    actor={{
                      kind: "agent",
                      name: agentName,
                      agentId: cron.agentId,
                    }}
                    projectId={projectId}
                  />
                </DataTableCell>
                <DataTableCell>
                  <span className="font-mono">{cron.scheduleExpression}</span>
                  <span className="ml-2.5 text-muted-foreground">
                    {describeSchedule(cron.scheduleExpression, cron.timezone)}
                  </span>
                </DataTableCell>
                <DataTableCell>
                  <StatusWord tone={cron.status === "active" ? "ok" : "ended"}>
                    {cron.status}
                  </StatusWord>
                </DataTableCell>
                <DataTableCell>
                  {cron.lastStatus ? (
                    <span className="inline-flex items-center gap-2">
                      <StatusWord tone={RUN_TONE[cron.lastStatus]}>
                        {RUN_WORD[cron.lastStatus]}
                      </StatusWord>
                      <span className="text-muted-foreground tabular-nums">
                        {relativeTime(cron.lastInvokedAt, now)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">never</span>
                  )}
                </DataTableCell>
                <DataTableCell align="right" muted className="tabular-nums">
                  <NextRun cron={cron} next={next} now={now} />
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        {list.shown.length === 0 && (
          <EmptyState title="No schedulers match the current filters." />
        )}
      </DetailSplit>
    </div>
  );
}

/** When the job fires next; a paused job still says when it would. */
function NextRun({
  cron,
  next,
  now,
}: {
  cron: Cron;
  next: number | null;
  now: number;
}): React.JSX.Element {
  if (next === null) return <span>fired</span>;
  if (cron.status !== "active") {
    return <span title={formatDateTime(next)}>paused</span>;
  }

  return <span title={formatDateTime(next)}>{untilLabel(next, now)}</span>;
}

/**
 * The selected job. Edit and Pause sit on the title line; the body holds
 * only what the row does not: zone, conversation, who made it, the prompt,
 * the run history, and the danger zone.
 */
function CronPanel({
  projectId,
  row,
  agents,
  onClose,
}: {
  projectId: Id<"projects">;
  row: CronRow;
  agents: Props["agents"];
  onClose: () => void;
}): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const update = useMutation(api.agent.cronsPublic.update);
  const remove = useMutation(api.agent.cronsPublic.remove);
  const { error, run } = useSubmit();
  const { cron, zone } = row;
  const runs = useQuery(api.agent.crons.listRunsForProject, {
    projectId: projectId,
    cronId: cron._id,
  });
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pending, setPending] = useState(false);

  const newest = runs?.[0];
  const facts: DetailRow[] = [
    { key: "timezone", label: "Timezone", value: zone, words: true },
    ...(cron.conversationKey
      ? [
          {
            key: "conversation",
            label: "Conversation",
            value: cron.conversationKey,
          },
        ]
      : []),
    {
      key: "creator",
      label: "Created by",
      value: cron.creator ? actorName(cron.creator) : "API",
      words: true,
    },
    {
      key: "created",
      label: "Created",
      value: formatDate(cron.createdAt),
      words: true,
    },
    ...(newest?.status === "failed" && newest.error
      ? [
          {
            key: "error",
            label: "Last error",
            value: newest.error,
            words: true as const,
            tone: "error" as const,
          },
        ]
      : []),
  ];

  async function handleDelete(): Promise<void> {
    setPending(true);
    try {
      await remove({ cronId: cron._id });
      onClose();
    } finally {
      setPending(false);
    }
  }

  return (
    <DetailPanel
      title={cron.name}
      actions={
        canWrite && (
          <>
            <Button
              variant="outline"
              size="sm"
              tone="muted"
              className="cursor-pointer"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              tone="muted"
              className="cursor-pointer"
              onClick={() =>
                run(() =>
                  update({
                    cronId: cron._id,
                    status: cron.status === "active" ? "paused" : "active",
                  }),
                )
              }
            >
              {cron.status === "active" ? "Pause" : "Resume"}
            </Button>
          </>
        )
      }
      onClose={onClose}
    >
      <DetailRows rows={facts} className="-mx-2" />
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      <h4 className="mt-5 mb-1.5 text-sm font-medium">Prompt</h4>
      <CopyTextarea value={eventsToText(cron.events)} label="prompt" />

      <h4 className="mt-5 mb-1.5 text-sm font-medium">Runs</h4>
      {runs === undefined ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">No runs yet.</p>
      ) : (
        <>
          <RunHistogram runs={runs} />
          <RunsTable projectId={projectId} runs={runs} />
        </>
      )}

      {canWrite && (
        <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <h4 className="text-sm font-medium text-destructive">Danger zone</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Delete the scheduler. Its past runs stay in Tracing.
          </p>
          <Button
            variant="destructive"
            size="sm"
            className="mt-3 cursor-pointer"
            onClick={() => setDeleting(true)}
          >
            Delete
          </Button>
        </div>
      )}

      {editing && (
        <CronDialog
          mode="edit"
          cron={cron}
          agents={agents}
          onClose={() => setEditing(false)}
        />
      )}
      {deleting && (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(false)}
          resourceName={cron.name}
          resourceType="scheduler"
          critical={false}
          onConfirm={handleDelete}
          isDeleting={pending}
        />
      )}
    </DetailPanel>
  );
}

/**
 * One bar per run, oldest at the left, as tall as the run was long; red
 * when it failed, sky while it still runs. The same strip Monitoring draws
 * under its toolbar, so a glance says how the job has been doing.
 */
function RunHistogram({ runs }: { runs: CronRun[] }): React.JSX.Element {
  const ordered = runs.slice().reverse();
  const max = Math.max(1, ...ordered.map(durationMs));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  return (
    <div className="relative flex h-9 shrink-0 items-end gap-px border-b border-border pt-1 select-none">
      {ordered.map((run) => (
        <span
          key={run._id}
          title={`${formatDateTime(run.startedAt)} · ${RUN_WORD[run.status]} · ${durationLabel(run)}`}
          style={{
            "--bar-height": `${(durationMs(run) / max) * BAR_MAX_PERCENT}%`,
          }}
          className={cn(
            "h-(--bar-height) min-h-px flex-1",
            RUN_BAR[run.status],
          )}
        />
      ))}
      <span className="pointer-events-none absolute top-0 right-0 font-mono text-3xs text-muted-foreground">
        {first === last
          ? formatDate(first.startedAt)
          : `${formatDate(first.startedAt)} → ${formatDate(last.startedAt)}`}
      </span>
    </div>
  );
}

/** The newest runs: when, how it ended, how long, and a link to its traces. */
function RunsTable({
  projectId,
  runs,
}: {
  projectId: Id<"projects">;
  runs: CronRun[];
}): React.JSX.Element {
  const searchParams = useSearchParams();
  const stage = searchParams.get("stage");

  return (
    <DataTable>
      <DataTableHeader className="static bg-transparent">
        <tr>
          <DataTableHead>Started</DataTableHead>
          <DataTableHead>Status</DataTableHead>
          <DataTableHead align="right">Duration</DataTableHead>
          <DataTableHead align="right" />
        </tr>
      </DataTableHeader>
      <DataTableBody>
        {runs.map((run) => (
          <DataTableRow key={run._id}>
            <DataTableCell className="font-mono tabular-nums" muted>
              {formatDateTime(run.startedAt)}
            </DataTableCell>
            <DataTableCell title={run.error}>
              <StatusWord tone={RUN_TONE[run.status]}>
                {RUN_WORD[run.status]}
              </StatusWord>
            </DataTableCell>
            <DataTableCell align="right" muted className="tabular-nums">
              {durationLabel(run)}
            </DataTableCell>
            <DataTableCell align="right">
              <Link
                href={dashboardHref(projectId, stage, {
                  tab: "tracing",
                  q: `conv:${run.conversationKey}`,
                })}
                className="cursor-pointer text-foreground underline-offset-3 hover:underline"
              >
                Trace
              </Link>
            </DataTableCell>
          </DataTableRow>
        ))}
      </DataTableBody>
    </DataTable>
  );
}

/** The name a Created by row shows for whoever made the job. */
function actorName(actor: Actor): string {
  if ("kind" in actor && actor.kind === "platform") return "Broods";

  return actor.name;
}

/** How long a run took, or how long it has been running. */
function durationMs(run: CronRun): number {
  return Math.max(0, (run.completedAt ?? Date.now()) - run.startedAt);
}

function durationLabel(run: CronRun): string {
  if (run.completedAt === undefined) return "—";

  return `${Math.max(1, Math.round((run.completedAt - run.startedAt) / 1000))}s`;
}

/** Whether a `field:value` token matches the job. */
function matchesField(row: CronRow, field: Field, value: string): boolean {
  if (field === "agent") return row.agentName.toLowerCase().startsWith(value);
  if (field === "timezone") return row.zone.toLowerCase() === value;

  return STATUS_WORDS[value]?.(row.cron) ?? false;
}

function searchText(row: CronRow): string {
  return `${row.cron.name} ${row.cron.description ?? ""} ${row.cron.scheduleExpression}`;
}
