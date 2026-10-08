/**
 * The search box grammar every list shares: free words plus `field:value`
 * tokens, and the time range presets the toolbar offers next to it.
 */

export const RANGE_PRESETS = [
  { id: "1h", ms: 60 * 60 * 1000 },
  { id: "3h", ms: 3 * 60 * 60 * 1000 },
  { id: "1d", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number]["id"];

/** Bins the volume strip draws across a time range. */
export const VOLUME_BIN_COUNT = 48;

/** Query input split into its tokens and the rejoined, lowercased free words. */
export interface Query<F extends string> {
  fields: Array<{ field: F; value: string }>;
  text: string;
}

/** One bar of the volume strip: entries in the bin, and how many of them failed or warned. */
export interface VolumeBin {
  start: number;
  total: number;
  error: number;
  warn: number;
}

/** A from/to window picked on the strip, in epoch ms. */
export interface TimeWindow {
  from: number;
  to: number;
}

/**
 * Splits the search box into `field:value` tokens and free words. An unknown
 * field is a free word; a known field with no value yet is dropped while typing.
 */
export function parseQuery<F extends string>(
  input: string,
  fields: readonly F[],
): Query<F> {
  const parsed: Query<F> = { fields: [], text: "" };
  const words: string[] = [];
  for (const token of input.trim().toLowerCase().split(/\s+/)) {
    if (!token) continue;
    const field = tokenField(token, fields);
    if (field !== null) {
      const value = token.slice(field.length + 1);
      if (value) parsed.fields.push({ field: field, value: value });
      continue;
    }
    words.push(token);
  }
  parsed.text = words.join(" ");

  return parsed;
}

/** The window a list filters by: the drag-picked one, else the whole preset up to now. */
export function effectiveWindow(
  selection: TimeWindow | null,
  preset: RangePreset,
  now: number,
): TimeWindow {
  return selection ?? { from: now - rangeMs(preset), to: now };
}

/** The ms the preset reaches back from now. */
export function rangeMs(preset: RangePreset): number {
  return RANGE_PRESETS.find((range) => range.id === preset)?.ms ?? 0;
}

/**
 * The search box as the input shows it: every finished `field:value` token
 * (one followed by a space) is a chip, and whatever follows the last chip is
 * the text still being typed. The chips keep their typed case.
 */
export function splitQueryChips(
  input: string,
  fields: readonly string[],
): { chips: string[]; text: string } {
  const chips: string[] = [];
  const rest: string[] = [];
  const parts = input.split(" ");
  const last = parts.length - 1;
  parts.forEach((part, index) => {
    const isChip =
      index < last &&
      tokenField(part.toLowerCase(), fields) !== null &&
      part.indexOf(":") < part.length - 1;
    if (isChip && rest.length === 0) {
      chips.push(part);
    } else {
      rest.push(part);
    }
  });

  return { chips: chips, text: rest.join(" ") };
}

/**
 * Counts timestamps into equal bins across the window, newest bin last.
 * `severity` says which count a timestamp joins besides the total.
 */
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
    if (point.ts < window.from || point.ts > window.to) continue;
    const bin =
      bins[Math.min(count - 1, Math.floor((point.ts - window.from) / binMs))];
    bin.total += 1;
    if (point.severity === "error") bin.error += 1;
    if (point.severity === "warn") bin.warn += 1;
  }

  return bins;
}

/** The known field a lowercased token names, or null for a free word. */
function tokenField<F extends string>(
  token: string,
  fields: readonly F[],
): F | null {
  const colon = token.indexOf(":");
  if (colon <= 0) return null;
  const field = token.slice(0, colon);

  return fields.find((known) => known === field) ?? null;
}
