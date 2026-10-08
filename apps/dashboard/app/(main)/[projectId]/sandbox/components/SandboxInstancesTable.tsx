"use client";

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  type HeadFilter,
  type HeadSort,
} from "@/app/components/DataTable";
import { DetailSplit } from "@/app/components/DetailSplit";
import { EmptyState } from "@/app/components/EmptyState";
import { LoadMore } from "@/app/components/LoadMore";
import { SearchInput } from "@/app/components/SearchInput";
import { StatusWord } from "@/app/components/StatusDot";
import { FilterButton, Toolbar } from "@/app/components/Toolbar";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Switch } from "@/app/components/ui/switch";
import { Who } from "@/app/components/Who";
import { useNow } from "@/app/hooks/useNow";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { useRemembered } from "@/app/hooks/useRemembered";
import { toErrorMessage } from "@/app/lib/errors";
import {
  MACHINE_STATE_LABEL,
  MACHINE_TONE,
  machineState,
  type MachineConnection,
} from "@/app/lib/machineConnection";
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
import { useAction } from "convex/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MachinePanel } from "./MachinePanel";
import { SandboxInstancePanel } from "./SandboxInstancePanel";
import {
  dashboardHref,
  formatProvider,
  INSTANCE_TONE,
  relativeTime,
  SpecsValue,
} from "./sandboxFormat";
import type { SandboxObservabilityScope } from "./SandboxLogTail";

// The `field:value` tokens the search box understands.
const QUERY_FIELDS = ["provider", "status", "agent"] as const;

// Rows shown before the footer offers more; the live query holds them all.
const PAGE_SIZE = 50;

// Eight columns of short text; below this the detail panel would wrap them.
const TABLE_MIN_WIDTH = 760;

type Instance = Doc<"sandboxInstances">;
type QueryField = (typeof QUERY_FIELDS)[number];
type Column =
  | "name"
  | "status"
  | "provider"
  | "size"
  | "agent"
  | "lastUsed"
  | "created"
  | "running";

/** One row of the table: a connected computer, or a cloud instance. */
type TableRow =
  | { kind: "machine"; machine: MachineConnection }
  | { kind: "instance"; instance: Instance };

interface Props {
  instances: Instance[];
  /** The stage's computers that connected through `broods machine`. */
  machines: MachineConnection[];
  /** The project's agents, so an instance's agent reads as a name. */
  agents: Array<Pick<Doc<"agents">, "_id" | "name">>;
  /** Builds the trace deep links. */
  projectId: Id<"projects">;
  /** Stage-scoped observability WS inputs, handed to the panel's Logs tab. */
  observability: SandboxObservabilityScope | null;
}

/**
 * The stage's sandboxes and computers as one list: a search box with sort
 * and filter on every header, one column per fact, a running switch, and a
 * detail panel for the selected row.
 */
