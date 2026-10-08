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
import { DetailSplit } from "@/app/components/DetailSplit";
import { EmptyState } from "@/app/components/EmptyState";
import { LoadMore } from "@/app/components/LoadMore";
import { SearchInput } from "@/app/components/SearchInput";
import { SegmentedControl } from "@/app/components/SegmentedControl";
import { StatusDot } from "@/app/components/StatusDot";
import { RefreshButton, Toolbar, ToolbarCount } from "@/app/components/Toolbar";
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
import { useNow } from "@/app/hooks/useNow";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { toErrorMessage } from "@/app/lib/errors";
import {
  MACHINE_STATE_LABEL,
  MACHINE_TONE,
  machineState,
  type MachineConnection,
} from "@/app/lib/machineConnection";
import { parseQuery } from "@/app/lib/queryTokens";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useAction } from "convex/react";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MachinePanel } from "./MachinePanel";
import type { SandboxObservabilityScope } from "./SandboxLogTail";
import { SandboxInstancePanel } from "./SandboxInstancePanel";
import {
  dashboardHref,
  formatProvider,
  formatSpecs,
  INSTANCE_TONE,
  relativeTime,
} from "./sandboxFormat";

interface Props {
  instances: Array<Doc<"sandboxInstances">>;
  /** The stage's computers that connected through `broods machine`. */
  machines: MachineConnection[];
  /** Builds the trace deep links. */
  projectId: Id<"projects">;
  /** Stage-scoped observability WS inputs, handed to the panel's Logs tab. */
  observability: SandboxObservabilityScope | null;
}

/** One row of the table: a connected computer, or a cloud instance. */
type TableRow =
  | { kind: "machine"; machine: MachineConnection }
  | { kind: "instance"; instance: Doc<"sandboxInstances"> };

// The `field:value` tokens the search box understands.
const INSTANCE_QUERY_FIELDS = ["provider", "status", "agent"] as const;

// The status groups the segmented control counts. Transitional states count
// with the state they are leaving, so the numbers add up to the list.
type StatusGroup = "all" | "running" | "suspended" | "error";

const STATUS_GROUP_OF: Record<Doc<"sandboxInstances">["status"], StatusGroup> =
  {
    running: "running",
    suspending: "running",
    terminating: "running",
    suspended: "suspended",
    error: "error",
  };

const STATUS_GROUPS: Array<{ id: StatusGroup; label: string }> = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "suspended", label: "Suspended" },
  { id: "error", label: "Error" },
];

// Rows rendered before the "Load more" footer, like the logs table.
const PAGE_SIZE = 50;

// Six columns of short text; below this the detail panel would wrap them.
const INSTANCE_TABLE_MIN_WIDTH = 720;

