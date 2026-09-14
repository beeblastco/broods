import type { ObservabilityStreamStatus } from "@/app/hooks/useObservabilityStream";
import { cn } from "@/app/lib/utils";

export type StatusTone = "ok" | "error" | "running" | "stale";

// The hue carries the meaning, so each tone needs both themes: the 400 shades
// only clear WCAG AA on the dark card, the 600 shades only on the light.
const TONE_BG: Record<StatusTone, string> = {
  ok: "bg-emerald-600 dark:bg-emerald-400",
  error: "bg-red-600 dark:bg-red-400",
  running: "bg-sky-600 dark:bg-sky-400",
  stale: "bg-muted-foreground/50",
};

/** Socket state as a tone, shared by the log tail and the live terminal. */
export const CONNECTION_TONE: Record<
  ObservabilityStreamStatus | "ended",
  StatusTone
> = {
  idle: "stale",
  connecting: "running",
  live: "ok",
  ended: "stale",
  error: "error",
};

/**
 * Status as a colored dot with no visible word. `label` is what hover and
 * screen readers get; pass the real state when several states share a tone
 * (suspending and terminating both run sky).
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
      className={cn("size-2 shrink-0 rounded-full", TONE_BG[tone], className)}
    >
      <span className="sr-only">{label}</span>
    </span>
  );
}
