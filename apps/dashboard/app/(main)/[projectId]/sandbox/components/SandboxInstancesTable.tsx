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
import { type DockTab, SandboxDock } from "./SandboxDock";
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

// The `field:value` tokens the search box understands.
const QUERY_FIELDS = ["provider", "status", "agent"] as const;

// Rows shown before the footer offers more; the live query holds them all.
const PAGE_SIZE = 50;

// Eight columns of short text; below this the detail panel would wrap them.
const TABLE_MIN_WIDTH = 760;

// How often the visible rows re-sync their status from the provider.
const REFRESH_EVERY_MS = 60_000;

// The dock's height when it opens, and the least it can be dragged to.
const DOCK_DEFAULT_HEIGHT = 300;
const DOCK_MIN_HEIGHT = 160;

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

/** The dock under the table: which instance it shows and on which tab. */
interface Dock {
  id: Id<"sandboxInstances">;
  tab: DockTab;
}

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
  /** The account's snapshots, so an instance's snapshot reads as a name. */
  snapshots: Doc<"sandboxSnapshots">[];
  /** Builds the trace deep links. */
  projectId: Id<"projects">;
  /** Stage-scoped observability WS inputs, handed to the dock's Logs tab. */
  observability: SandboxObservabilityScope | null;
}

/**
 * The stage's sandboxes and computers as one list, laid out like Monitoring:
 * a search box, a flush table whose headers sort on click, a running switch,
 * a detail panel for the selected row, and a dock under it all for the
 * selected instance's shell and logs. The visible instances refresh from the
 * provider on their own as they scroll in.
 */
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

  // Only the id is held, so the open panel follows the live row instead of a
  // stale copy once a refresh or suspend moves its status.
  const [selectedId, setSelectedId] = useQueryState("sel", ROW_ID);
  const [dock, setDock] = useState<Dock | null>(null);
  // A click on the open row closes its panel.
  const select = (id: TableRow["id"]): void => {
    void setSelectedId(selectedId === id ? null : id);
  };
  const [confirming, setConfirming] = useState<Instance | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const lastRefresh = useRef<string | null>(null);

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
  // The dock follows the live instance too, and is closed once the row is gone.
  const docked = dock
    ? instances.find((instance) => instance._id === dock.id)
    : undefined;
  const dockOpen = docked !== undefined;
  const visibleInstances = useMemo(
    () =>
      visible.flatMap((row) => (row.kind === "instance" ? [row.instance] : [])),
    [visible],
  );
  // The rows on screen plus the clock's minute, so a new row and a new
  // minute each trigger one sync. Null before the stage deploys, when no
  // instance has a provider to ask (and in the gallery fixture).
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

  // The backtick toggles the dock for the selected instance, like an
  // editor's terminal; with the dock open it closes it whatever is selected.
  useShortcut("sandbox.terminal", () => {
    if (dockOpen) {
      setDock(null);
    } else if (
      selected?.kind === "instance" &&
      controllable(selected.instance)
    ) {
      setDock({ id: selected.id, tab: "terminal" });
    }
  });

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

  // A background sync; the rows keep their last known status when the
  // provider does not answer, so a failure here has nothing to tell the user.
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

      {/* The dock opens as a second panel under the list; the list stays mounted. */}
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
                  onOpenDock={(tab) => setDock({ id: selected.id, tab: tab })}
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
                  <DataTableHead plain sort={list.sortFor("name")}>
                    Name
                  </DataTableHead>
                  <DataTableHead plain sort={list.sortFor("status")}>
                    Status
                  </DataTableHead>
                  <DataTableHead plain sort={list.sortFor("provider")}>
                    Provider
                  </DataTableHead>
                  <DataTableHead plain sort={list.sortFor("size")}>
                    Size
                  </DataTableHead>
                  <DataTableHead plain sort={list.sortFor("agent")}>
                    Agent
                  </DataTableHead>
                  <DataTableHead plain sort={list.sortFor("lastUsed")}>
                    Last used
                  </DataTableHead>
                  <DataTableHead plain sort={list.sortFor("created")}>
                    Created
                  </DataTableHead>
                  <DataTableHead
                    plain
                    align="right"
                    sort={list.sortFor("running")}
                  >
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
        {dock && dockOpen && (
          <>
            <ResizableHandle className="cursor-row-resize" />
            <ResizablePanel
              defaultSize={DOCK_DEFAULT_HEIGHT}
              minSize={DOCK_MIN_HEIGHT}
              className="flex min-h-0 flex-col"
            >
              <SandboxDock
                key={docked._id}
                instance={docked}
                projectId={projectId}
                observability={observability}
                tab={dock.tab}
                onTab={(tab) => setDock({ id: dock.id, tab: tab })}
                onClose={() => setDock(null)}
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
      <DataTableCell muted className="tabular-nums">
        {relativeTime(machine.lastSeenAt, now)}
      </DataTableCell>
      <DataTableCell muted className="tabular-nums">
        {relativeTime(machine.connectedAt, now)}
      </DataTableCell>
      <DataTableCell align="right" muted>
        —
      </DataTableCell>
    </DataTableRow>
  );
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
