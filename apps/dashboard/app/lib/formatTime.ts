const CLOCK: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

// Built once: a streaming table formats every visible row on each render.
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

const DATE = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });

export function formatDate(ms: number): string {
  return DATE.format(ms);
}

export function formatDateTime(ms: number): string {
  return DATE_TIME.format(ms);
}

export function formatDateTimeMillis(ms: number): string {
  return DATE_TIME_MILLIS.format(ms);
}

export function formatTime(ms: number): string {
  return TIME.format(ms);
}

export function formatDuration(ms: number): string {
  if (ms >= 3_600_000) {
    return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  }
  if (ms >= 60_000) {
    return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  }
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;

  return `${Math.round(ms)}ms`;
}