export function SandboxInstancesTable({
  instances,
  machines,
  projectId,
  observability,
}: Props): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const suspend = useAction(api.sandbox.public.suspendSandbox);
  const resume = useAction(api.sandbox.public.resumeSandbox);
  const refresh = useAction(api.sandbox.public.refreshSandbox);
  const searchParams = useSearchParams();
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
  const [confirming, setConfirming] = useState<Doc<"sandboxInstances"> | null>(
    null,
  );
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [group, setGroup] = useState<StatusGroup>("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const refreshedSets = useRef(new Set<string>());

  const counts = useMemo(() => {
    const tally: Record<StatusGroup, number> = {
      all: instances.length + machines.length,
      running: 0,
      suspended: 0,
      error: 0,
    };
    for (const instance of instances) tally[STATUS_GROUP_OF[instance.status]]++;
    for (const machine of machines) {
      if (machineState(machine, now) === "connected") tally.running++;
    }

    return tally;
  }, [instances, machines, now]);

  // The live query returns the whole (small) list, so filtering is client-side.
  const query = useMemo(
    () => parseQuery(filter, INSTANCE_QUERY_FIELDS),
    [filter],
  );
  const filtered = useMemo(
    () =>
      instances.filter((instance) => {
        if (group !== "all" && STATUS_GROUP_OF[instance.status] !== group) {
          return false;
        }
        const fieldsPass = query.fields.every(({ field, value }) =>
          field === "provider"
            ? formatProvider(instance.provider).toLowerCase().startsWith(value)
            : field === "status"
              ? instance.status.startsWith(value)
              : (instance.agentId ?? "").toLowerCase().startsWith(value),
        );
        if (!fieldsPass) return false;
        if (!query.text) return true;

        return [
          instance.name,
          instance.externalId,
          instance.provider,
          instance.conversationKey ?? "",
          instance.lastUsedTraceId ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(query.text);
      }),
    [instances, group, query],
  );

  // A computer is running while connected, and has no other state or agent.
  const filteredMachines = useMemo(
    () =>
      machines.filter((machine) => {
        const connected = machineState(machine, now) === "connected";
        if (group === "running" && !connected) return false;
        if (group !== "all" && group !== "running") return false;
        const fieldsPass = query.fields.every(
          ({ field, value }) =>
            (field === "provider" && "broods machine".startsWith(value)) ||
            (field === "status" &&
              MACHINE_STATE_LABEL[machineState(machine, now)]
                .toLowerCase()
                .startsWith(value)),
        );
        if (!fieldsPass) return false;
        if (!query.text) return true;

        return `${machine.name} ${machine.hostname ?? ""}`
          .toLowerCase()
          .includes(query.text);
      }),
    [machines, group, query, now],
  );

  // Computers sort above the instances and page with them, so the count in
  // the toolbar matches what is on screen.
  const rows = useMemo(
    (): TableRow[] => [
      ...filteredMachines.map((machine): TableRow => ({
        kind: "machine",
        machine: machine,
      })),
      ...filtered.map((instance): TableRow => ({
        kind: "instance",
        instance: instance,
      })),
    ],
    [filtered, filteredMachines],
  );
  const visible = useMemo(
    () => rows.slice(0, visibleCount),
    [rows, visibleCount],
  );
  const remaining = rows.length - visible.length;

  // Reset paging whenever the filters change so "Load more" starts from the
  // top of the current view. Render-time adjustment, not an effect.
  const filterSignature = `${filter}|${group}`;
  const [prevFilterSignature, setPrevFilterSignature] =
    useState(filterSignature);
  if (filterSignature !== prevFilterSignature) {
    setPrevFilterSignature(filterSignature);
    setVisibleCount(PAGE_SIZE);
  }

  // Only instances have a lifecycle, so the refresh controls work off these.
  const visibleInstances = useMemo(
    () =>
      visible.flatMap((row) => (row.kind === "instance" ? [row.instance] : [])),
    [visible],
  );
  const refreshKey = visibleInstances
    .filter(controllable)
    .map((instance) => `${instance.sandboxConfigId}:${instance.reservationKey}`)
    .join("|");

  // Resuming is cheap and reversible, so it runs straight from the toggle; suspending
  // discards the instance's live state and goes through `confirming` first.
  async function toggle(
    instance: Doc<"sandboxInstances">,
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
    if (!refreshKey || refreshedSets.current.has(refreshKey)) return;
    refreshedSets.current.add(refreshKey);
    void refreshVisible();
  }, [refreshKey, refreshVisible]);

  if (instances.length === 0 && machines.length === 0) {
    return (
      <EmptyState
        title="No running sandbox instances."
        detail="Run an agent against a sandbox and it appears here live. Per-call instances last the length of the call, reserved ones until suspended. A computer running broods machine shows up here too."
      />
    );
  }

  const traceHref = (instance: Doc<"sandboxInstances">): string | null => {
    const traceId = instance.lastUsedTraceId ?? instance.createdByTraceId;

    return traceId
      ? dashboardHref(projectId, searchParams.get("stage"), {
          tab: "tracing",
          trace: traceId,
        })
      : null;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar className="border-b-0 px-0">
        <SearchInput
          value={filter}
          onChange={setFilter}
          fields={INSTANCE_QUERY_FIELDS}
          placeholder="Search name, id, agent · provider: status: agent:"
        />
        <SegmentedControl
          options={STATUS_GROUPS.map((option) => ({
            ...option,
            count: counts[option.id],
          }))}
          value={group}
          onChange={setGroup}
          ariaLabel="Filter by status"
        />
        <ToolbarCount shown={rows.length} total={counts.all} />
        <RefreshButton
          onRefresh={refreshVisible}
          disabled={refreshing || !visibleInstances.some(controllable)}
          title="Refresh the listed instances"
          isError={error !== null}
        />
      </Toolbar>
      {error && <p className="pb-2 text-xs text-destructive">{error}</p>}

      <DetailSplit
        tableMinWidth={INSTANCE_TABLE_MIN_WIDTH}
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
              <DataTableHead>Name</DataTableHead>
              <DataTableHead>Status</DataTableHead>
              <DataTableHead>Size</DataTableHead>
              <DataTableHead>Agent</DataTableHead>
              <DataTableHead>Activity</DataTableHead>
              <DataTableHead align="right">Running</DataTableHead>
            </tr>
          </DataTableHeader>
          <DataTableBody>
            {visible.map((row) => {
              if (row.kind === "machine") {
                return (
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
                );
              }
              const instance = row.instance;
              const running = instance.status === "running";
              const toggleable =
                controllable(instance) &&
                (instance.status === "running" ||
                  instance.status === "suspended") &&
                pendingId !== instance._id;
              const href = traceHref(instance);

              return (
                <DataTableRow
                  key={instance._id}
                  selected={selectedId === instance._id}
                  className="group"
                  onClick={() => {
                    setSelectedMachineId(null);
                    setSelectedId(instance._id);
                  }}
                >
                  <DataTableCell className="max-w-64">
                    <div className="truncate font-medium text-foreground">
                      {instance.name}
                    </div>
                    <DataTableSub className="font-mono">
                      {formatProvider(instance.provider)}
                      {instance.ephemeral && " · per-call"} ·{" "}
                      {instance.externalId}
                    </DataTableSub>
                  </DataTableCell>
                  <DataTableCell>
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot tone={INSTANCE_TONE[instance.status]} />
                      {instance.status}
                    </span>
                    {instance.errorMessage && (
                      <DataTableSub
                        className="max-w-56 text-destructive"
                        title={instance.errorMessage}
                      >
                        {instance.errorMessage}
                      </DataTableSub>
                    )}
                  </DataTableCell>
                  <DataTableCell muted>
                    {formatSpecs(instance.specs)}
                  </DataTableCell>
                  <DataTableCell muted>{instance.agentId ?? "—"}</DataTableCell>
                  <DataTableCell>
                    <div>used {relativeTime(instance.lastUsedAt, now)}</div>
                    <DataTableSub>
                      created {relativeTime(instance.createdAt, now)}
                      {instance.snapshotId &&
                        ` · snapshot ${instance.snapshotId}`}
                    </DataTableSub>
                  </DataTableCell>
                  <DataTableCell
                    align="right"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <span className="inline-flex items-center gap-2">
                      {href && (
                        // Shown on row hover or keyboard focus; the switch stays put.
                        <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <Button
                            nativeButton={false}
                            render={<Link href={href} draggable={false} />}
                            variant="ghost"
                            size="xs"
                            tone="muted"
                            className="cursor-pointer"
                          >
                            Trace
                            <ExternalLink className="size-3" />
                          </Button>
                        </span>
                      )}
                      <Switch
                        checked={running}
                        disabled={!toggleable || !canWrite}
                        className="cursor-pointer"
                        onCheckedChange={(next) =>
                          next
                            ? toggle(instance, true)
                            : setConfirming(instance)
                        }
                        aria-label={running ? "Suspend" : "Resume"}
                      />
                    </span>
                  </DataTableCell>
                </DataTableRow>
              );
            })}
          </DataTableBody>
        </DataTable>
        {rows.length === 0 && (
          <EmptyState title="Nothing matches the current filters." />
        )}
        <LoadMore
          pageSize={PAGE_SIZE}
          remaining={remaining}
          onLoad={() => setVisibleCount((count) => count + PAGE_SIZE)}
        />
      </DetailSplit>

      {instances.length > 0 && !instances.some(controllable) && (
        <p className="mt-2 text-xs text-muted-foreground">
          Per-call instances, and instances reserved before the registry linked
          their config, can be viewed but not controlled here.
        </p>
      )}

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
              Suspending frees the sandbox&apos;s compute. Running processes are
              stopped and any in-flight agent turn or background job on this
              instance is dropped, and it comes back reset. Files on the
              workspace disk are kept, and you can resume once it has fully
              suspended.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              variant="ghost"
              className="cursor-pointer"
              disabled={pendingId !== null}
              onClick={() => setConfirming(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
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

/** Lifecycle actions apply only to reserved, non-ephemeral instances. */
function controllable(
  instance: Doc<"sandboxInstances">,
): instance is Doc<"sandboxInstances"> & {
  sandboxConfigId: Id<"sandboxConfigs">;
} {
  return Boolean(instance.sandboxConfigId) && instance.ephemeral !== true;
}

/** A computer: its reported size, what it serves, and when it was last seen. */
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
  const serves = [
    "bash",
    ...(machine.computer ? ["computer use"] : []),
    ...(machine.mcp.length ? ["mcp"] : []),
  ].join(" · ");

  return (
    <DataTableRow selected={selected} onClick={onSelect}>
      <DataTableCell className="max-w-64">
        <div className="truncate font-medium text-foreground">
          {machine.name}
        </div>
        <DataTableSub className="font-mono">
          {formatProvider("machine")}
          {machine.hostname && ` · ${machine.hostname}`}
        </DataTableSub>
      </DataTableCell>
      <DataTableCell>
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={MACHINE_TONE[state]} />
          {MACHINE_STATE_LABEL[state].toLowerCase()}
        </span>
      </DataTableCell>
      <DataTableCell muted>
        {machine.specs ? formatSpecs(machine.specs) : "—"}
        {(machine.platform || machine.arch) && (
          <DataTableSub>
            {[machine.platform, machine.arch].filter(Boolean).join(" · ")}
          </DataTableSub>
        )}
      </DataTableCell>
      <DataTableCell muted>—</DataTableCell>
      <DataTableCell>
        <div>seen {relativeTime(machine.lastSeenAt, now)}</div>
        <DataTableSub>{serves}</DataTableSub>
      </DataTableCell>
      <DataTableCell align="right" muted>
        —
      </DataTableCell>
    </DataTableRow>
  );
}
