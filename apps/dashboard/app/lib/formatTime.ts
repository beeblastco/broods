const CLOCK: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

// Built once: creating the formatter is the expensive part of a call, and a
// streaming table formats every visible row on each render.
const DATE_TIME = new Intl.DateTimeFormat([], {
  month: "short",
  day: "numeric",
  ...CLOCK,
});

const DATE_TIME_MILLIS = new Intl.DateTimeFormat([], {
  month: "short",
  day: "numeric",
  ...CLOCK,
  fractionalSecondDigits: 3,
});

const TIME = new Intl.DateTimeFormat([], CLOCK);

/** `Sep 14, 16:44:07` in the viewer's zone, so a row is locatable across days. */
export function formatDateTime(ms: number): string {
  return DATE_TIME.format(ms);
}

/** `Sep 14, 16:44:07.312`, for log lines that land in the same second. */
export function formatDateTimeMillis(ms: number): string {
  return DATE_TIME_MILLIS.format(ms);
}

/** Wall-clock `HH:MM:SS` in the viewer's zone, for log and span rows. */
export function formatTime(ms: number): string {
  return TIME.format(ms);
}

/** A `datetime-local` input value as epoch ms, null when empty or unparseable. */
export function toEpochMs(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();

  return Number.isFinite(ms) ? ms : null;
}
