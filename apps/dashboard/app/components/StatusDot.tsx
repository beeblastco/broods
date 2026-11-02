import type { ObservabilityStreamStatus } from "@/app/hooks/useObservabilityStream";
import { cn } from "@/app/lib/utils";

export type StatusTone =
  | "ok"
  | "warn"
  | "input"
  | "error"
  | "running"
  | "ended";

// Tokens, not palette: each holds the 600 shade on light and 400 on dark, the only ones at WCAG AA.
export const STATUS_TONE_BG: Record<StatusTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  input: "bg-needs-input",
  error: "bg-destructive",
  running: "bg-info",
  ended: "bg-muted-foreground",
};

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

export function StatusDot({
  tone,
  label = tone,
  className,
}: {
  tone: StatusTone;
  label?: string;
  className?: string;
}): React.JSX.Element {
  // `relative` keeps the sr-only label in the table's scroll box; unpositioned, each row's
  // label stretches the document and scrollIntoView slides the whole page.
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

export function StatusWord({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: string;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", STATUS_TONE_BG[tone])}
      />
      {children}
    </span>
  );
}
