"use client";

/**
 * The panel docked under the sandbox list, like an editor's terminal. It holds
 * any number of sessions, grouped by sandbox: numbered shells and, for a
 * MicroVM, its guest log tail. The shown session fills the left; the list on
 * the right switches, opens and closes them. When the dock itself is narrow
 * (a phone, or a narrow window) the list becomes one scrolling row above the
 * shell, so the shell keeps the whole width. Every session stays mounted while
 * another one is shown, so switching keeps a shell connected.
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
import { ChevronDown, Play, Plus, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { LIVE_TERMINAL_SANDBOX_PROVIDERS } from "@broods/convex/model/sandboxProviders";
import {
  dockSessionName,
  type DockSession,
  type DockState,
} from "./dockSessions";
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
  onHide: () => void;
}

export function SandboxDock({
  state,
  instances,
  projectId,
  observability,
  onActivate,
  onNewShell,
  onCloseSession,
  onHide,
}: Props): React.JSX.Element {
  const byId = new Map(instances.map((instance) => [instance._id, instance]));
  // Sessions are kept grouped by sandbox, so a group is one run of them.
  const groups: { instance: Instance; sessions: DockSession[] }[] = [];
  for (const session of state.sessions) {
    const instance = byId.get(session.instanceId);
    if (!instance) continue;
    const last = groups.at(-1);
    if (last?.instance._id === instance._id) {
      last.sessions.push(session);
    } else {
      groups.push({ instance: instance, sessions: [session] });
    }
  }

  return (
    <div data-sandbox-dock className="@container/dock h-full min-h-0">
      <div className="flex h-full min-h-0 flex-col-reverse bg-terminal-background @xl/dock:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {state.sessions.map((session) => {
            const instance = byId.get(session.instanceId);

            return (
              instance && (
                <div
                  key={session.key}
                  className={
                    session.key === state.active
                      ? "flex min-h-0 flex-1 flex-col"
                      : "hidden"
                  }
                >
                  <SessionBody
                    session={session}
                    instance={instance}
                    projectId={projectId}
                    observability={observability}
                  />
                </div>
              )
            );
          })}
        </div>
        <nav
          aria-label="Open sessions"
          className="flex h-8 shrink-0 flex-row-reverse items-center border-b border-border bg-card @xl/dock:h-auto @xl/dock:w-56 @xl/dock:flex-col @xl/dock:items-stretch @xl/dock:border-b-0 @xl/dock:border-l"
        >
          <div className="flex h-8 shrink-0 items-center @xl/dock:border-b @xl/dock:border-border @xl/dock:pl-2">
            <span className="hidden flex-1 text-xs font-medium @xl/dock:block">
              Sessions
            </span>
            <ShortcutKeys id="sandbox.terminal" bordered />
            <Button
              variant="ghost"
              size="icon-xs"
              tone="muted"
              aria-label="Hide the dock"
              className="cursor-pointer"
              onClick={onHide}
            >
              <ChevronDown />
            </Button>
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 items-center overflow-auto @xl/dock:flex-col @xl/dock:items-stretch">
            {groups.map(({ instance, sessions }) => (
              <div
                key={instance._id}
                className="contents @xl/dock:flex @xl/dock:flex-col"
              >
                <div className="flex shrink-0 items-center pl-2">
                  <span className="max-w-40 min-w-0 flex-1 truncate text-xs font-medium">
                    {instance.name}
                  </span>
                  {LIVE_TERMINAL_SANDBOX_PROVIDERS.has(instance.provider) &&
                    controllable(instance) && (
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
                {sessions.map((session) => {
                  const name = dockSessionName(session);

                  return (
                    <div
                      key={session.key}
                      className="flex shrink-0 items-center"
                    >
                      <Button
                        variant="nav"
                        size="xs"
                        data-active={session.key === state.active}
                        aria-current={session.key === state.active || undefined}
                        aria-label={`${name} on ${instance.name}`}
                        className="cursor-pointer justify-start tabular-nums @xl/dock:flex-1"
                        onClick={() => onActivate(session.key)}
                      >
                        {name}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        tone="muted"
                        aria-label={`Close ${name} on ${instance.name}`}
                        className="cursor-pointer"
                        onClick={() => onCloseSession(session.key)}
                      >
                        <X />
                      </Button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </nav>
      </div>
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

/** One session's content: a live shell, or a card holding a log tail, the bounded runner or a note. */
function SessionBody({
  session,
  instance,
  projectId,
  observability,
}: {
  session: DockSession;
  instance: Instance;
  projectId: Id<"projects">;
  observability: SandboxObservabilityScope | null;
}): React.JSX.Element {
  const searchParams = useSearchParams();
  const logId = sandboxLogId(instance.logStream);
  const shell =
    session.kind === "shell" &&
    controllable(instance) &&
    LIVE_TERMINAL_SANDBOX_PROVIDERS.has(instance.provider);
  if (shell) {
    return (
      <LiveSandboxTerminal
        sandboxId={instance.sandboxConfigId}
        reservationKey={instance.reservationKey}
        disabled={!isRunnable(instance)}
        label={`${instance.name} · ${dockSessionName(session)}`}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-card p-3">
      {session.kind === "logs" ? (
        logId ? (
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
        )
      ) : controllable(instance) ? (
        <CommandRunner instance={instance} runnable={isRunnable(instance)} />
      ) : (
        <p className="text-xs text-muted-foreground">
          This instance cannot run commands from the dashboard.
        </p>
      )}
    </div>
  );
}

// Nothing runs while the provider is mid-change: a connect would race the
// suspend in flight, and a terminating instance is gone.
function isRunnable(instance: Instance): boolean {
  return instance.status !== "terminating" && instance.status !== "suspending";
}
