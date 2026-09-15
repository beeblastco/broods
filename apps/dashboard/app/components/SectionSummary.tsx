import { ChevronRight } from "lucide-react";

/**
 * Header row of one collapsible detail section: label on the left, a mono
 * count line on the right. Render inside `<details className="group/detail">`
 * so the chevron turns on open.
 */
export function SectionSummary({
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
