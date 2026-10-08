"use client";

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  DataTableSub,
} from "@/app/components/DataTable";
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { EmptyState } from "@/app/components/EmptyState";
import { SearchInput } from "@/app/components/SearchInput";
import { StatusDot, type StatusTone } from "@/app/components/StatusDot";
import { Toolbar, ToolbarCount } from "@/app/components/Toolbar";
import { Button } from "@/app/components/ui/button";
import { Switch } from "@/app/components/ui/switch";
import { useNow } from "@/app/hooks/useNow";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import {
  describeSchedule,
  nextRunAt,
  untilLabel,
} from "@/app/lib/cronSchedule";
import { toErrorMessage } from "@/app/lib/errors";
import { formatDateTime } from "@/app/lib/formatTime";
import { parseQuery } from "@/app/lib/queryTokens";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { ExternalLink, Plus } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  dashboardHref,
  DetailField,
  relativeTime,
} from "../../sandbox/components/sandboxFormat";
import { CronDialog, eventsToText } from "./CronDialog";

// The `field:value` tokens the search box understands.
const CRON_QUERY_FIELDS = ["agent", "status"] as const;

// Six columns of short text; below this the detail panel would wrap them.
const CRON_TABLE_MIN_WIDTH = 640;

type Cron = FunctionReturnType<typeof api.agent.crons.listForProject>[number];
type CronRun = FunctionReturnType<
  typeof api.agent.crons.listRunsForProject
>[number];
type RunStatus = NonNullable<Cron["lastStatus"]>;

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
 * The scheduler: a search bar, the jobs with their next and last run and an
 * active switch, and a detail panel for the selected job with its prompt and
 * recent runs.
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
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<Id<"crons"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const agentNameById = useMemo(
    () => new Map(agents.map((agent) => [agent._id, agent.name])),
    [agents],
  );

  const query = useMemo(() => parseQuery(filter, CRON_QUERY_FIELDS), [filter]);
  const shown = useMemo(
    () =>
      crons.filter((cron) => {
        const fieldsPass = query.fields.every(({ field, value }) =>
          field === "agent"
            ? agentName(agentNameById, cron).toLowerCase().startsWith(value)
            : (STATUS_WORDS[value]?.(cron) ?? false),
        );
        if (!fieldsPass) return false;
        if (!query.text) return true;

        return `${cron.name} ${cron.description ?? ""}`
          .toLowerCase()
          .includes(query.text);
      }),
    [crons, query, agentNameById],
  );
  const selected = crons.find((cron) => cron._id === selectedId) ?? null;

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
          placeholder="Search jobs · agent: status:"
        />
        <ToolbarCount shown={shown.length} total={crons.length} />
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
              <DataTableHead>Name</DataTableHead>
              <DataTableHead>Agent</DataTableHead>
              <DataTableHead>Schedule</DataTableHead>
              <DataTableHead>Next run</DataTableHead>
              <DataTableHead>Last run</DataTableHead>
              <DataTableHead align="right">Active</DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {shown.map((cron) => {
              const next = nextRunAt(cron, now);

              return (
                <DataTableRow
                  key={cron._id}
                  selected={selectedId === cron._id}
                  onClick={() => setSelectedId(cron._id)}
                >
                  <DataTableCell className="max-w-64">
                    <div className="truncate font-medium text-foreground">
                      {cron.name}
                    </div>
                    {cron.description && (
                      <DataTableSub>{cron.description}</DataTableSub>
                    )}
                  </DataTableCell>
                  <DataTableCell muted>
                    {agentName(agentNameById, cron)}
                  </DataTableCell>
                  <DataTableCell>
                    <div>
                      {describeSchedule(cron.scheduleExpression, cron.timezone)}
                    </div>
                    <DataTableSub className="font-mono">
                      {cron.scheduleExpression}
                    </DataTableSub>
                  </DataTableCell>
                  <DataTableCell>
                    {next === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <>
                        <div>{untilLabel(next, now)}</div>
                        <DataTableSub>{formatDateTime(next)}</DataTableSub>
                      </>
                    )}
                  </DataTableCell>
                  <DataTableCell>
                    {cron.lastStatus ? (
                      <>
                        <span className="inline-flex items-center gap-1.5">
                          <StatusDot tone={RUN_TONE[cron.lastStatus]} />
                          {RUN_WORD[cron.lastStatus]}
                        </span>
                        <DataTableSub>
                          {relativeTime(cron.lastInvokedAt, now)}
                        </DataTableSub>
                      </>
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
              );
            })}
          </DataTableBody>
        </DataTable>
        {shown.length === 0 && (
          <EmptyState title="No jobs match the current filters." />
        )}
      </DetailSplit>
    </div>
  );
}

