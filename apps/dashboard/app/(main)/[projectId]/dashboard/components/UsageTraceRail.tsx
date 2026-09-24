"use client";

import { StatusDot } from "@/app/components/StatusDot";
import { formatNumber } from "@/app/lib/formatNumber";
import { formatDuration } from "@/app/lib/formatTime";
import { cn } from "@/app/lib/utils";
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
  /** CSS color for a model, same as the chart and table. */
  modelColor: (modelProvider: string, modelId: string) => string;
  onClear: () => void;
}

/**
 * Right-hand rail of the Usage tab: the traces behind the selected chart bin,
 * heaviest first, each linking to the Tracing tab. Fixed height with its own
 * scroll, so opening it never moves the content below.
 */
export function UsageTraceRail({
  projectId,
  stageId,
  bin,
  isModelShown,
  modelColor,
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

  const tasks = (result?.tasks ?? []).filter((task) =>
    isModelShown(task.modelProvider, task.modelId),
  );
  const heaviest = tasks[0]?.totalTokens || 1;
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
            ? ` · ${tasks.length} trace${tasks.length === 1 ? "" : "s"}`
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
      {result && tasks.length === 0 && (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          {expired
            ? "Trace details are kept for 90 days."
            : "No finished tasks in this bin."}
        </p>
      )}
      {tasks.map((task, i) => {
        const row = (
          <>
            <span className="flex items-center gap-2">
              <StatusDot
                tone={task.status === "failed" ? "error" : "ok"}
                label={task.status}
                className="size-1.5"
              />
              <span className="truncate font-mono text-info">
                {task.traceId ? task.traceId.slice(0, 12) : "no trace"}
              </span>
              <span className="ml-auto tabular-nums">
                {formatNumber(task.totalTokens)}
              </span>
            </span>
            <span className="flex flex-wrap gap-x-2 pl-3.5 text-2xs text-muted-foreground">
              <span>{task.agentId}</span>
              <span>{task.modelId}</span>
              <span>{task.stepCount} calls</span>
              <span>{formatDuration(task.durationMs)}</span>
            </span>
            <span className="ml-3.5 block h-0.5 overflow-hidden rounded-full bg-border">
              <span
                className="block h-full w-(--share) bg-(--series-color)"
                style={{
                  "--share": `${(task.totalTokens / heaviest) * 100}%`,
                  "--series-color": modelColor(
                    task.modelProvider,
                    task.modelId,
                  ),
                }}
              />
            </span>
          </>
        );
        const className =
          "grid gap-1 border-b border-border px-3 py-2 text-xs hover:bg-accent/40";

        return task.traceId ? (
          <Link
            key={`${task.traceId}-${i}`}
            href={traceHref(task.traceId)}
            title="Open in Tracing"
            className={cn(className, "cursor-pointer")}
          >
            {row}
          </Link>
        ) : (
          <div key={`task-${i}`} className={className}>
            {row}
          </div>
        );
      })}
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