export function SandboxInstancesTable({
  instances,
  machines,
  agents,
  projectId,
  observability,
}: Props): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const suspend = useAction(api.sandbox.public.suspendSandbox);
  const resume = useAction(api.sandbox.public.resumeSandbox);
  const refresh = useAction(api.sandbox.public.refreshSandbox);
  const now = useNow();

  // Only the id is held, so the open panel follows the live row instead of a
  // stale copy once a refresh or suspend moves its status.
  const [selectedId, setSelectedId] = useState<Id<"sandboxInstances"> | null>(
    null,
  );
  const selected = instances.find((instance) => instance._id === selectedId);
  const [selectedMachineId, setSelectedMachineId] =
    useState<Id<"machineConnections"> | null>(null);
  const selectedMachine = machines.find(
    (machine) => machine._id === selectedMachineId,
  );
  const [confirming, setConfirming] = useState<Instance | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useRemembered("sandbox.filter", "");
  const [sort, setSort] = useRemembered<SortState<Column>>("sandbox.sort", {
    column: "lastUsed",
    dir: "desc",
  });
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const refreshedPages = useRef(new Set<string>());

  const agentNameById = useMemo(
    () => new Map(agents.map((agent) => [agent._id as string, agent.name])),
    [agents],
  );
  const query = useMemo(() => parseQuery(filter, QUERY_FIELDS), [filter]);

  // Computers and instances filter and sort as one list, so the count under
  // the table matches what is on screen.
  const rows = useMemo((): TableRow[] => {
    const all: TableRow[] = [
      ...machines.map((machine): TableRow => ({
        kind: "machine",
        machine: machine,
      })),
      ...instances.map((instance): TableRow => ({
        kind: "instance",
        instance: instance,
      })),
    ];
    const matching = all.filter((row) => {
      const fieldsPass = query.fields.every(({ field, value }) =>
        matchesField(field, value, row, agentNameById, now),
      );
      if (!fieldsPass) return false;
      if (!query.text) return true;

      return searchText(row).includes(query.text);
    });

    return sortRows(
      matching,
      (row) => sortKey(sort.column, row, agentNameById, now),
      sort.dir,
    );
  }, [machines, instances, query, sort, agentNameById, now]);
  const visible = rows.slice(0, visibleCount);
  const visibleInstances = useMemo(
    () =>
      visible.flatMap((row) => (row.kind === "instance" ? [row.instance] : [])),
    [visible],
  );
  const refreshKey = visibleInstances
    .filter(controllable)
    .map((instance) => `${instance.sandboxConfigId}:${instance.reservationKey}`)
    .join("|");

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
    provider: filterFor("provider", [
      ...new Set([
        ...(machines.length > 0 ? [formatProvider("machine")] : []),
        ...instances.map((instance) => formatProvider(instance.provider)),
      ]),
    ]),
    status: filterFor("status", [
      ...new Set([
        ...machines.map((machine) =>
          MACHINE_STATE_LABEL[machineState(machine, now)].toLowerCase(),
        ),
        ...instances.map((instance) => instance.status),
      ]),
    ]),
    agent: filterFor("agent", [
      ...new Set(
        instances.flatMap((instance) =>
          instance.agentId
            ? [agentName(agentNameById, instance.agentId).toLowerCase()]
            : [],
        ),
      ),
    ]),
  };

  // Resuming is cheap and reversible, so it runs straight from the toggle; suspending
  // discards the instance's live state and goes through `confirming` first.
  async function toggle(
    instance: Instance,
    nextRunning: boolean,
  ): Promise<void> {
    if (!controllable(instance)) return;
    setPendingId(instance._id);
    setError(null);
    try {
      const args = {
        sandboxId: instance.sandboxConfigId,
        reservationKey: instance.reservationKey,
      };
      await (nextRunning ? resume(args) : suspend(args));
      setConfirming(null);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setPendingId(null);
    }
  }

  const refreshVisible = useCallback(async (): Promise<void> => {
    const targets = visibleInstances.filter(controllable);
    if (targets.length === 0) return;
    setRefreshing(true);
    setError(null);
    try {
      await Promise.all(
        targets.map((instance) =>
          refresh({
            sandboxId: instance.sandboxConfigId,
            reservationKey: instance.reservationKey,
          }),
        ),
      );
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setRefreshing(false);
    }
  }, [visibleInstances, refresh]);

  useEffect(() => {
    if (!refreshKey || refreshedPages.current.has(refreshKey)) return;
    refreshedPages.current.add(refreshKey);
    void refreshVisible();
  }, [refreshKey, refreshVisible]);

  if (instances.length === 0 && machines.length === 0) {
    return (
      <EmptyState
        title="No running sandbox instances."
        detail="Run an agent against a sandbox and it appears here. A computer running broods machine shows up here too."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar className="border-b-0 px-0">
        <SearchInput
          value={filter}
          onChange={setFilter}
          fields={QUERY_FIELDS}
          placeholder="Search sandboxes"
        />
        <FilterButton
          columns={[
            { label: "Provider", filter: filters.provider },
            { label: "Status", filter: filters.status },
            { label: "Agent", filter: filters.agent },
          ]}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          tone="muted"
          onClick={refreshVisible}
          disabled={refreshing || !visibleInstances.some(controllable)}
          className="cursor-pointer"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </Toolbar>

      <DetailSplit
        tableMinWidth={TABLE_MIN_WIDTH}
        detail={
          selected ? (
            <SandboxInstancePanel
              key={selected._id}
              instance={selected}
              projectId={projectId}
              observability={observability}
              now={now}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            selectedMachine && (
              <MachinePanel
                key={selectedMachine._id}
                machine={selectedMachine}
                now={now}
                onClose={() => setSelectedMachineId(null)}
              />
            )
          )
        }
      >
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead sort={sortFor("name")}>Name</DataTableHead>
              <DataTableHead sort={sortFor("status")} filter={filters.status}>
                Status
              </DataTableHead>
              <DataTableHead
                sort={sortFor("provider")}
                filter={filters.provider}
              >
                Provider
              </DataTableHead>
              <DataTableHead sort={sortFor("size")}>Size</DataTableHead>
              <DataTableHead sort={sortFor("agent")} filter={filters.agent}>
                Agent
              </DataTableHead>
              <DataTableHead
                sort={{ ...sortFor("lastUsed"), words: TIME_WORDS }}
              >
                Last used
              </DataTableHead>
              <DataTableHead
                sort={{ ...sortFor("created"), words: TIME_WORDS }}
              >
                Created
              </DataTableHead>
              <DataTableHead align="right" sort={sortFor("running")}>
                Running
              </DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {visible.map((row) =>
              row.kind === "machine" ? (
                <MachineRow
                  key={row.machine._id}
                  machine={row.machine}
                  now={now}
                  selected={selectedMachineId === row.machine._id}
                  onSelect={() => {
                    setSelectedId(null);
                    setSelectedMachineId(row.machine._id);
                  }}
                />
              ) : (
                <InstanceRow
                  key={row.instance._id}
                  instance={row.instance}
                  agentNameById={agentNameById}
                  projectId={projectId}
                  now={now}
                  selected={selectedId === row.instance._id}
                  canToggle={canWrite && pendingId !== row.instance._id}
                  onSelect={() => {
                    setSelectedMachineId(null);
                    setSelectedId(row.instance._id);
                  }}
                  onToggle={(next) =>
                    next
                      ? toggle(row.instance, true)
                      : setConfirming(row.instance)
                  }
                />
              ),
            )}
          </DataTableBody>
        </DataTable>
        {rows.length === 0 && (
          <EmptyState title="Nothing matches the current filters." />
        )}
        <LoadMore
          shown={visible.length}
          total={rows.length}
          pageSize={PAGE_SIZE}
          remaining={rows.length - visible.length}
          onLoad={() => setVisibleCount((count) => count + PAGE_SIZE)}
        />
      </DetailSplit>

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && pendingId === null) setConfirming(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Suspend {confirming?.name}?</DialogTitle>
            <DialogDescription>
              Suspending frees the sandbox&apos;s compute. Running processes
              stop, anything in flight on it is dropped, and it comes back
              reset. Files on the workspace disk are kept.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              className="cursor-pointer"
              disabled={pendingId !== null}
              onClick={() => setConfirming(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="cursor-pointer"
              disabled={pendingId !== null}
              onClick={() => confirming && toggle(confirming, false)}
            >
              {pendingId === confirming?._id ? "Suspending…" : "Suspend"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Sort words for the two time columns.
const TIME_WORDS: [string, string] = ["Oldest first", "Newest first"];

/** A cloud instance: its facts, a trace link on hover, and the running switch. */
function InstanceRow({
  instance,
  agentNameById,
  projectId,
  now,
  selected,
  canToggle,
  onSelect,
  onToggle,
}: {
  instance: Instance;
  agentNameById: Map<string, string>;
  projectId: Id<"projects">;
  now: number;
  selected: boolean;
  canToggle: boolean;
  onSelect: () => void;
  onToggle: (next: boolean) => void;
}): React.JSX.Element {
  const searchParams = useSearchParams();
  const running = instance.status === "running";
  const toggleable =
    canToggle &&
    controllable(instance) &&
    (instance.status === "running" || instance.status === "suspended");
  const traceId = instance.lastUsedTraceId ?? instance.createdByTraceId;

  return (
    <DataTableRow selected={selected} onClick={onSelect} className="group/row">
      <DataTableCell className="max-w-56 truncate font-medium">
        {instance.name}
      </DataTableCell>
      <DataTableCell>
        <StatusWord tone={INSTANCE_TONE[instance.status]}>
          {instance.status}
        </StatusWord>
        {instance.errorMessage && (
          <div
            className="max-w-56 truncate text-2xs text-muted-foreground"
            title={instance.errorMessage}
          >
            {instance.errorMessage}
          </div>
        )}
      </DataTableCell>
      <DataTableCell>
        {formatProvider(instance.provider)}
        {instance.ephemeral && (
          <span className="text-muted-foreground"> per call</span>
        )}
      </DataTableCell>
      <DataTableCell muted>
        <SpecsValue
          specs={instance.specs}
          verified={instance.specsVerified === true}
          provider={instance.provider}
        />
      </DataTableCell>
      <DataTableCell>
        {instance.agentId ? (
          <Who
            actor={{
              kind: "agent",
              name: agentName(agentNameById, instance.agentId),
              agentId: instance.agentId as Id<"agents">,
            }}
            projectId={projectId}
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </DataTableCell>
      <DataTableCell muted>
        <span className="inline-flex items-center gap-2">
          {relativeTime(instance.lastUsedAt, now)}
          {traceId && (
            <span className="opacity-0 group-hover/row:opacity-100">
              <Link
                href={dashboardHref(projectId, searchParams.get("stage"), {
                  tab: "tracing",
                  trace: traceId,
                })}
                onClick={(event) => event.stopPropagation()}
                className="cursor-pointer text-foreground underline-offset-3 hover:underline"
              >
                Trace
              </Link>
            </span>
          )}
        </span>
      </DataTableCell>
      <DataTableCell muted>
        {relativeTime(instance.createdAt, now)}
      </DataTableCell>
      <DataTableCell align="right" onClick={(event) => event.stopPropagation()}>
        <Switch
          checked={running}
          disabled={!toggleable}
          className="cursor-pointer"
          onCheckedChange={onToggle}
          aria-label={running ? "Suspend" : "Resume"}
        />
      </DataTableCell>
    </DataTableRow>
  );
}

/** A computer: its reported size and when it was seen; it has no agent, trace or switch. */
function MachineRow({
  machine,
  now,
  selected,
  onSelect,
}: {
  machine: MachineConnection;
  now: number;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const state = machineState(machine, now);

  return (
    <DataTableRow selected={selected} onClick={onSelect}>
      <DataTableCell className="max-w-56 truncate font-medium">
        {machine.name}
      </DataTableCell>
      <DataTableCell>
        <StatusWord tone={MACHINE_TONE[state]}>
          {MACHINE_STATE_LABEL[state].toLowerCase()}
        </StatusWord>
      </DataTableCell>
      <DataTableCell>{formatProvider("machine")}</DataTableCell>
      <DataTableCell muted>
        <SpecsValue specs={machine.specs} verified provider="machine" />
      </DataTableCell>
      <DataTableCell muted>—</DataTableCell>
      <DataTableCell muted>
        {relativeTime(machine.lastSeenAt, now)}
      </DataTableCell>
      <DataTableCell muted>
        {relativeTime(machine.connectedAt, now)}
      </DataTableCell>
      <DataTableCell align="right" muted>
        —
      </DataTableCell>
    </DataTableRow>
  );
}

/** Lifecycle actions apply only to reserved, non-ephemeral instances. */
function controllable(
  instance: Instance,
): instance is Instance & { sandboxConfigId: Id<"sandboxConfigs"> } {
  return Boolean(instance.sandboxConfigId) && instance.ephemeral !== true;
}

/** The free text a row answers to: name, ids, conversation and trace. */
function searchText(row: TableRow): string {
  if (row.kind === "machine") {
    return `${row.machine.name} ${row.machine.hostname ?? ""}`.toLowerCase();
  }
  const instance = row.instance;

  return `${instance.name} ${instance.externalId} ${instance.conversationKey ?? ""} ${instance.lastUsedTraceId ?? ""}`.toLowerCase();
}

/** Whether a `field:value` token matches the row. A computer has no agent. */
function matchesField(
  field: QueryField,
  value: string,
  row: TableRow,
  names: Map<string, string>,
  now: number,
): boolean {
  if (field === "provider") return providerOf(row).toLowerCase() === value;
  if (field === "status") return statusOf(row, now).toLowerCase() === value;
  if (row.kind === "machine" || !row.instance.agentId) return false;

  return agentName(names, row.instance.agentId).toLowerCase() === value;
}

/** What a column sorts a row by. */
function sortKey(
  column: Column,
  row: TableRow,
  names: Map<string, string>,
  now: number,
): SortKey {
  switch (column) {
    case "name":
      return row.kind === "machine" ? row.machine.name : row.instance.name;
    case "status":
      return statusOf(row, now);
    case "provider":
      return providerOf(row);
    case "size":
      return row.kind === "machine"
        ? (row.machine.specs?.memoryMb ?? null)
        : row.instance.specs.memoryMb;
    case "agent":
      return row.kind === "instance" && row.instance.agentId
        ? agentName(names, row.instance.agentId)
        : null;
    case "lastUsed":
      return row.kind === "machine"
        ? row.machine.lastSeenAt
        : row.instance.lastUsedAt;
    case "created":
      return row.kind === "machine"
        ? row.machine.connectedAt
        : row.instance.createdAt;
    case "running":
      return row.kind === "instance" && row.instance.status === "running"
        ? 1
        : 0;
  }
}

function providerOf(row: TableRow): string {
  return row.kind === "machine"
    ? formatProvider("machine")
    : formatProvider(row.instance.provider);
}

function statusOf(row: TableRow, now: number): string {
  return row.kind === "machine"
    ? MACHINE_STATE_LABEL[machineState(row.machine, now)]
    : row.instance.status;
}

/** The name of the agent an instance ran; a deleted agent reads as unknown. */
function agentName(names: Map<string, string>, agentId: string): string {
  return names.get(agentId) ?? "(unknown)";
}
