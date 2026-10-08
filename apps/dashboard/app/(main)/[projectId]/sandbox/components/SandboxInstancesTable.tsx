"use client";

import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  TIME_WORDS,
} from "@/app/components/DataTable";
import { DetailSplit } from "@/app/components/DetailSplit";
import { EmptyState } from "@/app/components/EmptyState";
import { LoadMore } from "@/app/components/LoadMore";
import { SearchInput } from "@/app/components/SearchInput";
import { StatusWord } from "@/app/components/StatusDot";
import { FilterButton, Toolbar } from "@/app/components/Toolbar";
import { Button } from "@/app/components/ui/button";
import { Switch } from "@/app/components/ui/switch";
import { Who } from "@/app/components/Who";
import { useListState } from "@/app/hooks/useListState";
import { useNow } from "@/app/hooks/useNow";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { toErrorMessage } from "@/app/lib/errors";
import {
  MACHINE_STATE_LABEL,
  MACHINE_TONE,
  machineState,
  type MachineConnection,
  type MachineState,
} from "@/app/lib/machineConnection";
import type { SortKey } from "@/app/lib/tableState";
import { parseAsId } from "@/app/lib/urlState";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useAction } from "convex/react";
import Link from "next/link";
import { useQueryState } from "nuqs";
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

// The open row's id, in `?sel=` so a link opens it; it only picks among rows already loaded.
const ROW_ID = parseAsId<"machineConnections" | "sandboxInstances">();

type Instance = Doc<"sandboxInstances">;
type Agent = Pick<Doc<"agents">, "_id" | "name">;
type Field = (typeof QUERY_FIELDS)[number];
type Column =
  | "name"
  | "status"
  | "provider"
  | "size"
  | "agent"
  | "lastUsed"
  | "created"
  | "running";

/** One row of the table: a connected computer, or a cloud instance, with the facts the list sorts and filters by derived once. */
type TableRow =
  | {
      kind: "machine";
      id: Id<"machineConnections">;
      machine: MachineConnection;
      state: MachineState;
      status: string;
      agent: null;
    }
  | {
      kind: "instance";
      id: Id<"sandboxInstances">;
      instance: Instance;
      status: string;
      /** The agent it ran, when that agent still exists in the project. */
      agent: Agent | null;
    };

const SORT_KEY: Record<Column, (row: TableRow) => SortKey> = {
  name: (row) =>
    row.kind === "machine" ? row.machine.name : row.instance.name,
  status: (row) => row.status,
  provider: (row) => providerOf(row),
  size: (row) =>
    row.kind === "machine"
      ? (row.machine.specs?.memoryMb ?? null)
      : row.instance.specs.memoryMb,
  agent: (row) => row.agent?.name ?? null,
  lastUsed: (row) =>
    row.kind === "machine" ? row.machine.lastSeenAt : row.instance.lastUsedAt,
  created: (row) =>
    row.kind === "machine" ? row.machine.connectedAt : row.instance.createdAt,
  running: (row) =>
    row.kind === "instance" && row.instance.status === "running" ? 1 : 0,
};

interface Props {
  instances: Instance[];
  /** The stage's computers that connected through `broods machine`. */
  machines: MachineConnection[];
  /** The project's agents, so an instance's agent reads as a name. */
  agents: Agent[];
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
  const [selectedId, setSelectedId] = useQueryState("sel", ROW_ID);
  const [confirming, setConfirming] = useState<Instance | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const refreshedPages = useRef(new Set<string>());

