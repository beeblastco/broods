"use client";

import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from "@/app/components/DataTable";
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { DetailRows, type DetailRow } from "@/app/components/DetailSections";
import { DetailPanel } from "@/app/components/DetailSplit";
import { StatusWord } from "@/app/components/StatusDot";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { toErrorMessage } from "@/app/lib/errors";
import { formatTime } from "@/app/lib/formatTime";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { SNAPSHOT_SANDBOX_PROVIDERS } from "@broods/convex/model/sandboxProviders";
import { useAction, useQuery } from "convex/react";
import { Camera, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { type DockTab, hasLogTail, hasTerminal } from "./SandboxDock";
import { dashboardHref } from "./sandboxFormat";

// Activity rows shown before "Show all"; the query holds the rest.
const ACTIVITY_PREVIEW = 5;
const ACTIVITY_LIMIT = 50;

/** Actor source as shown on an activity row; core calls itself "service". */
const ACTOR_LABEL: Record<SandboxAuditEvent["actorSource"], string> = {
  dashboard: "dashboard",
  agent: "agent",
  service: "runtime",
  unknown: "unknown",
};

type SandboxAuditEvent = Doc<"sandboxAuditEvents">;

interface Props {
  instance: Doc<"sandboxInstances">;
  /** The account's snapshots, so the one this instance booted from reads as a name. */
  snapshots: Doc<"sandboxSnapshots">[];
  /** Builds the trace deep links. */
  projectId: Id<"projects">;
  /** Opens the dock under the table on the given tab. */
  onOpenDock: (tab: DockTab) => void;
  onClose: () => void;
}

/**
 * The selected instance. The title line carries the ways out of it: its
 * trace, its logs and its shell. The body holds what the row does not: ids,
 * the activity trail, snapshots, and the danger zone.
 */
export function SandboxInstancePanel({
  instance,
  snapshots,
  projectId,
  onOpenDock,
  onClose,
}: Props): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const createSnapshot = useAction(api.sandbox.public.createSnapshot);
  const terminate = useAction(api.sandbox.public.terminateSandbox);
  const searchParams = useSearchParams();
  const [allActivity, setAllActivity] = useState(false);
  const auditEvents = useQuery(api.sandbox.auditEvents.listForInstance, {
    reservationKey: instance.reservationKey,
    limit: allActivity ? ACTIVITY_LIMIT : ACTIVITY_PREVIEW + 1,
  });

  const [snapName, setSnapName] = useState("");
  const [snapPending, setSnapPending] = useState(false);
  const [snapMessage, setSnapMessage] = useState<string | null>(null);
  const [terminating, setTerminating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // An ephemeral instance lives only for the call that created it, so broods has
  // already dropped it by the time an action here could reach the provider.
  const controllable = hasTerminal(instance);
  // workdir, Daytona, E2B and Vercel capture a running sandbox; a lambda MicroVM
  // is rebuilt as a new image from the files it changed.
  const supportsSnapshot = SNAPSHOT_SANDBOX_PROVIDERS.has(instance.provider);
  const buildsSnapshot = instance.provider === "lambda";
  const traceId = instance.lastUsedTraceId ?? instance.createdByTraceId;
  const stage = searchParams.get("stage");
  const snapshot = snapshots.find(
    (candidate) =>
      candidate._id === instance.snapshotId ||
      candidate.externalImageId === instance.snapshotId,
  );

  const facts = instanceFacts(instance, snapshot);

  async function handleSnapshot(): Promise<void> {
    if (!instance.sandboxConfigId || !snapName.trim()) return;
    setSnapPending(true);
    setSnapMessage(null);
    try {
      await createSnapshot({
        sandboxId: instance.sandboxConfigId,
        reservationKey: instance.reservationKey,
        name: snapName.trim(),
      });
      setSnapName("");
      setSnapMessage(
        buildsSnapshot
          ? "Building the snapshot image. It turns active on the Snapshots tab in a few minutes."
          : "Snapshot captured.",
      );
    } catch (err) {
      setSnapMessage(toErrorMessage(err));
    } finally {
      setSnapPending(false);
    }
  }

  async function handleTerminate(): Promise<void> {
    if (!instance.sandboxConfigId) return;
    setTerminating(true);
    try {
      await terminate({
        sandboxId: instance.sandboxConfigId,
        reservationKey: instance.reservationKey,
      });
      setConfirmOpen(false);
      onClose();
    } finally {
      setTerminating(false);
    }
  }

  return (
    <DetailPanel
      title={instance.name}
      actions={
        <>
          {traceId && (
            <Button
              variant="outline"
              size="sm"
              tone="muted"
              className="cursor-pointer"
              render={
                <Link
                  href={dashboardHref(projectId, stage, {
                    tab: "tracing",
                    trace: traceId,
                  })}
                />
              }
            >
              View trace
              <ExternalLink className="size-3.5" />
            </Button>
          )}
          {hasLogTail(instance) && (
            <Button
              variant="outline"
              size="sm"
              tone="muted"
              className="cursor-pointer"
              onClick={() => onOpenDock("logs")}
            >
              Logs
            </Button>
          )}
          {controllable && (
            <Button
              variant="outline"
              size="sm"
              tone="muted"
              className="cursor-pointer"
              onClick={() => onOpenDock("terminal")}
            >
              Terminal
            </Button>
          )}
        </>
      }
      onClose={onClose}
    >
      <DetailRows rows={facts} className="-mx-2" />

      <h4 className="mt-5 mb-1.5 text-sm font-medium">Activity</h4>
      <ActivityTable
        events={auditEvents}
        projectId={projectId}
        stage={stage}
        expanded={allActivity}
        onExpand={() => setAllActivity(true)}
      />

      {supportsSnapshot && (
        <div className="mt-5">
          <h4 className="text-sm font-medium">Snapshot</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {buildsSnapshot
              ? "Save the files changed since this machine started as a new image. Workspace files stay in the workspace."
              : "Capture the current sandbox state as a reusable image."}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Input
              value={snapName}
              onChange={(event) => setSnapName(event.target.value)}
              placeholder="snapshot name"
              disabled={!controllable || snapPending}
              className="h-8"
            />
            {canWrite && (
              <Button
                size="sm"
                className="cursor-pointer"
                disabled={!controllable || snapPending || !snapName.trim()}
                onClick={handleSnapshot}
              >
                <Camera className="size-3.5" />
                Snapshot
              </Button>
            )}
          </div>
          {snapMessage && (
            <p className="mt-2 text-xs text-muted-foreground">{snapMessage}</p>
          )}
        </div>
      )}

      {canWrite && (
        <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <h4 className="text-sm font-medium text-destructive">Danger zone</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Terminate the instance, releasing its reservation and compute.
          </p>
          <Button
            variant="destructive"
            size="sm"
            className="mt-3 cursor-pointer"
            disabled={!controllable}
            onClick={() => setConfirmOpen(true)}
          >
            Terminate
          </Button>
        </div>
      )}

      {!controllable && (
        <p className="mt-3 text-xs text-muted-foreground">
          {instance.ephemeral
            ? "This instance exists only for the call that created it, so it can be watched but not controlled here. Make the sandbox persistent to reserve one you can suspend, resume, and shell into."
            : "This instance predates the config link, so it can be viewed but not controlled here."}
        </p>
      )}

      <DeleteConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        resourceName={instance.name}
        resourceType="sandbox instance"
        critical={false}
        onConfirm={handleTerminate}
        isDeleting={terminating}
      />
    </DetailPanel>
  );
}

/**
 * Expects `events` newest first. One row per lifecycle event: when, what,
 * how it went or who did it, and its trace. The preview shows the newest
 * few; "Show all" widens the query.
 */
function ActivityTable({
  events,
  projectId,
  stage,
  expanded,
  onExpand,
}: {
  events: SandboxAuditEvent[] | undefined;
  projectId: Id<"projects">;
  stage: string | null;
  expanded: boolean;
  onExpand: () => void;
}): React.JSX.Element {
  if (events === undefined || events.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {events === undefined ? "Loading activity…" : "No activity recorded."}
      </p>
    );
  }
  const shown = expanded ? events : events.slice(0, ACTIVITY_PREVIEW);

  return (
    <>
      <DataTable className="table-fixed">
        <DataTableHeader className="static bg-transparent">
          <tr>
            <DataTableHead className="w-20">Time</DataTableHead>
            <DataTableHead className="w-24">Event</DataTableHead>
            <DataTableHead>Detail</DataTableHead>
            <DataTableHead align="right" className="w-16" />
          </tr>
        </DataTableHeader>
        <DataTableBody>
          {shown.map((event) => (
            <DataTableRow key={event._id}>
              <DataTableCell
                muted
                className="font-mono tabular-nums"
                title={new Date(event.createdAt).toLocaleString()}
              >
                {formatTime(event.createdAt)}
              </DataTableCell>
              <DataTableCell>
                <StatusWord tone={event.result}>{event.action}</StatusWord>
              </DataTableCell>
              <DataTableCell
                muted
                className="truncate"
                title={auditDetail(event)}
              >
                <span
                  className={event.result === "error" ? "text-destructive" : ""}
                >
                  {auditDetail(event)}
                </span>
              </DataTableCell>
              <DataTableCell align="right">
                {event.traceId && (
                  <Link
                    href={dashboardHref(projectId, stage, {
                      tab: "tracing",
                      trace: event.traceId,
                    })}
                    className="cursor-pointer text-foreground underline-offset-3 hover:underline"
                  >
                    Trace
                  </Link>
                )}
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
      {!expanded && events.length > ACTIVITY_PREVIEW && (
        <Button
          variant="ghost"
          size="xs"
          tone="muted"
          className="mt-1 cursor-pointer"
          onClick={onExpand}
        >
          Show all
        </Button>
      )}
    </>
  );
}

/** The rows the table does not show: ids, where it came from, and why it failed. */
function instanceFacts(
  instance: Doc<"sandboxInstances">,
  snapshot: Doc<"sandboxSnapshots"> | undefined,
): DetailRow[] {
  const rows: DetailRow[] = [
    { key: "external", label: "External id", value: instance.externalId },
    {
      key: "reservation",
      label: "Reservation",
      value: instance.reservationKey,
    },
  ];
  if (instance.conversationKey) {
    rows.push({
      key: "conversation",
      label: "Conversation",
      value: instance.conversationKey,
    });
  }
  if (instance.workspaceName) {
    rows.push({
      key: "workspace",
      label: "Workspace",
      value: instance.workspaceName,
      words: true,
    });
  }
  if (instance.snapshotId) {
    rows.push({
      key: "snapshot",
      label: "Snapshot",
      value: snapshot?.name ?? instance.snapshotId,
      words: snapshot ? true : undefined,
    });
  }
  if (instance.errorMessage) {
    rows.push({
      key: "reason",
      label: "Reason",
      value: instance.errorMessage,
      words: true,
      tone: "error",
    });
  }

  return rows;
}

/** The error for a failure, the exit code for a command, else who did it. */
function auditDetail(event: SandboxAuditEvent): string {
  if (event.result === "error") return event.errorMessage ?? "failed";
  const who = event.actorEmail ?? event.actorName ?? event.actorId;
  const actor = who
    ? `${ACTOR_LABEL[event.actorSource]} · ${who}`
    : ACTOR_LABEL[event.actorSource];
  if (event.action === "exec" && event.exitCode !== undefined) {
    return `exit ${event.exitCode} · ${actor}`;
  }

  return event.status ? `${event.status} · ${actor}` : actor;
}
