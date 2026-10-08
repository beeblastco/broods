"use client";

import { CopyTextarea } from "@/app/components/CopyTextarea";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableFooter,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  type HeadFilter,
  type HeadSort,
} from "@/app/components/DataTable";
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { EmptyState } from "@/app/components/EmptyState";
import { SearchInput } from "@/app/components/SearchInput";
import { StatusWord, type StatusTone } from "@/app/components/StatusDot";
import { FilterButton, Toolbar } from "@/app/components/Toolbar";
import { Button } from "@/app/components/ui/button";
import { Switch } from "@/app/components/ui/switch";
import { Who, type Actor } from "@/app/components/Who";
import { useNow } from "@/app/hooks/useNow";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { useRemembered } from "@/app/hooks/useRemembered";
import {
  describeSchedule,
  nextFireAt,
  untilLabel,
} from "@/app/lib/cronSchedule";
import { toErrorMessage } from "@/app/lib/errors";
import { formatDate, formatDateTime } from "@/app/lib/formatTime";
import { parseQuery } from "@/app/lib/queryTokens";
import {
  clearField,
  sortRows,
  toggleToken,
  tokenValues,
  type SortDir,
  type SortKey,
  type SortState,
} from "@/app/lib/tableState";
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
const CRON_QUERY_FIELDS = ["agent", "status", "timezone"] as const;

// Eight columns of short text; below this the detail panel would wrap them.
const CRON_TABLE_MIN_WIDTH = 760;

// A job with no zone of its own runs in UTC, so that is what the row says.
const DEFAULT_TIMEZONE = "UTC";

type Cron = FunctionReturnType<typeof api.agent.crons.listForProject>[number];
type CronRun = FunctionReturnType<
  typeof api.agent.crons.listRunsForProject
>[number];
type RunStatus = NonNullable<Cron["lastStatus"]>;
type QueryField = (typeof CRON_QUERY_FIELDS)[number];
type Column =
  | "name"
  | "description"
  | "agent"
  | "schedule"
  | "timezone"
  | "next"
  | "last"
  | "active";

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

// What a `status:` token may name: the job's own state, or its last run's.
const STATUS_WORDS: Record<string, (cron: Cron) => boolean> = {
  active: (cron) => cron.status === "active",
  paused: (cron) => cron.status === "paused",
  running: (cron) => cron.lastStatus === "started",
  ok: (cron) => cron.lastStatus === "completed",
  failed: (cron) => cron.lastStatus === "failed",
};

interface Props {
  projectId: Id<"projects">;
  crons: Cron[];
  agents: Array<Pick<Doc<"agents">, "_id" | "name">>;
  /** Opens the create dialog; absent when the viewer cannot create. */
  onCreate?: () => void;
}

/**
 * The scheduler: a search bar with sort and filter on every header, one
 * column per fact about a job, an active switch, and a detail panel for
 * the selected job with its prompt and recent runs.
 */
