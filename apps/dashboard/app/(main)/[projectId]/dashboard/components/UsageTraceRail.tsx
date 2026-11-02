"use client";

import { Input } from "@/app/components/ui/input";
import { useNow } from "@/app/hooks/useNow";
import { TRACE_RETENTION_DAYS } from "@/app/hooks/useObservabilityStream";
import { formatNumber } from "@/app/lib/formatNumber";
import { formatUsd, modelKey } from "@/app/lib/modelCost";
import { tabHref } from "@/app/lib/navigation";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import {
  estimateModelTokenCost,
  type ModelTokenRates,
} from "@broods/convex/model/modelPricing";
import { useQuery } from "convex/react";
import { Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { formatBucketLabel } from "./UsageChart";

const TRACE_RETENTION_MS = TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

interface Props {
  projectId: Id<"projects">;
  stageId: Id<"stages"> | null;
  bin: { startMs: number; binSeconds: number };
  binTokens: number;
  /** `provider::model` keys, or null for every model. */
  models: string[] | null;
  rates: ReadonlyMap<string, ModelTokenRates>;
  onClose: () => void;
}

export function UsageTraceRail({
  projectId,
  stageId,
  bin,
  binTokens,
  models,
  rates,
  onClose,
}: Props): React.JSX.Element {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const now = useNow();
  const [query, setQuery] = useState("");
  const result = useQuery(api.logs.fetchUsageTasks, {
    projectId: projectId,
    stageId: stageId ?? undefined,
    startMs: bin.startMs,
    endMs: bin.startMs + bin.binSeconds * 1000,
    models: models ?? undefined,
  });

  // Older rows have no trace id in their task id, so nothing to link to.
  const traced = (result?.tasks ?? []).flatMap((task) =>
    task.traceId
      ? [
          {
            traceId: task.traceId,
            totalTokens: task.totalTokens,
            inputPreview: task.inputPreview,
            cost:
              estimateModelTokenCost(rates.get(modelKey(task)), task)?.total ??
              null,
            expired: task.finishedAt < now - TRACE_RETENTION_MS,
          },
        ]
      : [],
  );
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? traced.filter(
        (t) =>
          t.traceId.toLowerCase().includes(needle) ||
          (t.inputPreview ?? "").toLowerCase().includes(needle),
      )
    : traced;
  const traceHref = (traceId: string): string =>
    tabHref(pathname, "tracing", searchParams.toString(), { trace: traceId });

  return (
    <Rail>
      <div className="sticky top-0 z-10 grid gap-2 border-b border-border bg-card px-3 py-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-xs font-medium tabular-nums">
            {formatBucketLabel(bin.startMs, bin.binSeconds, true)}
            {result
              ? needle
                ? ` · ${shown.length} of ${traced.length} traces`
                : ` · ${traced.length} trace${traced.length === 1 ? "" : "s"}`
              : ""}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close traces"
            className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search prompts or trace ids"
            aria-label="Search traces"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>
      {result === undefined && (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          Loading traces…
        </p>
      )}
      {result && shown.length === 0 && (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          {needle ? "No traces match." : "No traces listed for this time."}
        </p>
      )}
      {shown.map((row) => (
        <UsageTraceRow
          key={row.traceId}
          traceId={row.traceId}
          totalTokens={row.totalTokens}
          inputPreview={row.inputPreview}
          cost={row.cost}
          href={row.expired ? null : traceHref(row.traceId)}
          share={binTokens > 0 ? row.totalTokens / binTokens : null}
        />
      ))}
      {result?.truncated && (
        <p className="px-3 py-2 text-2xs text-muted-foreground">
          Some tasks in this bin are not listed.
        </p>
      )}
    </Rail>
  );
}

function UsageTraceRow({
  traceId,
  totalTokens,
  inputPreview,
  cost,
  href,
  share,
}: {
  traceId: string;
  totalTokens: number;
  inputPreview: string | null;
  cost: number | null;
  href: string | null;
  share: number | null;
}): React.JSX.Element {
  const body = (
    <>
      <span className="flex min-w-0 items-start justify-between gap-3">
        <span className="line-clamp-2 min-w-0 break-words">
          {inputPreview ?? "No prompt text"}
        </span>
        <span className="shrink-0 font-mono tabular-nums">
          <span className="text-muted-foreground">
            {cost === null ? "not priced" : formatUsd(cost)}
          </span>{" "}
          <span className="font-medium">{formatNumber(totalTokens)}</span>
        </span>
      </span>
      <span className="flex min-w-0 items-baseline justify-between gap-3 text-2xs text-muted-foreground">
        <span className={cn("min-w-0 truncate font-mono", href && "text-info")}>
          {traceId}
        </span>
        <span className="shrink-0 tabular-nums">
          {share === null ? "" : `${Math.round(share * 100)}% of tokens`}
        </span>
      </span>
    </>
  );
  const rowClass =
    "grid min-w-0 gap-0.5 border-b border-border px-3 py-2 text-xs";

  return href ? (
    <Link
      href={href}
      title={inputPreview ?? "Open in Tracing"}
      className={cn(rowClass, "cursor-pointer hover:bg-accent/40")}
    >
      {body}
    </Link>
  ) : (
    <div
      title={`Traces are kept ${TRACE_RETENTION_DAYS} days`}
      className={cn(rowClass, "cursor-help")}
    >
      {body}
    </div>
  );
}

function Rail({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="max-h-112.5 overflow-y-auto overscroll-contain border-t border-border lg:h-112.5 lg:border-t-0 lg:border-l">
      {children}
    </div>
  );
}
