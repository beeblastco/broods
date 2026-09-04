/** Wall-clock `HH:MM:SS` in the viewer's zone, for log and span rows. */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
