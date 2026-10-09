"use client";

/**
 * The panel docked under the sandbox list, like an editor's terminal: one
 * tab for the shell and one for the guest log tail, both for the instance
 * the panel was opened from, so the detail column stays a list of facts.
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
import { Play, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { LiveSandboxTerminal } from "./LiveSandboxTerminal";
import { controllable, dashboardHref } from "./sandboxFormat";
import {
  sandboxLogId,
  SandboxLogTail,
  type SandboxObservabilityScope,
} from "./SandboxLogTail";

// Command results kept on screen; older ones drop off the bottom.
const COMMAND_HISTORY = 20;

export type DockTab = "terminal" | "logs";

type Instance = Doc<"sandboxInstances">;
type Controllable = Instance & { sandboxConfigId: Id<"sandboxConfigs"> };

interface CommandEntry {
  command: string;
  result?: FunctionReturnType<typeof api.sandbox.public.runSandboxCommand>;
  error?: string;
}

interface Props {
  instance: Instance;
  projectId: Id<"projects">;
  /** Stage-scoped observability WS inputs for the log tail; null before the stage deploys. */
  observability: SandboxObservabilityScope | null;
  tab: DockTab;
  onTab: (tab: DockTab) => void;
  onClose: () => void;
}

export function SandboxDock({
  instance,
  projectId,
  observability,
  tab,
  onTab,
  onClose,
}: Props): React.JSX.Element {
  const searchParams = useSearchParams();
  const logId = sandboxLogId(instance.logStream);
  // The providers core opens a PTY for: workdir (`sandbox`) over its in-guest
  // WebSocket, AWS MicroVM (`lambda`) over its shell endpoint, and the
  // Cloudflare bridge in its Container. The rest keep the bounded runner.
  const liveShell =
    instance.provider === "sandbox" ||
    instance.provider === "lambda" ||
    instance.provider === "cloudflare";
  // Nothing runs while the provider is mid-change: a connect would race the
  // suspend in flight, and a terminating instance is gone.
  const runnable =
    instance.status !== "terminating" && instance.status !== "suspending";

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button
          variant="nav"
          size="xs"
          data-active={tab === "terminal"}
          className="cursor-pointer"
          onClick={() => onTab("terminal")}
        >
          Terminal
        </Button>
        {logId && (
          <Button
            variant="nav"
            size="xs"
            data-active={tab === "logs"}
            className="cursor-pointer"
            onClick={() => onTab("logs")}
          >
            Logs
          </Button>
        )}
        <span className="ml-2 truncate text-xs text-muted-foreground">
          {instance.name}
        </span>
        <span className="flex-1" />
        <ShortcutKeys id="sandbox.terminal" bordered />
        <Button
          variant="ghost"
          size="icon-xs"
          tone="muted"
          aria-label="Close the dock"
          className="cursor-pointer"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
        {tab === "logs" && logId ? (
          <SandboxLogTail
            logSandboxId={logId}
            scope={observability}
            monitoringHref={dashboardHref(
              projectId,
              searchParams.get("stage"),
              { tab: "monitoring" },
            )}
          />
        ) : !controllable(instance) ? (
          <p className="text-xs text-muted-foreground">
            This instance cannot run commands from the dashboard.
          </p>
        ) : liveShell ? (
          <LiveSandboxTerminal
            sandboxId={instance.sandboxConfigId}
            reservationKey={instance.reservationKey}
            disabled={!runnable}
          />
        ) : (
          <CommandRunner instance={instance} runnable={runnable} />
        )}
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
