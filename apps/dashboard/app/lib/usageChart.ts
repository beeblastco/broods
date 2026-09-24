import { formatNumber } from "./formatNumber";

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

/** Axis label for a round tick: formatNumber without the trailing ".0". */
export function formatAxisNumber(n: number): string {
  return formatNumber(n).replace(".0", "");
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
