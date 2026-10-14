"use client";

/**
 * The panel docked under the sandbox list, like an editor's terminal. It holds
 * any number of sessions, grouped by sandbox: numbered shells and, for a
 * MicroVM, its guest log tail. Every session stays mounted while another one
 * is shown, so switching tabs keeps a shell connected.
 */

import { ShortcutKeys } from "@/app/components/ShortcutKeys";
import { Button } from "@/app/components/ui/button";
import { Textarea } from "@/app/components/ui/textarea";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { toErrorMessage } from "@/app/lib/errors";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Play, Plus, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import type { DockSession, DockState } from "./dockSessions";
import { LiveSandboxTerminal } from "./LiveSandboxTerminal";
import { controllable, dashboardHref } from "./sandboxFormat";
import {
  sandboxLogId,
  SandboxLogTail,
  type SandboxObservabilityScope,
} from "./SandboxLogTail";

// Command results kept on screen; older ones drop off the bottom.
const COMMAND_HISTORY = 20;

type Instance = Doc<"sandboxInstances">;
type Controllable = Instance & { sandboxConfigId: Id<"sandboxConfigs"> };

interface CommandEntry {
  command: string;
  result?: FunctionReturnType<typeof api.sandbox.public.runSandboxCommand>;
  error?: string;
}

interface Props {
  state: DockState;
  /** The live rows of the sandboxes the sessions belong to. */
  instances: Instance[];
  projectId: Id<"projects">;
  /** Stage-scoped observability WS inputs for the log tail; null before the stage deploys. */
  observability: SandboxObservabilityScope | null;
  onActivate: (key: string) => void;
  onNewShell: (instanceId: Id<"sandboxInstances">) => void;
  onCloseSession: (key: string) => void;
}

