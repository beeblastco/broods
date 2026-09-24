"use client";

import { formatNumber } from "@/app/lib/formatNumber";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { formatBucketLabel } from "./UsageChart";

// Matches `taskUsage` retention in packages/convex/usage.ts.
const TASK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

interface Props {
  projectId: Id<"projects">;
  stageId: Id<"stages"> | null;
  /** The selected bin, or null when nothing is selected. */
  bin: { startMs: number; binSeconds: number } | null;
  /** Model filter: true when a model's traces should be listed. */
  isModelShown: (modelProvider: string, modelId: string) => boolean;
  onClear: () => void;
}

/**
 * Right-hand rail of the Usage tab: links to the traces behind the selected
 * chart bin, heaviest first, with the tokens each contributed. The trace
 * itself opens in the Tracing tab. Fixed height with its own scroll, so
 * opening it never moves the content below.
 */
export function UsageTraceRail({
  projectId,
  stageId,
  bin,
  isModelShown,
  onClear,
}: Props): React.JSX.Element {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const result = useQuery(
    api.logs.fetchUsageTasks,
    bin
      ? {
          projectId: projectId,
          stageId: stageId ?? undefined,
          startMs: bin.startMs,
          endMs: bin.startMs + bin.binSeconds * 1000,
        }
      : "skip",
  );

  if (!bin) {
    return (
      <Rail>
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          Click the chart to see the traces behind that time.
        </p>
      </Rail>
    );
  }

  // Rows written before trace ids joined the task id have nothing to link to.
  const traced = (result?.tasks ?? []).flatMap((task) =>
    task.traceId && isModelShown(task.modelProvider, task.modelId)
      ? [{ traceId: task.traceId, totalTokens: task.totalTokens }]
      : [],
  );
  const traceHref = (traceId: string): string => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", "tracing");
    next.set("trace", traceId);

    return `${pathname}?${next.toString()}`;
  };
  const expired = bin.startMs < Date.now() - TASK_RETENTION_MS;

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
          onClick={onClear}
          className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
        >
          Clear
        </button>
      </div>
      {result === undefined && (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          Loading traces…
        </p>
      )}
      {result && traced.length === 0 && (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          {expired
            ? "Trace details are kept for 90 days."
            : "No finished tasks in this bin."}
        </p>
      )}
      {traced.map(({ traceId, totalTokens }, i) => (
        <Link
          key={`${traceId}-${i}`}
          href={traceHref(traceId)}
          title="Open in Tracing"
          className="flex cursor-pointer items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs hover:bg-accent/40"
        >
          <span className="truncate font-mono text-info">
            {traceId.slice(0, 16)}
          </span>
          <span className="tabular-nums text-muted-foreground">
            {formatNumber(totalTokens)}
          </span>
        </Link>
      ))}
      {result?.truncated && (
        <p className="px-3 py-2 text-2xs text-muted-foreground">
          Showing the {result.tasks.length} largest tasks.
        </p>
      )}
    </Rail>
  );
}

function Rail({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="h-75 overflow-y-auto overscroll-contain border-t border-border lg:border-t-0 lg:border-l">
      {children}
    </div>
  );
}
