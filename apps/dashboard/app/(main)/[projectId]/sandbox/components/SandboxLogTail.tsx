"use client";

// One MicroVM's guest output via the CloudWatch-to-Loki bridge: lines land seconds late.

import { CONNECTION_TONE, StatusDot } from "@/app/components/StatusDot";
import {
  entryKey,
  useObservabilityStream,
} from "@/app/hooks/useObservabilityStream";
import { formatTime } from "@/app/lib/formatTime";
import Link from "next/link";

const BACKFILL = 200;
// Core writes "-" for a run with no deployment scope (channel, cron).
const UNSCOPED = "-";

// Branded so it cannot swap with the panel's `Id<"sandboxConfigs">` (also called `sandboxId`):
// the gateway's UUID check would fail and the tail render empty. Only `sandboxLogId` mints one.
export type SandboxLogId = string & { readonly __brand: "sandboxLogId" };

export interface SandboxObservabilityScope {
  projectSlug: string;
  stageSlug: string;
  apiKey: string | undefined;
}

interface Props {
  logSandboxId: SandboxLogId;
  scope: SandboxObservabilityScope | null;
  monitoringHref: string;
}

// From `<accountId>/<project>/<stage>/<uuid>/<mac>`. None for an unscoped run: the gateway
// scopes every query on project and stage, so its lines can never match.
export function sandboxLogId(
  logStream: string | undefined,
): SandboxLogId | undefined {
  if (logStream === undefined) return undefined;
  const [, project, stage, id] = logStream.split("/");
  const scoped = project !== UNSCOPED && stage !== UNSCOPED;

  return scoped && id ? (id as SandboxLogId) : undefined;
}

export function SandboxLogTail({
  logSandboxId,
  scope,
  monitoringHref,
}: Props): React.JSX.Element {
  const { entries, status, error } = useObservabilityStream({
    stream: "logs",
    projectSlug: scope?.projectSlug,
    stageSlug: scope?.stageSlug,
    apiKey: scope?.apiKey,
    backfill: BACKFILL,
    minLevel: "DEBUG",
    sandboxId: logSandboxId,
  });

  if (!scope?.apiKey) {
    return (
      <p className="text-xs text-muted-foreground">
        Streaming sandbox output needs this stage&apos;s runtime key.{" "}
        <Link
          href={monitoringHref}
          className="cursor-pointer text-foreground underline underline-offset-2"
        >
          Generate one in Monitoring
        </Link>
        , then reopen this tab.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-2xs text-muted-foreground">
        <span className="font-mono">{logSandboxId}</span>
        <span className="inline-flex items-center gap-1.5">
          {status === "error" && (
            <span className="text-destructive">{error ?? "stream error"}</span>
          )}
          <StatusDot tone={CONNECTION_TONE[status]} label={status} />
        </span>
      </div>
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-terminal-background p-3 font-mono text-xs text-terminal-foreground">
        {entries.length === 0 ? (
          <p className="text-terminal-muted">
            No output yet. Guest stdout and stderr appear here a few seconds
            after the sandbox writes them.
          </p>
        ) : (
          entries
            .slice()
            .reverse()
            .map((entry) => (
              <div
                key={entryKey(entry)}
                className="flex gap-3 whitespace-pre-wrap wrap-break-word"
              >
                <span className="shrink-0 text-terminal-subtle tabular-nums">
                  {formatTime(entry.ts)}
                </span>
                <span>{entry.message}</span>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