export function CronsTable({
  projectId,
  crons,
  agents,
  onCreate,
}: Props): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const update = useMutation(api.agent.cronsPublic.update);
  const now = useNow();
  const [filter, setFilter] = useRemembered("scheduler.filter", "");
  const [sort, setSort] = useRemembered<SortState<Column>>("scheduler.sort", {
    column: "next",
    dir: "asc",
  });
  const [selectedId, setSelectedId] = useState<Id<"crons"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const agentNameById = useMemo(
    () => new Map(agents.map((agent) => [agent._id, agent.name])),
    [agents],
  );

  const query = useMemo(() => parseQuery(filter, CRON_QUERY_FIELDS), [filter]);
  const shown = useMemo(() => {
    const matching = crons.filter((cron) => {
      const fieldsPass = query.fields.every(({ field, value }) =>
        matchesField(field, value, cron, agentNameById),
      );
      if (!fieldsPass) return false;
      if (!query.text) return true;

      return `${cron.name} ${cron.description ?? ""}`
        .toLowerCase()
        .includes(query.text);
    });

    return sortRows(
      matching,
      (cron) => sortKey(sort.column, cron, agentNameById, now),
      sort.dir,
    );
  }, [crons, query, agentNameById, sort, now]);
  const selected = crons.find((cron) => cron._id === selectedId) ?? null;
  const activeCount = crons.filter((cron) => cron.status === "active").length;

  const sortFor = (column: Column): HeadSort => ({
    dir: sort.column === column ? sort.dir : null,
    onSort: (dir: SortDir) => setSort({ column: column, dir: dir }),
  });
  const filterFor = (field: QueryField, values: string[]): HeadFilter => ({
    field: field,
    values: values.map((value) => ({ value: value, label: value })),
    active: tokenValues(filter, field),
    onToggle: (value) => setFilter(toggleToken(filter, field, value)),
    onClear: () => setFilter(clearField(filter, field)),
  });
  const filters = {
    agent: filterFor(
      "agent",
      [...new Set(crons.map((cron) => agentName(agentNameById, cron)))].map(
        (name) => name.toLowerCase(),
      ),
    ),
    status: filterFor("status", Object.keys(STATUS_WORDS)),
    timezone: filterFor(
      "timezone",
      [...new Set(crons.map((cron) => zoneOf(cron)))].map((zone) =>
        zone.toLowerCase(),
      ),
    ),
  };

  const setActive = async (cron: Cron, active: boolean): Promise<void> => {
    setError(null);
    try {
      await update({
        cronId: cron._id,
        status: active ? "active" : "paused",
      });
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar className="border-b-0 px-0">
        <SearchInput
          value={filter}
          onChange={setFilter}
          fields={CRON_QUERY_FIELDS}
          placeholder="Search jobs"
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
            New cron job
          </Button>
        )}
      </Toolbar>
      {error && <p className="pb-2 text-xs text-destructive">{error}</p>}

      <DetailSplit
        tableMinWidth={CRON_TABLE_MIN_WIDTH}
        detail={
          selected && (
            <CronPanel
              projectId={projectId}
              cron={selected}
              agents={agents}
              agentName={agentName(agentNameById, selected)}
              now={now}
              onClose={() => setSelectedId(null)}
            />
          )
        }
      >
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead sort={sortFor("name")}>Name</DataTableHead>
              <DataTableHead sort={sortFor("description")}>
                Description
              </DataTableHead>
              <DataTableHead sort={sortFor("agent")} filter={filters.agent}>
                Agent
              </DataTableHead>
              <DataTableHead sort={sortFor("schedule")}>Schedule</DataTableHead>
              <DataTableHead
                sort={sortFor("timezone")}
                filter={filters.timezone}
              >
                Timezone
              </DataTableHead>
              <DataTableHead sort={{ ...sortFor("next"), words: TIME_WORDS }}>
                Next run
              </DataTableHead>
              <DataTableHead
                sort={{ ...sortFor("last"), words: TIME_WORDS }}
                filter={filters.status}
              >
                Last run
              </DataTableHead>
              <DataTableHead align="right" sort={sortFor("active")}>
                Active
              </DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {shown.map((cron) => (
              <DataTableRow
                key={cron._id}
                selected={selectedId === cron._id}
                onClick={() => setSelectedId(cron._id)}
              >
                <DataTableCell className="max-w-56 truncate font-medium">
                  {cron.name}
                </DataTableCell>
                <DataTableCell
                  muted
                  className="max-w-72 truncate"
                  title={cron.description}
                >
                  {cron.description || "—"}
                </DataTableCell>
                <DataTableCell>
                  <Who
                    actor={agentActor(agentNameById, cron)}
                    projectId={projectId}
                  />
                </DataTableCell>
                <DataTableCell>
                  {describeSchedule(cron.scheduleExpression, cron.timezone)}
                </DataTableCell>
                <DataTableCell>{zoneOf(cron)}</DataTableCell>
                <DataTableCell>
                  <NextRun cron={cron} now={now} />
                </DataTableCell>
                <DataTableCell>
                  {cron.lastStatus ? (
                    <span className="inline-flex items-center gap-2">
                      <StatusWord tone={RUN_TONE[cron.lastStatus]}>
                        {RUN_WORD[cron.lastStatus]}
                      </StatusWord>
                      <span className="text-muted-foreground">
                        {relativeTime(cron.lastInvokedAt, now)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">never</span>
                  )}
                </DataTableCell>
                <DataTableCell
                  align="right"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Switch
                    checked={cron.status === "active"}
                    disabled={!canWrite}
                    aria-label={`${cron.name} active`}
                    onCheckedChange={(checked) => setActive(cron, checked)}
                  />
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        {shown.length === 0 && (
          <EmptyState title="No jobs match the current filters." />
        )}
        <DataTableFooter>
          {shown.length === crons.length
            ? `${crons.length} jobs, ${activeCount} active`
            : `${shown.length} of ${crons.length} jobs, ${activeCount} active`}
        </DataTableFooter>
      </DetailSplit>
    </div>
  );
}

// Sort words for the two time columns.
const TIME_WORDS: [string, string] = ["Soonest first", "Latest first"];

/** When the job fires next; a paused job still says when it would. */
function NextRun({
  cron,
  now,
}: {
  cron: Cron;
  now: number;
}): React.JSX.Element {
  const next = nextFireAt(cron, now);
  if (next === null) {
    return <span className="text-muted-foreground">fired</span>;
  }
  if (cron.status !== "active") {
    return (
      <span>
        {formatDateTime(next)}{" "}
        <span className="text-muted-foreground">paused</span>
      </span>
    );
  }

  return <span title={formatDateTime(next)}>{untilLabel(next, now)}</span>;
}

/** The selected job: every fact as a row, the prompt, and its newest runs. */
function CronPanel({
  projectId,
  cron,
  agents,
  agentName,
  now,
  onClose,
}: {
  projectId: Id<"projects">;
  cron: Cron;
  agents: Props["agents"];
  agentName: string;
  now: number;
  onClose: () => void;
}): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const remove = useMutation(api.agent.cronsPublic.remove);
  const runs = useQuery(api.agent.crons.listRunsForProject, {
    projectId: projectId,
    cronId: cron._id,
  });
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pending, setPending] = useState(false);
  const next = nextFireAt(cron, now);

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
      meta={
        canWrite && (
          <div className="mt-1 flex gap-1">
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              tone="muted-destructive"
              className="cursor-pointer"
              onClick={() => setDeleting(true)}
            >
              Delete
            </Button>
          </div>
        )
      }
      onClose={onClose}
    >
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs">
        <Field label="Status">
          <StatusWord tone={cron.status === "active" ? "ok" : "ended"}>
            {cron.status === "active" ? "Active" : "Paused"}
          </StatusWord>
        </Field>
        <Field label="Agent">
          <Who
            actor={{ kind: "agent", name: agentName, agentId: cron.agentId }}
            projectId={projectId}
          />
        </Field>
        <Field label="Schedule">
          {describeSchedule(cron.scheduleExpression, cron.timezone)}
        </Field>
        <Field label="Expression">
          <span className="font-mono">{cron.scheduleExpression}</span>
        </Field>
        <Field label="Timezone">{zoneOf(cron)}</Field>
        <Field label="Next run">
          {next === null
            ? "fired"
            : cron.status === "active"
              ? `${formatDateTime(next)} (${untilLabel(next, now)})`
              : `${formatDateTime(next)} paused`}
        </Field>
        <Field label="Last run">
          {cron.lastStatus && cron.lastInvokedAt ? (
            <span className="inline-flex items-center gap-2">
              <StatusWord tone={RUN_TONE[cron.lastStatus]}>
                {RUN_WORD[cron.lastStatus]}
              </StatusWord>
              {formatDateTime(cron.lastInvokedAt)}
            </span>
          ) : (
            "never"
          )}
        </Field>
        <Field label="Conversation key">
          {cron.conversationKey ? (
            <span className="font-mono">{cron.conversationKey}</span>
          ) : (
            <span className="text-muted-foreground">none</span>
          )}
        </Field>
        <Field label="Created by">
          {cron.creator ? (
            <Who actor={{ kind: "person", ...cron.creator }} />
          ) : (
            <span className="text-muted-foreground">API</span>
          )}
        </Field>
        <Field label="Created at">{formatDate(cron.createdAt)}</Field>
      </dl>
      <p className="mt-2 text-2xs text-muted-foreground">
        Runs share this conversation. Empty means each run starts fresh.
      </p>

      <h4 className="mt-4 mb-1.5 text-xs font-semibold">Prompt</h4>
      <CopyTextarea value={eventsToText(cron.events)} label="prompt" />

      <h4 className="mt-4 mb-1.5 text-xs font-semibold">Runs</h4>
      {runs === undefined ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">No runs yet.</p>
      ) : (
        <RunsTable projectId={projectId} runs={runs} />
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
          resourceType="cron job"
          critical={false}
          onConfirm={handleDelete}
          isDeleting={pending}
        />
      )}
    </DetailPanel>
  );
}

