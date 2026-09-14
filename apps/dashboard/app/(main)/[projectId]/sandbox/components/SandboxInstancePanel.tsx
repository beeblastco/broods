"use client";

import { DetailPanel } from "@/app/components/DetailSplit";
import { CopyButton, CopyRow } from "@/app/components/CopyButton";
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { StatusDot } from "@/app/components/StatusDot";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/components/ui/tabs";
import { Textarea } from "@/app/components/ui/textarea";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useAction, useQuery } from "convex/react";
import { Camera, ExternalLink, Play, Terminal } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { LiveSandboxTerminal } from "./LiveSandboxTerminal";
import {
  dashboardHref,
  formatProvider,
  formatSpecs,
  instanceStatusDot,
  relativeTime,
} from "./sandboxFormat";
import {
  sandboxLogId,
  SandboxLogTail,
  type SandboxObservabilityScope,
} from "./SandboxLogTail";

/** Actor source as shown on an activity row; core calls itself "service". */
const ACTOR_LABEL: Record<SandboxAuditEvent["actorSource"], string> = {
  dashboard: "dashboard",
  agent: "agent",
  service: "runtime",
  unknown: "unknown",
};

interface Props {
  instance: Doc<"sandboxInstances">;
  /** Builds the trace deep links. */
  projectId: Id<"projects">;
  /** Stage-scoped observability WS inputs for the Logs tab; null before the stage deploys. */
  observability: SandboxObservabilityScope | null;
  /** The parent table's clock, so both tick together off one timer. */
  now: number;
  onClose: () => void;
}

type TerminalResult = {
  ok: boolean;
  runtime: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  provider: string;
};

type TerminalEntry = {
  command: string;
  result?: TerminalResult;
  error?: string;
};

type SandboxAuditEvent = Doc<"sandboxAuditEvents">;

