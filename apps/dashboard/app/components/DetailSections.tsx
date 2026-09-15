import { CopyRow } from "@/app/components/CopyButton";
import { cn } from "@/app/lib/utils";
import { ChevronRight } from "lucide-react";

/** One line in a Details section. Values read in mono (ids, counts) unless `words`. */
export interface DetailRow {
  key: string;
  label: string;
  value: string;
  words?: true;
}

/**
 * Collapsible section of labeled rows, each copying its value on click. Shared
 * by the Tracing and Monitoring detail panes so both read the same.
 */
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
      <div className="grid px-1 pb-2 text-xs">
        {rows.map((row) => (
          <CopyRow
            key={row.key}
            value={row.value}
            className="grid w-full grid-cols-[7rem_minmax(0,1fr)_auto] px-2 py-1"
          >
            <span className="truncate text-muted-foreground">{row.label}</span>
            <span
              className={cn(
                "truncate text-foreground/80",
                !row.words && "font-mono",
              )}
            >
              {row.value}
            </span>
          </CopyRow>
        ))}
      </div>
    </details>
  );
}

/** Collapsible payload: the header row over the value, pre-wrapped. */
export function DetailPayload({
  label,
  summary,
  value,
}: {
  label: string;
  summary: string;
  value: string;
}): React.JSX.Element {
  return (
    <details className="group/detail">
      <SectionSummary label={label} summary={summary} />
      {/* wrap-anywhere, unlike wrap-break-word, also lowers the min-content width. */}
      <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap wrap-anywhere px-3 pb-3 text-xs leading-relaxed text-foreground/90">
        {value}
      </pre>
    </details>
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