/** One label and value row of the panel. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-foreground">{children}</dd>
    </>
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
      <DataTableHeader className="static">
        <tr>
          <DataTableHead>Started</DataTableHead>
          <DataTableHead>Status</DataTableHead>
          <DataTableHead>Duration</DataTableHead>
          <DataTableHead align="right" />
        </tr>
      </DataTableHeader>
      <DataTableBody>
        {runs.map((run) => {
          const duration =
            run.completedAt === undefined
              ? "—"
              : `${Math.max(1, Math.round((run.completedAt - run.startedAt) / 1000))}s`;

          return (
            <DataTableRow key={run._id}>
              <DataTableCell>
                {formatDateTime(run.startedAt)}
                {run.error && (
                  <div
                    className="max-w-56 truncate text-2xs text-muted-foreground"
                    title={run.error}
                  >
                    {run.error}
                  </div>
                )}
              </DataTableCell>
              <DataTableCell>
                <StatusWord tone={RUN_TONE[run.status]}>
                  {RUN_WORD[run.status]}
                </StatusWord>
              </DataTableCell>
              <DataTableCell muted>{duration}</DataTableCell>
              <DataTableCell align="right">
                <Link
                  href={dashboardHref(projectId, stage, {
                    tab: "tracing",
                    q: `conv:${run.conversationKey}`,
                  })}
                  className="cursor-pointer text-foreground underline-offset-3 hover:underline"
                >
                  Traces
                </Link>
              </DataTableCell>
            </DataTableRow>
          );
        })}
      </DataTableBody>
    </DataTable>
  );
}

/** Whether a `field:value` token matches the job. */
function matchesField(
  field: QueryField,
  value: string,
  cron: Cron,
  names: Map<Id<"agents">, string>,
): boolean {
  if (field === "agent") {
    return agentName(names, cron).toLowerCase().startsWith(value);
  }
  if (field === "timezone") return zoneOf(cron).toLowerCase() === value;

  return STATUS_WORDS[value]?.(cron) ?? false;
}

/** What a column sorts a job by. */
function sortKey(
  column: Column,
  cron: Cron,
  names: Map<Id<"agents">, string>,
  now: number,
): SortKey {
  switch (column) {
    case "name":
      return cron.name;
    case "description":
      return cron.description ?? null;
    case "agent":
      return agentName(names, cron);
    case "schedule":
      return describeSchedule(cron.scheduleExpression, cron.timezone);
    case "timezone":
      return zoneOf(cron);
    case "next":
      return nextFireAt(cron, now);
    case "last":
      return cron.lastInvokedAt ?? null;
    case "active":
      return cron.status === "active" ? 1 : 0;
  }
}

/** The name of the agent a job runs; a deleted agent reads as unknown. */
function agentName(names: Map<Id<"agents">, string>, cron: Cron): string {
  return names.get(cron.agentId) ?? "(unknown)";
}

function agentActor(names: Map<Id<"agents">, string>, cron: Cron): Actor {
  return { kind: "agent", name: agentName(names, cron), agentId: cron.agentId };
}

function zoneOf(cron: Cron): string {
  return cron.timezone ?? DEFAULT_TIMEZONE;
}