export function SandboxInstancePanel({
  instance,
  projectId,
  observability,
  now,
  onClose,
}: Props): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const createSnapshot = useAction(api.sandbox.public.createSnapshot);
  const runCommand = useAction(api.sandbox.public.runSandboxCommand);
  const terminate = useAction(api.sandbox.public.terminateSandbox);
  const auditEvents = useQuery(api.sandbox.auditEvents.listForInstance, {
    reservationKey: instance.reservationKey,
    limit: 12,
  });
  const searchParams = useSearchParams();

  const [snapName, setSnapName] = useState("");
  const [snapPending, setSnapPending] = useState(false);
  const [snapMessage, setSnapMessage] = useState<string | null>(null);
  const [terminating, setTerminating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [command, setCommand] = useState("pwd && ls -la");
  const [commandPending, setCommandPending] = useState(false);
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([]);

  // An ephemeral instance lives only for the call that created it, so broods has
  // already dropped it by the time an action here could reach the provider.
  const controllable =
    Boolean(instance.sandboxConfigId) && instance.ephemeral !== true;
  const commandRunnable = controllable && instance.status !== "terminating";
  // The self-hosted workdir `sandbox` provider exposes an in-guest PTY WebSocket
  // and AWS MicroVM (`lambda`) exposes its native shell endpoint; the third-party
  // providers keep the bounded command runner.
  const supportsLiveTerminal =
    instance.provider === "sandbox" || instance.provider === "lambda";
  // Only the workdir `sandbox` provider has a runtime snapshot-to-image API, so
  // the capture action is hidden elsewhere. The others still keep state across
  // idle through suspend/resume.
  const supportsSnapshot = instance.provider === "sandbox";
  // Only a provider with its own guest log stream can be tailed, and only a
  // deployment-scoped run has lines the gateway can find.
  const logSandboxId = instance.logStream
    ? sandboxLogId(instance.logStream)
    : undefined;

  const stage = searchParams.get("stage");
  function traceHref(traceId: string): string {
    return dashboardHref(projectId, stage, { tab: "tracing", trace: traceId });
  }

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
      setSnapMessage("Snapshot captured.");
    } catch (err) {
      setSnapMessage(err instanceof Error ? err.message : "Snapshot failed");
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

  async function handleCommand(): Promise<void> {
    if (!instance.sandboxConfigId || !command.trim()) return;
    const code = command.trim();
    setCommandPending(true);
    try {
      const result = await runCommand({
        sandboxId: instance.sandboxConfigId,
        reservationKey: instance.reservationKey,
        code: code,
      });
      setTerminalEntries((entries) =>
        [{ command: code, result: result }, ...entries].slice(0, 20),
      );
    } catch (err) {
      setTerminalEntries((entries) =>
        [
          {
            command: code,
            error: err instanceof Error ? err.message : "Command failed",
          },
          ...entries,
        ].slice(0, 20),
      );
    } finally {
      setCommandPending(false);
    }
  }

  return (
    <DetailPanel
      title={
        <span className="flex items-center gap-2">
          {instance.name}
          {instanceStatusDot(instance.status)}
        </span>
      }
      meta={
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {formatProvider(instance.provider)} sandbox instance
        </div>
      }
      onClose={onClose}
    >
      <Tabs defaultValue="detail">
        <TabsList>
          <TabsTrigger value="detail">Detail</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          {logSandboxId && <TabsTrigger value="logs">Logs</TabsTrigger>}
          <TabsTrigger value="terminal">Terminal</TabsTrigger>
        </TabsList>

        <TabsContent value="detail" className="mt-4">
          <InstanceDetailFields
            instance={instance}
            now={now}
            traceHref={traceHref}
          />

          <div className="mt-5">
            <h4 className="text-sm font-medium text-foreground">Snapshot</h4>
            {supportsSnapshot ? (
              <>
                <p className="mt-1 text-xs text-muted-foreground">
                  Capture the current sandbox state as a reusable image.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    value={snapName}
                    onChange={(e) => setSnapName(e.target.value)}
                    placeholder="snapshot name"
                    disabled={!controllable || snapPending}
                    className="h-8"
                  />
                  {canWrite && (
                    <Button
                      size="sm"
                      className="cursor-pointer disabled:cursor-not-allowed"
                      disabled={
                        !controllable || snapPending || !snapName.trim()
                      }
                      onClick={handleSnapshot}
                    >
                      <Camera className="mr-1 size-3.5" />
                      Snapshot
                    </Button>
                  )}
                </div>
                {snapMessage && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {snapMessage}
                  </p>
                )}
              </>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                {formatProvider(instance.provider)} sandboxes have no runtime
                image-capture API, so snapshots aren&apos;t created here. State
                is preserved across idle via suspend/resume, and the launch
                image is managed as versioned image builds.
              </p>
            )}
          </div>

          <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <h4 className="text-sm font-medium text-destructive">
              Danger zone
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              Terminate the instance, releasing its reservation and compute.
            </p>
            {canWrite && (
              <Button
                variant="destructive"
                size="sm"
                className="mt-3 cursor-pointer disabled:cursor-not-allowed"
                disabled={!controllable}
                onClick={() => setConfirmOpen(true)}
              >
                Terminate
              </Button>
            )}
          </div>

          {!controllable && (
            <p className="mt-3 text-xs text-muted-foreground">
              {instance.ephemeral
                ? "This instance exists only for the call that created it, so it can be watched but not controlled here. Make the sandbox persistent to reserve one you can suspend, resume, and shell into."
                : "This instance predates the config link, so it can be viewed but not controlled here."}
            </p>
          )}
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <ActivityList events={auditEvents} now={now} traceHref={traceHref} />
        </TabsContent>

        {logSandboxId && (
          <TabsContent value="logs" className="mt-4">
            <SandboxLogTail
              logSandboxId={logSandboxId}
              scope={observability}
              monitoringHref={dashboardHref(projectId, stage, {
                tab: "monitoring",
              })}
            />
          </TabsContent>
        )}

        <TabsContent value="terminal" className="mt-4">
          {supportsLiveTerminal && controllable && instance.sandboxConfigId ? (
            <LiveSandboxTerminal
              sandboxId={instance.sandboxConfigId}
              reservationKey={instance.reservationKey}
              disabled={!commandRunnable}
            />
          ) : (
            <CommandRunner
              command={command}
              entries={terminalEntries}
              pending={commandPending}
              runnable={commandRunnable}
              onCommandChange={setCommand}
              onRun={handleCommand}
              canRun={canWrite}
            />
          )}
        </TabsContent>
      </Tabs>

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
 * Expects `events` newest first. One row per event: outcome dot, action,
 * outcome, actor, a fixed "View trace" column so the link sits in the same
 * place on every row, and the time. The ids under it copy on click.
 */
function ActivityList({
  events,
  now,
  traceHref,
}: {
  events: SandboxAuditEvent[] | undefined;
  now: number;
  traceHref: (traceId: string) => string;
}): React.JSX.Element {
  if (events === undefined || events.length === 0) {
    return (
      <p className="py-4 text-xs text-muted-foreground">
        {events === undefined ? "Loading activity..." : "No activity recorded."}
      </p>
    );
  }

  return (
    <div className="divide-y divide-border/40 text-xs">
      {events.map((event) => (
        <div
          key={event._id}
          className="grid grid-cols-[14px_minmax(0,1fr)_auto_auto] items-center gap-x-2.5 px-2 py-1.5 transition-colors hover:bg-accent/20"
        >
          <StatusDot tone={event.result} className="justify-self-center" />
          <div className="flex min-w-0 items-center gap-2">
            <span className="font-medium whitespace-nowrap text-foreground">
              {event.action}
            </span>
            <span
              className={cn(
                "truncate empty:hidden",
                event.result === "ok"
                  ? "text-muted-foreground"
                  : "text-red-700 dark:text-red-400",
              )}
            >
              {auditDetail(event)}
            </span>
            <span className="ml-auto truncate text-muted-foreground/70">
              {actorLabel(event)}
            </span>
          </div>
          {event.traceId && (
            <TraceLink href={traceHref(event.traceId)}>View trace</TraceLink>
          )}
          <span className="col-start-4 w-16 text-right font-mono whitespace-nowrap text-muted-foreground">
            {relativeTime(event.createdAt, now)}
          </span>
          {(event.traceId || event.taskId) && (
            <div className="col-span-3 col-start-2 flex min-w-0 gap-3 font-mono text-muted-foreground">
              {event.traceId && (
                <CopyRow value={event.traceId} className="flex">
                  <span className="truncate">trace {event.traceId}</span>
                </CopyRow>
              )}
              {event.taskId && (
                <CopyRow value={event.taskId} className="flex">
                  <span className="truncate">task {event.taskId}</span>
                </CopyRow>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function actorLabel(event: SandboxAuditEvent): string {
  const label = ACTOR_LABEL[event.actorSource];
  const who = event.actorEmail ?? event.actorName ?? event.actorId;

  return who ? `${label} · ${who}` : label;
}

/** Empty for a plain success: the dot already says ok. */
function auditDetail(event: SandboxAuditEvent): string {
  if (event.result === "error") return event.errorMessage ?? "failed";
  if (event.action === "exec" && event.exitCode !== undefined)
    return `exit ${event.exitCode}`;
  if (event.status) return event.status;

  return "";
}

function CommandRunner({
  canRun,
  command,
  entries,
  pending,
  runnable,
  onCommandChange,
  onRun,
}: {
  /** Members are read-only: they see past output but get no Run button. */
  canRun: boolean;
  command: string;
  entries: TerminalEntry[];
  pending: boolean;
  runnable: boolean;
  onCommandChange: (value: string) => void;
  onRun: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
          <Terminal className="size-4" />
          Shell command
        </div>
        <Textarea
          value={command}
          onChange={(event) => onCommandChange(event.target.value)}
          disabled={!runnable || pending}
          rows={4}
          className="cursor-text font-mono text-xs disabled:cursor-not-allowed"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Runs in the reserved sandbox with a 30s timeout and 64 KiB output
            cap.
          </p>
          {canRun && (
            <Button
              type="button"
              size="sm"
              disabled={!runnable || pending || !command.trim()}
              onClick={onRun}
              className="cursor-pointer disabled:cursor-not-allowed"
            >
              <Play className="mr-1 size-3.5" />
              Run
            </Button>
          )}
        </div>
        {!runnable && (
          <p className="mt-2 text-xs text-muted-foreground">
            This instance cannot run commands from the dashboard in its current
            state.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {entries.length === 0 ? (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-8 text-center text-xs text-muted-foreground">
            Run a command to see stdout, stderr, and exit status here.
          </div>
        ) : (
          entries.map((entry, index) => (
            <div
              key={`${entry.command}-${index}`}
              className="rounded-lg border border-border bg-black p-3 text-xs text-white"
            >
              <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-zinc-400">
                <code className="min-w-0 flex-1 truncate">
                  $ {entry.command}
                </code>
                {entry.result && (
                  <span
                    className={
                      entry.result.ok
                        ? "shrink-0 text-emerald-300"
                        : "shrink-0 text-red-300"
                    }
                  >
                    exit {entry.result.exitCode ?? "?"} ·{" "}
                    {entry.result.durationMs}ms
                  </span>
                )}
              </div>
              {entry.error ? (
                <pre className="whitespace-pre-wrap wrap-break-word text-red-200">
                  {entry.error}
                </pre>
              ) : (
                <>
                  {entry.result?.stdout && (
                    <pre className="whitespace-pre-wrap wrap-break-word text-zinc-100">
                      {entry.result.stdout}
                    </pre>
                  )}
                  {entry.result?.stderr && (
                    <pre className="mt-2 whitespace-pre-wrap wrap-break-word text-amber-200">
                      {entry.result.stderr}
                    </pre>
                  )}
                  {entry.result?.truncated && (
                    <p className="mt-2 text-[11px] text-amber-200">
                      Output truncated.
                    </p>
                  )}
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-2 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-xs text-foreground">{value}</span>
    </div>
  );
}

function InstanceDetailFields({
  instance,
  now,
  traceHref,
}: {
  instance: Doc<"sandboxInstances">;
  now: number;
  traceHref: (traceId: string) => string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card px-4">
      <Field label="Provider" value={formatProvider(instance.provider)} />
      <Field label="Status" value={instance.status} />
      {instance.errorMessage && (
        <Field label="Reason" value={instance.errorMessage} />
      )}
      <Field label="Size" value={formatSpecs(instance.specs)} />
      <Field
        label="External ID"
        value={<code className="font-mono">{instance.externalId}</code>}
      />
      <Field
        label="Reservation key"
        value={
          <span className="inline-flex items-center gap-1">
            <code className="font-mono break-all">
              {instance.reservationKey}
            </code>
            <CopyButton
              value={instance.reservationKey}
              label="reservation key"
            />
          </span>
        }
      />
      {instance.agentId && (
        <Field
          label="Agent"
          value={<code className="font-mono">{instance.agentId}</code>}
        />
      )}
      {instance.conversationKey && (
        <Field
          label="Conversation"
          value={
            <code className="font-mono break-all">
              {instance.conversationKey}
            </code>
          }
        />
      )}
      {instance.workspaceName && (
        <Field label="Workspace" value={instance.workspaceName} />
      )}
      {[
        { label: "Created trace", traceId: instance.createdByTraceId },
        { label: "Last trace", traceId: instance.lastUsedTraceId },
      ].map(
        ({ label, traceId }) =>
          traceId && (
            <Field
              key={label}
              label={label}
              value={
                <TraceLink href={traceHref(traceId)}>
                  <code className="max-w-45 truncate font-mono">{traceId}</code>
                </TraceLink>
              }
            />
          ),
      )}
      {instance.snapshotId && (
        <Field
          label="Snapshot"
          value={<code className="font-mono">{instance.snapshotId}</code>}
        />
      )}
      <Field label="Created" value={relativeTime(instance.createdAt, now)} />
      <Field label="Last used" value={relativeTime(instance.lastUsedAt, now)} />
      {instance.suspendedAt && (
        <Field
          label="Suspended"
          value={relativeTime(instance.suspendedAt, now)}
        />
      )}
    </div>
  );
}

/** Opens the Tracing tab focused on one trace. `children` is the link text. */
function TraceLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      draggable={false}
      className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap text-foreground/80 transition-colors hover:text-foreground hover:underline"
    >
      {children}
      <ExternalLink className="size-3 shrink-0" />
    </Link>
  );
}
