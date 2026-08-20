/**
 * Reconnect pacing. Exponential with a hard ceiling, because the ceiling is what
 * bounds how much of Discord's per-token IDENTIFY allowance a permanently
 * failing socket can spend in a day. Jitter only ever shortens the wait, so the
 * ceiling stays a real ceiling, and keeps many tokens from re-dialling in
 * lockstep after a Discord-side outage.
 */

const JITTER_FRACTION = 0.2;

export function backoffDelayMs(
  attempt: number,
  baseMs: number,
  ceilingMs: number,
  random: () => number = Math.random,
): number {
  const growth = baseMs * 2 ** Math.max(0, attempt);
  const capped = Math.min(ceilingMs, growth);
  const jitter = capped * JITTER_FRACTION * random();

  return Math.max(baseMs, Math.round(capped - jitter));
}