/** The selected job: its fields, prompt and newest runs, with edit and delete. */
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
  const next = nextRunAt(cron, now);

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
              size="xs"
              className="cursor-pointer"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="xs"
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
      <div className="rounded-md border border-border px-3">
        <DetailField
          label="Status"
          value={
            <span className="inline-flex items-center gap-1.5">
              <StatusDot tone={cron.status === "active" ? "ok" : "ended"} />
              {cron.status === "active" ? "Active" : "Paused"}
            </span>
          }
        />
        <DetailField label="Agent" value={agentName} />
        <DetailField
          label="Schedule"
          value={describeSchedule(cron.scheduleExpression, cron.timezone)}
        />
        <DetailField
          label="Expression"
          value={<span className="font-mono">{cron.scheduleExpression}</span>}
        />
        {cron.timezone && (
          <DetailField label="Timezone" value={cron.timezone} />
        )}
        <DetailField
          label="Next run"
          value={
            next === null
              ? "—"
              : `${formatDateTime(next)} (${untilLabel(next, now)})`
          }
        />
        {cron.conversationKey && (
          <DetailField
            label="Conversation"
            value={<span className="font-mono">{cron.conversationKey}</span>}
          />
        )}
      </div>

      <h4 className="mt-4 mb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        Prompt
      </h4>
      <p className="text-xs whitespace-pre-wrap text-foreground">
        {eventsToText(cron.events) || "—"}
      </p>

      <h4 className="mt-4 mb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        Runs
      </h4>
      {runs === undefined ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">No runs yet.</p>
      ) : (
        <ul className="divide-y divide-border/40">
          {runs.map((run) => (
            <RunRow key={run._id} projectId={projectId} run={run} />
          ))}
        </ul>
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

/** One run: when, how long, why it failed, and a link to its traces. */
function RunRow({
  projectId,
  run,
}: {
  projectId: Id<"projects">;
  run: CronRun;
}): React.JSX.Element {
  const searchParams = useSearchParams();
  const duration =
    run.completedAt === undefined
      ? null
      : `${Math.max(1, Math.round((run.completedAt - run.startedAt) / 1000))}s`;

  return (
    <li className="flex items-start gap-2 py-1.5 text-xs">
      <StatusDot tone={RUN_TONE[run.status]} className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <div>
          {formatDateTime(run.startedAt)}
          {duration && (
            <span className="text-muted-foreground"> · {duration}</span>
          )}
        </div>
        {run.error && (
          <div className="truncate text-destructive" title={run.error}>
            {run.error}
          </div>
        )}
      </div>
      <Button
        nativeButton={false}
        render={
          <Link
            href={dashboardHref(projectId, searchParams.get("stage"), {
              tab: "tracing",
              q: `conv:${run.conversationKey}`,
            })}
          />
        }
        variant="ghost"
        size="xs"
        tone="muted"
        className="cursor-pointer"
      >
        Traces
        <ExternalLink className="size-3" />
      </Button>
    </li>
  );
}

/** The name of the agent a job runs; a deleted agent reads as unknown. */
function agentName(names: Map<Id<"agents">, string>, cron: Cron): string {
  return names.get(cron.agentId) ?? "(unknown)";
}
