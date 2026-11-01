"use client";

import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@/app/components/DataTable";
import { DetailSplit } from "@/app/components/DetailSplit";
import { EmptyState } from "@/app/components/EmptyState";
import { LoadMore } from "@/app/components/LoadMore";
import { SearchInput } from "@/app/components/SearchInput";
import { useShortcut } from "@/app/components/ShortcutProvider";
import { StatusWord } from "@/app/components/StatusDot";
import { FilterButton, Toolbar } from "@/app/components/Toolbar";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/app/components/ui/resizable";
import { Switch } from "@/app/components/ui/switch";
import { SUSPEND_SANDBOX_PROVIDERS } from "@broods/convex/model/sandboxProviders";
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
import { useQueryState } from "nuqs";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MachinePanel } from "./MachinePanel";
import {
  closeDockSession,
  type DockState,
  openDockSession,
  openDockShell,
  pruneDock,
} from "./dockSessions";
import { SandboxDock } from "./SandboxDock";
import { SandboxInstancePanel } from "./SandboxInstancePanel";
import {
  controllable,
  dashboardHref,
  formatProvider,
  INSTANCE_TONE,
  relativeTime,
  SpecsValue,
  TraceLink,
} from "./sandboxFormat";
import type { SandboxObservabilityScope } from "./SandboxLogTail";

const QUERY_FIELDS = ["provider", "status", "agent"] as const;

const PAGE_SIZE = 50;

// Below this the detail panel would wrap the nine columns.
const TABLE_MIN_WIDTH = 840;

const REFRESH_EVERY_MS = 60_000;

const DOCK_DEFAULT_HEIGHT = 300;
const DOCK_MIN_HEIGHT = 160;

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
  machines: MachineConnection[];
  agents: Agent[];
  snapshots: Doc<"sandboxSnapshots">[];
  projectId: Id<"projects">;
  observability: SandboxObservabilityScope | null;
}

