/**
 * Reconnect pacing. Exponential with a hard ceiling, because the ceiling is what
 * bounds how much of Discord's per-token IDENTIFY allowance a permanently
 * failing socket can spend in a day. Jitter only ever shortens the wait, so the
 * ceiling stays a real ceiling, and keeps many tokens from re-dialling in
 * lockstep after a Discord-side outage.
 */

/** First retry, and the floor every later one is measured against. */
const BASE_MS = 1_000;
const JITTER_FRACTION = 0.2;

export function backoffDelayMs(
  attempt: number,
  ceilingMs: number,
  random: () => number = Math.random,
): number {
  const growth = BASE_MS * 2 ** Math.max(0, attempt);
  const capped = Math.min(ceilingMs, growth);
  const jitter = capped * JITTER_FRACTION * random();

  return Math.max(BASE_MS, Math.round(capped - jitter));
}
