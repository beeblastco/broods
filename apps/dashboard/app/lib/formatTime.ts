/** `Sep 14, 16:44:07` in the viewer's zone; `millis` appends `.312`. */
export function formatDateTime(ms: number, millis = false): string {
  const text = new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return millis ? `${text}.${String(ms % 1000).padStart(3, "0")}` : text;
}

/** Wall-clock `HH:MM:SS` in the viewer's zone, for log and span rows. */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** A `datetime-local` input value as epoch ms, null when empty or unparseable. */
export function toEpochMs(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();

  return Number.isFinite(ms) ? ms : null;
}
