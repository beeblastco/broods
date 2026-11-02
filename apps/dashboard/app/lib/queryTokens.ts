export const RANGE_PRESETS = [
  { id: "1h", ms: 60 * 60 * 1000 },
  { id: "3h", ms: 3 * 60 * 60 * 1000 },
  { id: "1d", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number]["id"];

export const VOLUME_BIN_COUNT = 48;

export interface Query<F extends string> {
  fields: Array<{ field: F; value: string }>;
  text: string;
}

export interface VolumeBin {
  start: number;
  total: number;
  error: number;
  warn: number;
}

export interface TimeWindow {
  from: number;
  to: number;
}

// An unknown field is a free word; a value with spaces is quoted: `status:"not connected yet"`.
export function parseQuery<F extends string>(
  input: string,
  fields: readonly F[],
): Query<F> {
  const parsed: Query<F> = { fields: [], text: "" };
  const words: string[] = [];
  for (const token of splitTokens(input.toLowerCase())) {
    const field = tokenField(token, fields);
    if (field !== null) {
      const value = unquote(token.slice(field.length + 1));
      if (value) parsed.fields.push({ field: field, value: value });
      continue;
    }
    words.push(token);
  }
  parsed.text = words.join(" ");

  return parsed;
}

export function splitTokens(input: string): string[] {
  return input.match(/[^\s"]*"[^"]*"?[^\s"]*|[^\s"]+/g) ?? [];
}

export function chipFor(field: string, value: string): string {
  return /\s/.test(value) ? `${field}:"${value}"` : `${field}:${value}`;
}

export function unquote(value: string): string {
  return value.startsWith('"') ? value.slice(1).replace(/"$/, "") : value;
}

// Open ended, so a line streaming in between clock ticks is not held back by a stale `now`.
export function effectiveWindow(
  selection: TimeWindow | null,
  preset: RangePreset,
  now: number,
): TimeWindow {
  return (
    selection ?? { from: now - rangeMs(preset), to: Number.POSITIVE_INFINITY }
  );
}

export function rangeMs(preset: RangePreset): number {
  return RANGE_PRESETS.find((range) => range.id === preset)?.ms ?? 0;
}

// A token becomes a chip once a space follows it; chips keep their typed case.
export function splitQueryChips(
  input: string,
  fields: readonly string[],
): { chips: string[]; text: string } {
  const chips: string[] = [];
  const tokens = splitTokens(input);
  const finished = /\s$/.test(input);
  let rest = input;
  for (const [index, token] of tokens.entries()) {
    const isChip =
      (index < tokens.length - 1 || finished) &&
      tokenField(token.toLowerCase(), fields) !== null &&
      unquote(token.slice(token.indexOf(":") + 1)) !== "";
    if (!isChip) break;
    chips.push(token);
    rest = rest.slice(rest.indexOf(token) + token.length).replace(/^\s+/, "");
  }

  return { chips: chips, text: rest };
}

// A point past the window's end joins the last bin, so a line streamed in late still shows.
export function volumeBins(
  points: Array<{ ts: number; severity: "error" | "warn" | "none" }>,
  window: TimeWindow,
  count = VOLUME_BIN_COUNT,
): VolumeBin[] {
  const span = Math.max(1, window.to - window.from);
  const binMs = span / count;
  const bins: VolumeBin[] = Array.from({ length: count }, (_, index) => ({
    start: window.from + index * binMs,
    total: 0,
    error: 0,
    warn: 0,
  }));
  for (const point of points) {
    if (point.ts < window.from) continue;
    const bin =
      bins[Math.min(count - 1, Math.floor((point.ts - window.from) / binMs))];
    bin.total += 1;
    if (point.severity === "error") bin.error += 1;
    if (point.severity === "warn") bin.warn += 1;
  }

  return bins;
}

function tokenField<F extends string>(
  token: string,
  fields: readonly F[],
): F | null {
  const colon = token.indexOf(":");
  if (colon <= 0) return null;
  const field = token.slice(0, colon);

  return fields.find((known) => known === field) ?? null;
}
