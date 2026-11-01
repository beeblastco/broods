"use client";

import { CopyButton, CopyRow } from "@/app/components/CopyButton";
import { JsonView } from "@/app/components/JsonView";
import { cn } from "@/app/lib/utils";
import type { JSONValue } from "convex/values";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

// Past this a JSON tree would mount tens of thousands of nodes.
const JSON_VIEW_MAX_CHARS = 100_000;

const ROW_GRID = "grid w-full grid-cols-[7rem_minmax(0,1fr)_auto] px-2 py-1";

export interface DetailRow {
  key: string;
  label: string;
  value: string;
  words?: true;
  tone?: "error";
}

export interface ControlRow {
  key: string;
  label: string;
  control: ReactNode;
}

export function DetailFields({
  label,
  rows,
  summary,
}: {
  label: string;
  rows: DetailRow[];
  summary: string;
}): React.JSX.Element {
  return (
    <details className="group/detail">
      <SectionSummary label={label} summary={summary} />
      <DetailRows rows={rows} className="px-1 pb-2" />
    </details>
  );
}

export function DetailRows({
  rows,
  className = "-mx-2",
}: {
  rows: Array<DetailRow | ControlRow>;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("grid text-xs", className)}>
      {rows.map((row) => {
        const label = (
          <span className="truncate text-muted-foreground">{row.label}</span>
        );

        return "control" in row ? (
          <div key={row.key} className={cn(ROW_GRID, "items-center gap-2")}>
            {label}
            {row.control}
          </div>
        ) : (
          <CopyRow key={row.key} value={row.value} className={ROW_GRID}>
            {label}
            <span
              className={cn(
                "truncate",
                row.tone === "error"
                  ? "text-destructive"
                  : "text-foreground/80",
                !row.words && "font-mono",
              )}
            >
              {row.value}
            </span>
          </CopyRow>
        );
      })}
    </div>
  );
}

export function DetailPayload({
  label,
  open,
  summary,
  value,
}: {
  label: string;
  open?: boolean;
  summary: string;
  value: string;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(open === true);

  return (
    <details
      className="group/detail"
      open={open}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <SectionSummary label={label} summary={summary} />
      {expanded && (
        <div className="relative mx-2 mb-2">
          <PayloadBody value={value} className="max-h-[50vh] pl-1 pr-11" />
          <div className="absolute right-4 top-1">
            <CopyButton value={value} label={label.toLowerCase()} />
          </div>
        </div>
      )}
    </details>
  );
}

export function PayloadBody({
  value,
  className,
}: {
  value: string;
  className: string;
}): React.JSX.Element {
  // The parent re-renders on every stream message while a run is live.
  const json = useMemo(
    () => (value.length <= JSON_VIEW_MAX_CHARS ? parseJson(value) : undefined),
    [value],
  );

  return json === undefined ? (
    // wrap-anywhere, unlike wrap-break-word, also lowers the min-content width.
    <pre
      className={cn(
        "overflow-auto whitespace-pre-wrap wrap-anywhere py-1 text-xs leading-relaxed text-foreground/90",
        className,
      )}
    >
      {value}
    </pre>
  ) : (
    <div
      className={cn(
        "overflow-auto rounded-md border border-border bg-code-background py-2 text-xs leading-relaxed",
        className,
      )}
    >
      <JsonView value={json} />
    </div>
  );
}

function SectionSummary({
  label,
  summary,
}: {
  label: string;
  summary: string;
}): React.JSX.Element {
  return (
    <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-xs text-foreground/80 transition-colors hover:text-foreground">
      <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-open/detail:rotate-90" />
      <span className="flex-1">{label}</span>
      <span className="truncate font-mono text-muted-foreground">
        {summary}
      </span>
    </summary>
  );
}

function parseJson(text: string): JSONValue | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const parsed: JSONValue = JSON.parse(trimmed);
    return parsed;
  } catch {
    return undefined;
  }
}