export function SandboxInstancesTable({
  instances,
  machines,
  agents,
  snapshots,
  projectId,
  observability,
}: Props): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const suspend = useAction(api.sandbox.public.suspendSandbox);
  const resume = useAction(api.sandbox.public.resumeSandbox);
  const refresh = useAction(api.sandbox.public.refreshSandbox);
  const now = useNow();

  // Only the id: the open panel follows the live row, not a stale copy.
  const [selectedId, setSelectedId] = useQueryState("sel", ROW_ID);
  const [rawDock, setDock] = useState<DockState | null>(null);
  const [dockHidden, setDockHidden] = useState(false);
  const dockOpener = useRef<HTMLElement | null>(null);
  const select = (id: TableRow["id"]): void => {
    void setSelectedId(selectedId === id ? null : id);
  };
  const [confirming, setConfirming] = useState<Instance | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const lastRefresh = useRef<string | null>(null);

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
  const dock = pruneDock(rawDock, instances);
  const shellCount = (id: Id<"sandboxInstances">): number =>
    dock?.sessions.filter(
      (session) => session.instanceId === id && session.kind === "shell",
    ).length ?? 0;
  const visibleInstances = useMemo(
    () =>
      visible.flatMap((row) => (row.kind === "instance" ? [row.instance] : [])),
    [visible],
  );
  // A new visible row or a new minute each trigger one sync; null before the stage deploys.
  const refreshKey =
    observability === null
      ? null
      : [
          Math.floor(now / REFRESH_EVERY_MS),
          ...visibleInstances
            .filter(controllable)
            .map(
              (instance) =>
                `${instance.sandboxConfigId}:${instance.reservationKey}`,
            ),
        ].join("|");
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

  const showDock = (next: DockState): void => {
    if (
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
    ) {
      dockOpener.current = document.activeElement;
    }
    setDock(next);
    setDockHidden(false);
  };

  // Focus inside the dock goes back to its opener rather than dropping to the page.
  const hideDock = (): void => {
    const focusInDock =
      document.activeElement?.closest("[data-sandbox-dock]") != null;
    setDockHidden(true);
    if (focusInDock && dockOpener.current?.isConnected) {
      dockOpener.current.focus();
    }
  };

  useShortcut("sandbox.terminal", () => {
    if (dock) {
      if (dockHidden) setDockHidden(false);
      else hideDock();
    } else if (
      selected?.kind === "instance" &&
      controllable(selected.instance)
    ) {
      showDock(openDockSession(null, selected.id, "shell"));
    }
  });

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

  // Rows keep their last status when the provider does not answer: nothing to report.
  const refreshVisible = useCallback(async (): Promise<void> => {
    const targets = visibleInstances.filter(controllable);
    if (targets.length === 0) return;
    await Promise.allSettled(
      targets.map((instance) =>
        refresh({
          sandboxId: instance.sandboxConfigId,
          reservationKey: instance.reservationKey,
        }),
      ),
    );
  }, [visibleInstances, refresh]);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- provider status sync via Convex
  useEffect(() => {
    if (refreshKey === null || lastRefresh.current === refreshKey) return;
    lastRefresh.current = refreshKey;
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
      <Toolbar>
        <SearchInput
          value={list.query}
          onChange={list.setQuery}
          fields={QUERY_FIELDS}
          placeholder="Search sandboxes · provider: status: agent:"
        />
        <FilterButton
          columns={[
            { label: "Provider", filter: filters.provider },
            { label: "Status", filter: filters.status },
            { label: "Agent", filter: filters.agent },
          ]}
        />
      </Toolbar>

      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel
          minSize={DOCK_MIN_HEIGHT}
          className="flex min-h-0 flex-col"
        >
          <DetailSplit
            flush
            tableMinWidth={TABLE_MIN_WIDTH}
            detail={
              selected?.kind === "instance" ? (
                <SandboxInstancePanel
                  key={selected.id}
                  instance={selected.instance}
                  snapshots={snapshots}
                  projectId={projectId}
                  onOpenDock={(kind) =>
                    showDock(openDockSession(dock, selected.id, kind))
                  }
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
                  <DataTableHead sort={list.sortFor("name")}>
                    Name
                  </DataTableHead>
                  <DataTableHead sort={list.sortFor("status")}>
                    Status
                  </DataTableHead>
                  <DataTableHead sort={list.sortFor("provider")}>
                    Provider
                  </DataTableHead>
                  <DataTableHead sort={list.sortFor("size")}>
                    Size
                  </DataTableHead>
                  <DataTableHead sort={list.sortFor("agent")}>
                    Agent
                  </DataTableHead>
                  <DataTableHead sort={list.sortFor("lastUsed")}>
                    Last used
                  </DataTableHead>
                  <DataTableHead sort={list.sortFor("created")}>
                    Created
                  </DataTableHead>
                  <DataTableHead align="right">Terminals</DataTableHead>
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
                      onSelect={() => select(row.id)}
                    />
                  ) : (
                    <InstanceRow
                      key={row.id}
                      row={row}
                      projectId={projectId}
                      now={now}
                      selected={selectedId === row.id}
                      shells={shellCount(row.id)}
                      canToggle={canWrite && pendingId !== row.id}
                      onSelect={() => select(row.id)}
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
            {visible.length < list.shown.length && (
              <LoadMore
                shown={visible.length}
                total={list.shown.length}
                noun={["row", "rows"]}
                pageSize={PAGE_SIZE}
                remaining={list.shown.length - visible.length}
                onLoad={() => setVisibleCount((count) => count + PAGE_SIZE)}
              />
            )}
          </DetailSplit>
        </ResizablePanel>
        {dock && (
          <>
            <ResizableHandle className={dockHidden ? "hidden" : undefined} />
            <ResizablePanel
              defaultSize={DOCK_DEFAULT_HEIGHT}
              minSize={DOCK_MIN_HEIGHT}
              className={dockHidden ? "hidden" : "flex min-h-0 flex-col"}
            >
              <SandboxDock
                state={dock}
                instances={instances}
                projectId={projectId}
                observability={observability}
                onActivate={(key) => setDock({ ...dock, active: key })}
                onNewShell={(instanceId) =>
                  setDock(openDockShell(dock, instanceId))
                }
                onCloseSession={(key) => {
                  const next = closeDockSession(dock, key);
                  setDock(next);
                  if (!next && dockOpener.current?.isConnected) {
                    dockOpener.current.focus();
                  }
                }}
                onHide={hideDock}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>

      {error && !confirming && (
        <p className="px-3 py-2 text-xs text-destructive">{error}</p>
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

function InstanceRow({
  row,
  projectId,
  now,
  selected,
  shells,
  canToggle,
  onSelect,
  onToggle,
}: {
  row: Extract<TableRow, { kind: "instance" }>;
  projectId: Id<"projects">;
  now: number;
  selected: boolean;
  shells: number;
  canToggle: boolean;
  onSelect: () => void;
  onToggle: (next: boolean) => void;
}): React.JSX.Element {
  const searchParams = useSearchParams();
  const { instance, agent } = row;
  const running = instance.status === "running";
  const suspendable = SUSPEND_SANDBOX_PROVIDERS.has(instance.provider);
  const toggleable =
    canToggle &&
    suspendable &&
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
      <DataTableCell muted className="tabular-nums">
        <span className="inline-flex items-center gap-2">
          {relativeTime(instance.lastUsedAt, now)}
          {traceId && (
            <span className="opacity-0 group-hover/row:opacity-100">
              <TraceLink
                href={dashboardHref(projectId, searchParams.get("stage"), {
                  tab: "tracing",
                  trace: traceId,
                })}
              >
                Trace
              </TraceLink>
            </span>
          )}
        </span>
      </DataTableCell>
      <DataTableCell muted className="tabular-nums">
        {relativeTime(instance.createdAt, now)}
      </DataTableCell>
      <DataTableCell align="right" muted className="tabular-nums">
        {shells > 0 ? shells : "—"}
      </DataTableCell>
      <DataTableCell
        align="right"
        className={suspendable ? undefined : "cursor-help"}
        title={
          suspendable
            ? undefined
            : `${formatProvider(instance.provider)} sandboxes can't be suspended. They stop after their idle window; Terminate stops one now.`
        }
        onClick={(event) => event.stopPropagation()}
      >
        <Switch
          checked={running}
          disabled={!toggleable}
          className={toggleable ? "cursor-pointer" : "cursor-not-allowed"}
          onCheckedChange={onToggle}
          aria-label={running ? "Suspend" : "Resume"}
        />
      </DataTableCell>
    </DataTableRow>
  );
}

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
      <DataTableCell muted className="tabular-nums">
        {relativeTime(machine.lastSeenAt, now)}
      </DataTableCell>
      <DataTableCell muted className="tabular-nums">
        {relativeTime(machine.connectedAt, now)}
      </DataTableCell>
      <DataTableCell align="right" muted>
        —
      </DataTableCell>
      <DataTableCell align="right" muted>
        —
      </DataTableCell>
    </DataTableRow>
  );
}

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

function searchText(row: TableRow): string {
  if (row.kind === "machine") {
    return `${row.machine.name} ${row.machine.hostname ?? ""}`;
  }
  const instance = row.instance;

  return `${instance.name} ${instance.externalId} ${instance.conversationKey ?? ""} ${instance.lastUsedTraceId ?? ""}`;
}
