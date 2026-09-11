"use client";

/**
 * Guest stdout/stderr for one MicroVM, shipped through the CloudWatch-to-Loki
 * bridge. Subscribing with the instance's sandbox id makes the gateway poll
 * Loki for this instance alone. Lines land a few seconds late; that is the
 * bridge, not the tab.
 */

import { useObservabilityStream } from "@/app/hooks/useObservabilityStream";
import { formatTime } from "@/app/lib/formatTime";
import Link from "next/link";

const BACKFILL = 200;
// Core writes "-" for a run with no deployment scope (channel, cron).
const UNSCOPED = "-";

/**
 * A guest log stream id. Branded because the sheet also holds an
 * `Id<"sandboxConfigs">` that Convex names `sandboxId`, and a plain string type
 * lets the two swap silently: the tail would then subscribe with a config id,
 * fail the gateway's UUID check, and render empty with nothing to point at.
 * Only `sandboxLogId` mints one, at the point it validates the stream name.
 */
export type SandboxLogId = string & { readonly __brand: "sandboxLogId" };

/** The stage-scoped WS inputs the Sandbox page resolves once for every sheet. */
export interface SandboxObservabilityScope {
  projectSlug: string;
  stageSlug: string;
  /** The stage runtime key. */
  apiKey: string | undefined;
}

interface Props {
  /** Last segment of the instance's `logStream`, from `sandboxLogId`. */
  logSandboxId: SandboxLogId;
  /** Null until the stage has an active deployment. */
  scope: SandboxObservabilityScope | null;
  /** Monitoring tab, where the stage's viewing key is minted. */
  monitoringHref: string;
}

/**
 * The id a tail subscribes with, read out of the stream name core wrote at
 * launch: `<accountId>/<project>/<stage>/<uuid>/<mac>`. Undefined when the run
 * had no deployment scope, since the gateway scopes every query on project and
 * stage and such a VM's lines can never match.
 */
export function sandboxLogId(logStream: string): SandboxLogId | undefined {
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
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="font-mono">{logSandboxId}</span>
        <span className={status === "error" ? "text-red-500" : undefined}>
          {status === "error" ? (error ?? "stream error") : status}
        </span>
      </div>
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-black p-3 font-mono text-xs text-zinc-100">
        {entries.length === 0 ? (
          <p className="text-zinc-400">
            No output yet. Guest stdout and stderr appear here a few seconds
            after the sandbox writes them.
          </p>
        ) : (
          entries
            .slice()
            .reverse()
            .map((entry, index) => (
              <div
                key={`${entry.ts}-${index}`}
                className="flex gap-3 whitespace-pre-wrap wrap-break-word"
              >
                <span className="shrink-0 text-zinc-500 tabular-nums">
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
