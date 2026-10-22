import { formatNumber } from "./formatNumber";

/** Colors for a chart's series in order, such as models or projects. */
export const SERIES_COLORS = [
  "var(--color-usage-model-1)",
  "var(--color-usage-model-2)",
  "var(--color-usage-model-3)",
  "var(--color-usage-model-4)",
  "var(--color-usage-model-5)",
  "var(--color-usage-model-6)",
];

/** Token counts as the AI SDK reports them: input and output are totals. */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

/**
 * Non-overlapping token parts that add up to input + output. The SDK's
 * `inputTokens` already includes cache reads and writes, and `outputTokens`
 * already includes reasoning, so stacking the raw counts double counts them.
 */
export interface TokenParts {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  textOutput: number;
  reasoning: number;
}

/** One value per bin for each per-task average the Usage tab charts; null for a bin with no tasks. */
export interface PerTaskAverages {
  cost: Array<number | null>;
  calls: Array<number | null>;
  tokens: Array<number | null>;
}

/**
 * Start of every bin in the range ending at `now`, floored to whole bins the
 * way the server floors `bucketStart`, so filled bins meet the data bins even
 * when the range is not a whole number of bins (a year of weeks).
 */
export function bucketStartsAcrossRange(
  binSeconds: number,
  rangeSeconds: number,
  now: number,
): number[] {
  const binMs = binSeconds * 1000;
  const endMs = Math.ceil(now / binMs) * binMs;
  const count = Math.ceil(rangeSeconds / binSeconds);

  return Array.from({ length: count }, (_, i) => endMs - (count - i) * binMs);
}

/**
 * Each bin's cost, model calls and tokens per task: the bin's total divided by
 * the tasks that finished in it, null for a bin with none so a chart leaves a
 * gap there. The window's average is the window's totals over its tasks, not
 * the mean of these.
 */
export function perTaskAverages(
  bins: Array<{ invocations: number; modelCalls: number; totalTokens: number }>,
  binCosts: number[],
): PerTaskAverages {
  const per = (bin: (typeof bins)[number], total: number): number | null =>
    bin.invocations > 0 ? total / bin.invocations : null;

  return {
    cost: bins.map((bin, i) => per(bin, binCosts[i] ?? 0)),
    calls: bins.map((bin) => per(bin, bin.modelCalls)),
    tokens: bins.map((bin) => per(bin, bin.totalTokens)),
  };
}

/** Axis label for a round tick: formatNumber without the trailing ".0". */
export function formatAxisNumber(n: number): string {
  return formatNumber(n).replace(".0", "");
}

/**
 * The runs of known values, each point as its index and value, so a line
 * chart draws one segment per run and leaves a gap at every null.
 */
export function knownRuns(
  values: Array<number | null>,
): Array<Array<[number, number]>> {
  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  values.forEach((value, i) => {
    if (value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else {
      run.push([i, value]);
    }
  });
  if (run.length > 0) runs.push(run);

  return runs;
}

/**
 * SVG path through `points` with monotone cubic interpolation, so a smooth
 * curve never overshoots below zero or above a peak.
 */
export function monotonePath(points: Array<[number, number]>): string {
  const n = points.length;
  if (n === 0) return "";
  if (n === 1) return `M${points[0][0]},${points[0][1]}`;
  const dx: number[] = [];
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1][0] - points[i][0]);
    slopes.push((points[i + 1][1] - points[i][1]) / dx[i]);
  }
  const tangents = [slopes[0]];
  for (let i = 1; i < n - 1; i++) {
    const a = slopes[i - 1];
    const b = slopes[i];
    tangents.push(
      a * b <= 0
        ? 0
        : (3 * (dx[i - 1] + dx[i])) /
            ((2 * dx[i] + dx[i - 1]) / a + (dx[i] + 2 * dx[i - 1]) / b),
    );
  }
  tangents.push(slopes[n - 2]);
  let d = `M${round(points[0][0])},${round(points[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    d += `C${round(x0 + h)},${round(y0 + h * tangents[i])} ${round(x1 - h)},${round(y1 - h * tangents[i + 1])} ${round(x1)},${round(y1)}`;
  }

  return d;
}

/** Evenly spaced round ticks from 0 to at least `max`, about `count` steps. */
export function niceTicks(max: number, count: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / magnitude;
  const step =
    (fraction <= 1
      ? 1
      : fraction <= 2
        ? 2
        : fraction <= 2.5
          ? 2.5
          : fraction <= 5
            ? 5
            : 10) * magnitude;
  const ticks = [0];
  while (ticks[ticks.length - 1] < max) {
    ticks.push(ticks[ticks.length - 1] + step);
  }

  return ticks;
}

/**
 * Stretches `rows` to `n` rows by linear interpolation, so a chart can morph
 * from one range's bins into another range's bin count.
 */
export function resampleRows(rows: number[][], n: number): number[][] {
  if (rows.length === n || rows.length === 0) return rows;
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : (i * (rows.length - 1)) / (n - 1);
    const lo = Math.floor(x);
    const hi = Math.min(lo + 1, rows.length - 1);
    const f = x - lo;
    out.push(rows[lo].map((v, k) => v + ((rows[hi][k] ?? 0) - v) * f));
  }

  return out;
}

/** Splits SDK token totals into parts that stack to exactly input + output. */
export function tokenParts(counts: TokenCounts): TokenParts {
  return {
    uncachedInput: Math.max(
      0,
      counts.inputTokens - counts.cachedInputTokens - counts.cacheWriteTokens,
    ),
    cacheRead: counts.cachedInputTokens,
    cacheWrite: counts.cacheWriteTokens,
    textOutput: Math.max(0, counts.outputTokens - counts.reasoningTokens),
    reasoning: counts.reasoningTokens,
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
