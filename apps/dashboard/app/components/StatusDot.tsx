import type { ObservabilityStreamStatus } from "@/app/hooks/useObservabilityStream";
import { cn } from "@/app/lib/utils";

export type StatusTone = "ok" | "warn" | "error" | "running" | "ended";

// The hue carries the meaning, so each tone needs both themes. The tokens hold
// the 600 shade on the light card and the 400 shade on the dark, the only
// shades that clear WCAG AA there.
export const STATUS_TONE_BG: Record<StatusTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-destructive",
  running: "bg-info",
  ended: "bg-muted-foreground/50",
};

/** Socket state as a tone, shared by the log tail and the live terminal. */
export const CONNECTION_TONE: Record<
  ObservabilityStreamStatus | "ended",
  StatusTone
> = {
  idle: "ended",
  connecting: "running",
  live: "ok",
  ended: "ended",
  error: "error",
};

/**
 * Status as a colored dot with no visible word. `label` is what hover and
 * screen readers get; pass the real state when several states share a tone
 * (suspending and terminating both run sky). Inline-block, so it keeps its size
 * straight in a table cell, not only inside a flex row. Relative, so the
 * absolute sr-only label stays inside the table's scroll box: with no
 * positioned ancestor, every row's label stretches the document, and View
 * trace's scrollIntoView then slides the whole page.
 */
export function StatusDot({
  tone,
  label = tone,
  className,
}: {
  tone: StatusTone;
  label?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      title={label}
      className={cn(
        "relative inline-block size-2 shrink-0 rounded-full",
        STATUS_TONE_BG[tone],
        className,
      )}
    >
      <span className="sr-only">{label}</span>
    </span>
  );
}
