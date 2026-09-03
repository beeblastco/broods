"use client";

/**
 * Live tail of one sandbox instance's guest output: what the MicroVM wrote to
 * stdout/stderr, shipped through the CloudWatch-to-Loki bridge. Subscribes to the
 * gateway observability WS with the instance's sandbox id, so the gateway polls
 * Loki for this instance alone. Lines land a few seconds after the guest writes
 * them; that latency is the bridge, not the tab.
 */

import { useObservabilityStream } from "@/app/hooks/useObservabilityStream";
import Link from "next/link";

const BACKFILL = 200;

/** The stage-scoped WS inputs the Sandbox page resolves once for every sheet. */
export interface SandboxObservabilityScope {
  projectSlug: string;
  stageSlug: string;
  /** The stage runtime key, or undefined while it has none. */
  apiKey: string | undefined;
}

interface Props {
  /** Last segment of the instance's `logStream`. */
  sandboxId: string;
  /** Null until the stage has an active deployment. */
  scope: SandboxObservabilityScope | null;
  /** Monitoring tab, where the stage's viewing key is minted. */
  monitoringHref: string;
}

export function SandboxLogTail({
  sandboxId,
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
    sandboxId: sandboxId,
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
        <span className="font-mono">{sandboxId}</span>
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

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