export function SandboxDock({
  state,
  instances,
  projectId,
  observability,
  onActivate,
  onNewShell,
  onCloseSession,
}: Props): React.JSX.Element {
  const searchParams = useSearchParams();
  const byId = new Map(instances.map((instance) => [instance._id, instance]));
  const activeInstance = state.sessions.find(
    (session) => session.key === state.active,
  )?.instanceId;
  // Sessions are kept grouped by sandbox, so a group is one run of them.
  const groups = state.sessions.reduce<
    { instance: Instance; sessions: DockSession[] }[]
  >((acc, session) => {
    const instance = byId.get(session.instanceId);
    if (!instance) return acc;
    const last = acc.at(-1);
    if (last?.instance._id === instance._id) last.sessions.push(session);
    else acc.push({ instance: instance, sessions: [session] });

    return acc;
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-terminal-background">
      <div className="flex h-8 shrink-0 items-stretch border-b border-border bg-card">
        {groups.map(({ instance, sessions }) => (
          <div
            key={instance._id}
            data-active={instance._id === activeInstance || undefined}
            className="flex items-center gap-0.5 border-t-2 border-r border-t-transparent border-r-border pr-1 pl-2.5 data-active:border-t-foreground data-active:bg-terminal-background"
          >
            <span
              data-active={instance._id === activeInstance || undefined}
              className="mr-1 text-xs text-muted-foreground data-active:font-medium data-active:text-foreground"
            >
              {instance.name}
            </span>
            {sessions.map((session) => (
              <Button
                key={session.key}
                variant="nav"
                size="xs"
                data-active={session.key === state.active}
                className="cursor-pointer tabular-nums"
                onClick={() => onActivate(session.key)}
              >
                {session.kind === "logs" ? "Logs" : session.shell}
              </Button>
            ))}
            {hasLiveShell(instance) && controllable(instance) && (
              <Button
                variant="ghost"
                size="icon-xs"
                tone="muted"
                aria-label={`New shell on ${instance.name}`}
                className="cursor-pointer"
                onClick={() => onNewShell(instance._id)}
              >
                <Plus />
              </Button>
            )}
          </div>
        ))}
        <span className="flex-1" />
        <div className="flex items-center gap-1 pr-2">
          <ShortcutKeys id="sandbox.terminal" bordered />
          <Button
            variant="ghost"
            size="icon-xs"
            tone="muted"
            aria-label="Close this session"
            className="cursor-pointer"
            onClick={() => onCloseSession(state.active)}
          >
            <X />
          </Button>
        </div>
      </div>
      {state.sessions.map((session) => {
        const instance = byId.get(session.instanceId);
        if (!instance) return null;
        const logId = sandboxLogId(instance.logStream);

        return (
          <div
            key={session.key}
            className={
              session.key === state.active
                ? "flex min-h-0 flex-1 flex-col"
                : "hidden"
            }
          >
            {session.kind === "logs" ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-card p-3">
                {logId ? (
                  <SandboxLogTail
                    logSandboxId={logId}
                    scope={observability}
                    monitoringHref={dashboardHref(
                      projectId,
                      searchParams.get("stage"),
                      { tab: "monitoring" },
                    )}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    This sandbox has no log stream.
                  </p>
                )}
              </div>
            ) : !controllable(instance) ? (
              <p className="bg-card p-3 text-xs text-muted-foreground">
                This instance cannot run commands from the dashboard.
              </p>
            ) : hasLiveShell(instance) ? (
              <LiveSandboxTerminal
                sandboxId={instance.sandboxConfigId}
                reservationKey={instance.reservationKey}
                disabled={!isRunnable(instance)}
                label={`${instance.name} · Shell ${session.shell}`}
              />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-card p-3">
                <CommandRunner
                  instance={instance}
                  runnable={isRunnable(instance)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A bounded command for providers without a PTY: one textarea, Run, and the results under it. */
function CommandRunner({
  instance,
  runnable,
}: {
  instance: Controllable;
  runnable: boolean;
}): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const runCommand = useAction(api.sandbox.public.runSandboxCommand);
  const [command, setCommand] = useState("pwd && ls -la");
  const [pending, setPending] = useState(false);
  const [entries, setEntries] = useState<CommandEntry[]>([]);

  const push = (entry: CommandEntry): void => {
    setEntries((prev) => [entry, ...prev].slice(0, COMMAND_HISTORY));
  };

  async function handleRun(): Promise<void> {
    const code = command.trim();
    if (!code) return;
    setPending(true);
    try {
      const result = await runCommand({
        sandboxId: instance.sandboxConfigId,
        reservationKey: instance.reservationKey,
        code: code,
      });
      push({ command: code, result: result });
    } catch (err) {
      push({ command: code, error: toErrorMessage(err) });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <Textarea
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          disabled={!runnable || pending}
          rows={2}
          variant="code"
          className="cursor-text"
        />
        {canWrite && (
          <Button
            type="button"
            size="sm"
            disabled={!runnable || pending || !command.trim()}
            onClick={handleRun}
            className="shrink-0 cursor-pointer"
          >
            <Play className="size-3.5" />
            Run
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {runnable
          ? "Runs in the reserved sandbox with a 30s timeout and 64 KiB output cap."
          : "This instance cannot run commands from the dashboard in its current state."}
      </p>
      {entries.map((entry, index) => (
        <div
          key={`${entry.command}-${index}`}
          className="rounded-lg border border-border bg-terminal-background p-3 text-xs text-terminal-foreground"
        >
          <div className="mb-2 flex items-center justify-between gap-3 text-2xs text-terminal-muted">
            <code className="min-w-0 flex-1 truncate">$ {entry.command}</code>
            {entry.result && (
              <span
                className={
                  entry.result.ok
                    ? "shrink-0 text-terminal-success"
                    : "shrink-0 text-terminal-error"
                }
              >
                exit {entry.result.exitCode ?? "?"} · {entry.result.durationMs}
                ms
              </span>
            )}
          </div>
          {entry.error ? (
            <pre className="whitespace-pre-wrap wrap-break-word text-terminal-error">
              {entry.error}
            </pre>
          ) : (
            <>
              {entry.result?.stdout && (
                <pre className="whitespace-pre-wrap wrap-break-word text-terminal-foreground">
                  {entry.result.stdout}
                </pre>
              )}
              {entry.result?.stderr && (
                <pre className="mt-2 whitespace-pre-wrap wrap-break-word text-terminal-warning">
                  {entry.result.stderr}
                </pre>
              )}
              {entry.result?.truncated && (
                <p className="mt-2 text-2xs text-terminal-warning">
                  Output truncated.
                </p>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// The providers core opens a PTY for: workdir (`sandbox`) over its in-guest
// WebSocket, AWS MicroVM (`lambda`) over its shell endpoint, and the
// Cloudflare bridge in its Container. The rest keep the bounded runner.
function hasLiveShell(instance: Instance): boolean {
  return (
    instance.provider === "sandbox" ||
    instance.provider === "lambda" ||
    instance.provider === "cloudflare"
  );
}

// Nothing runs while the provider is mid-change: a connect would race the
// suspend in flight, and a terminating instance is gone.
function isRunnable(instance: Instance): boolean {
  return instance.status !== "terminating" && instance.status !== "suspending";
}
