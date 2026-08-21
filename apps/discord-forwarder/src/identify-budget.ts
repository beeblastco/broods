/**
 * Per-token IDENTIFY accounting.
 *
 * Discord allows 1000 IDENTIFY calls per bot token per 24 hours. Past that it
 * terminates every session for the app, **resets the bot token**, and emails the
 * owner. One crash-looping process holding many tenants' tokens can therefore
 * get all of them reset, so the forwarder counts its own IDENTIFYs and stops
 * loudly rather than dialling into a reset.
 *
 * The counter is in-process, so a pod restart forgets it. That is why the
 * backoff ceiling — not this class — is the primary defence: at a 300s ceiling a
 * permanently failing socket spends under 300 IDENTIFYs a day even if it never
 * gets to remember anything. This is the belt to that pair of braces.
 */

/** Discord's own accounting period. Not a preference: another value is wrong. */
const WINDOW_MS = 24 * 60 * 60 * 1_000;

export class IdentifyBudget {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly stamps = new Map<string, number[]>();

  constructor(limit: number, windowMs: number = WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /**
   * Records one IDENTIFY for `token` and returns true, or returns false when the
   * window is full and the caller must not dial.
   */
  consume(token: string, now: number = Date.now()): boolean {
    const live = this.live(token, now);
    const allowed = live.length < this.limit;
    if (allowed) live.push(now);
    // Stored either way: `live` is pruned, so writing it back on refusal is what
    // lets an exhausted token recover once its oldest stamps age out.
    this.stamps.set(token, live);

    return allowed;
  }

  /** How many IDENTIFYs `token` has left in the current window. */
  remaining(token: string, now: number = Date.now()): number {
    return Math.max(0, this.limit - this.live(token, now).length);
  }

  /**
   * When the oldest recorded IDENTIFY falls out of the window, so an exhausted
   * socket can schedule its retry instead of polling. Null when there is room now.
   */
  retryAt(token: string, now: number = Date.now()): number | null {
    const live = this.live(token, now);
    const oldest = live[0];
    if (live.length < this.limit || oldest === undefined) return null;

    return oldest + this.windowMs;
  }

  private live(token: string, now: number): number[] {
    const cutoff = now - this.windowMs;

    return (this.stamps.get(token) ?? []).filter((stamp) => stamp > cutoff);
  }
}
