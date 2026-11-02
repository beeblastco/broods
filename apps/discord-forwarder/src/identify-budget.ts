const WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * Past 1000 IDENTIFYs per token per 24h Discord resets the bot token. A restart forgets this
 * count, so the backoff ceiling (300s: under 300 a day) is the primary bound, this the backstop.
 */
export class IdentifyBudget {
  private readonly limit: number;
  private readonly stamps = new Map<string, number[]>();
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number = WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  consume(token: string, now: number = Date.now()): boolean {
    const live = this.live(token, now);
    const allowed = live.length < this.limit;
    if (allowed) live.push(now);
    // A removed token never calls again, so its key goes once its newest (last) stamp ages out.
    const cutoff = now - this.windowMs;
    for (const [key, stamps] of this.stamps) {
      if ((stamps.at(-1) ?? cutoff) <= cutoff) this.stamps.delete(key);
    }
    // Written back even on refusal: `live` is pruned, which is how an exhausted token recovers.
    this.stamps.set(token, live);

    return allowed;
  }

  remaining(token: string, now: number = Date.now()): number {
    return Math.max(0, this.limit - this.live(token, now).length);
  }

  retryAt(token: string, now: number = Date.now()): number | null {
    const live = this.live(token, now);
    const oldest = live[0];
    if (live.length < this.limit || oldest === undefined) return null;

    return oldest + this.windowMs;
  }

  private live(token: string, now: number): number[] {
    const cutoff = now - this.windowMs;

    return (this.stamps.get(token) ?? []).filter(
      (stamp): boolean => stamp > cutoff,
    );
  }
}