  // Computers and instances filter and sort as one list, so the count under
  // the table matches what is on screen.
  const rows = useMemo((): TableRow[] => {
    const agentById = new Map<string, Agent>(
      agents.map((agent) => [agent._id, agent]),
    );

    return [
      ...machines.map((machine): TableRow => {
        const state = machineState(machine, now);

        return {
          kind: "machine",
          id: machine._id,
          machine: machine,
          state: state,
          status: MACHINE_STATE_LABEL[state].toLowerCase(),
          agent: null,
        };
      }),
      ...instances.map((instance): TableRow => ({
        kind: "instance",
        id: instance._id,
        instance: instance,
        status: instance.status,
        agent: instance.agentId
          ? (agentById.get(instance.agentId) ?? null)
          : null,
      })),
    ];
  }, [machines, instances, agents, now]);
  const list = useListState({
    rows: rows,
    fields: QUERY_FIELDS,
    initialSort: { column: "lastUsed", dir: "desc" },
    sortKey: SORT_KEY,
    matches: matchesField,
    text: searchText,
    remember: `sandbox:${projectId}`,
  });
  const visible = list.shown.slice(0, visibleCount);
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const visibleInstances = useMemo(
    () =>
      visible.flatMap((row) => (row.kind === "instance" ? [row.instance] : [])),
    [visible],
  );
  const refreshKey = visibleInstances
    .filter(controllable)
    .map((instance) => `${instance.sandboxConfigId}:${instance.reservationKey}`)
    .join("|");
  const filters = {
    provider: list.filterFor("provider", [
      ...new Set(rows.map((row) => providerOf(row).toLowerCase())),
    ]),
    status: list.filterFor("status", [
      ...new Set(rows.map((row) => row.status.toLowerCase())),
    ]),
    agent: list.filterFor("agent", [
      ...new Set(
        rows.flatMap((row) =>
          row.agent ? [row.agent.name.toLowerCase()] : [],
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
          value={list.query}
          onChange={list.setQuery}
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
          selected?.kind === "instance" ? (
            <SandboxInstancePanel
              key={selected.id}
              instance={selected.instance}
              projectId={projectId}
              observability={observability}
              now={now}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            selected && (
              <MachinePanel
                key={selected.id}
                machine={selected.machine}
                now={now}
                onClose={() => setSelectedId(null)}
              />
            )
          )
        }
      >
        <DataTable>
          <DataTableHeader>
            <tr>
              <DataTableHead sort={list.sortFor("name")}>Name</DataTableHead>
              <DataTableHead
                sort={list.sortFor("status")}
                filter={filters.status}
              >
                Status
              </DataTableHead>
              <DataTableHead
                sort={list.sortFor("provider")}
                filter={filters.provider}
              >
                Provider
              </DataTableHead>
              <DataTableHead sort={list.sortFor("size")}>Size</DataTableHead>
              <DataTableHead
                sort={list.sortFor("agent")}
                filter={filters.agent}
              >
                Agent
              </DataTableHead>
              <DataTableHead sort={list.sortFor("lastUsed", TIME_WORDS)}>
                Last used
              </DataTableHead>
              <DataTableHead sort={list.sortFor("created", TIME_WORDS)}>
                Created
              </DataTableHead>
              <DataTableHead align="right" sort={list.sortFor("running")}>
                Running
              </DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {visible.map((row) =>
              row.kind === "machine" ? (
                <MachineRow
                  key={row.id}
                  row={row}
                  now={now}
                  selected={selectedId === row.id}
                  onSelect={() => setSelectedId(row.id)}
                />
              ) : (
                <InstanceRow
                  key={row.id}
                  row={row}
                  projectId={projectId}
                  now={now}
                  selected={selectedId === row.id}
                  canToggle={canWrite && pendingId !== row.id}
                  onSelect={() => setSelectedId(row.id)}
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
        {list.shown.length === 0 && (
          <EmptyState title="Nothing matches the current filters." />
        )}
        <LoadMore
          shown={visible.length}
          total={list.shown.length}
          noun="sandboxes"
          pageSize={PAGE_SIZE}
          remaining={list.shown.length - visible.length}
          onLoad={() => setVisibleCount((count) => count + PAGE_SIZE)}
        />
      </DetailSplit>

      {error && !confirming && (
        <p className="mt-2 text-xs text-destructive">{error}</p>
      )}

      {confirming && (
        <ConfirmDialog
          title={`Suspend ${confirming.name}?`}
          description="Suspending frees the sandbox's compute. Running processes stop, anything in flight on it is dropped, and it comes back reset. Files on the workspace disk are kept."
          verb="Suspend"
          pending={pendingId === confirming._id}
          error={error}
          onConfirm={() => toggle(confirming, false)}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

/** A cloud instance: its facts, a trace link on hover, and the running switch. */
function InstanceRow({
  row,
  projectId,
  now,
  selected,
  canToggle,
  onSelect,
  onToggle,
}: {
  row: Extract<TableRow, { kind: "instance" }>;
  projectId: Id<"projects">;
  now: number;
  selected: boolean;
  canToggle: boolean;
  onSelect: () => void;
  onToggle: (next: boolean) => void;
}): React.JSX.Element {
  const searchParams = useSearchParams();
  const { instance, agent } = row;
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
        {agent ? (
          <Who
            actor={{ kind: "agent", name: agent.name, agentId: agent._id }}
            projectId={projectId}
          />
        ) : (
          <span className="text-muted-foreground">
            {instance.agentId ? "(unknown)" : "—"}
          </span>
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
  row,
  now,
  selected,
  onSelect,
}: {
  row: Extract<TableRow, { kind: "machine" }>;
  now: number;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const { machine, state } = row;

  return (
    <DataTableRow selected={selected} onClick={onSelect}>
      <DataTableCell className="max-w-56 truncate font-medium">
        {machine.name}
      </DataTableCell>
      <DataTableCell>
        <StatusWord tone={MACHINE_TONE[state]}>{row.status}</StatusWord>
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

/** Whether a `field:value` token matches the row. A computer has no agent. */
function matchesField(row: TableRow, field: Field, value: string): boolean {
  if (field === "provider") return providerOf(row).toLowerCase() === value;
  if (field === "status") return row.status.toLowerCase() === value;

  return row.agent?.name.toLowerCase() === value;
}

function providerOf(row: TableRow): string {
  return row.kind === "machine"
    ? formatProvider("machine")
    : formatProvider(row.instance.provider);
}

/** The free text a row answers to: name, ids, conversation and trace. */
function searchText(row: TableRow): string {
  if (row.kind === "machine") {
    return `${row.machine.name} ${row.machine.hostname ?? ""}`;
  }
  const instance = row.instance;

  return `${instance.name} ${instance.externalId} ${instance.conversationKey ?? ""} ${instance.lastUsedTraceId ?? ""}`;
}
