"use client";

import { formatNumber } from "@/app/lib/formatNumber";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { X } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { formatBucketLabel } from "./UsageChart";

interface Props {
  projectId: Id<"projects">;
  stageId: Id<"stages"> | null;
  /** The clicked bin. */
  bin: { startMs: number; binSeconds: number };
  /** Tokens the selected bin shows for the filtered models, for each trace's share. */
  binTokens: number;
  /** The model filter as `provider::model` keys, or null for every model. */
  models: string[] | null;
  onClose: () => void;
}

/**
 * The trace list that opens beside the token chart when a bin is clicked:
 * links to the traces behind that bin, heaviest first. Each row carries the
 * start of its prompt, as Tracing labels it, and the tokens it contributed;
 * the trace itself opens in the Tracing tab. It keeps the chart's height and
 * scrolls inside, so opening it never moves the content below.
 */
export function UsageTraceRail({
  projectId,
  stageId,
  bin,
  binTokens,
  models,
  onClose,
}: Props): React.JSX.Element {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const result = useQuery(api.logs.fetchUsageTasks, {
    projectId: projectId,
    stageId: stageId ?? undefined,
    startMs: bin.startMs,
    endMs: bin.startMs + bin.binSeconds * 1000,
    models: models ?? undefined,
  });

  // Rows written before trace ids joined the task id have nothing to link to.
  const traced = (result?.tasks ?? []).flatMap((task) =>
    task.traceId
      ? [
          {
            traceId: task.traceId,
            totalTokens: task.totalTokens,
            inputPreview: task.inputPreview,
          },
        ]
      : [],
  );
  const traceHref = (traceId: string): string => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", "tracing");
    next.set("trace", traceId);

    return `${pathname}?${next.toString()}`;
  };

  return (
    <Rail>
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-2">
        <span className="text-xs font-medium tabular-nums">
          {formatBucketLabel(bin.startMs, bin.binSeconds, true)}
          {result
            ? ` · ${traced.length} trace${traced.length === 1 ? "" : "s"}`
            : ""}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close traces"
          className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {result === undefined && (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          Loading traces…
        </p>
      )}
      {result && traced.length === 0 && (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          No traces listed for this time.
        </p>
      )}
      {traced.map(({ traceId, totalTokens, inputPreview }, i) => (
        <Link
          key={`${traceId}-${i}`}
          href={traceHref(traceId)}
          title="Open in Tracing"
          className="grid cursor-pointer gap-0.5 border-b border-border px-3 py-2 text-xs hover:bg-accent/40"
        >
          <span className="flex items-baseline justify-between gap-3">
            <span className="truncate">{inputPreview ?? "No prompt text"}</span>
            <span className="font-medium tabular-nums">
              {formatNumber(totalTokens)}
            </span>
          </span>
          <span className="flex items-baseline justify-between gap-3 text-2xs text-muted-foreground">
            <span className="truncate font-mono text-info">
              {traceId.slice(0, 16)}
            </span>
            <span className="tabular-nums">
              {binTokens > 0
                ? `${Math.round((totalTokens / binTokens) * 100)}% of tokens`
                : ""}
            </span>
          </span>
        </Link>
      ))}
      {result?.truncated && (
        <p className="px-3 py-2 text-2xs text-muted-foreground">
          Some tasks in this bin are not listed.
        </p>
      )}
    </Rail>
  );
}

/** The rail's frame: the chart's height beside it, up to that height when stacked. */
function Rail({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="max-h-75 overflow-y-auto overscroll-contain border-t border-border lg:h-75 lg:border-t-0 lg:border-l">
      {children}
    </div>
  );
}
