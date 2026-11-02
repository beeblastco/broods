// The ceiling bounds the IDENTIFY allowance a failing socket can spend in a day. Jitter only
// shortens the wait, so the ceiling holds and tokens do not re-dial in lockstep after an outage.

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

  // No floor at BASE_MS: it would erase attempt 0's jitter, the very lockstep this avoids.
  return Math.round(capped - jitter);
}
