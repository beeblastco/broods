export class RateLimiter {
  #limit: number;
  #windowMs: number;
  #windows = new Map<string, { start: number; count: number }>();

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  get limit(): number {
    return this.#limit;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const window = this.#windows.get(key);

    if (!window || now - window.start >= this.#windowMs) {
      if (this.#windows.size > 10_000) this.#removeExpiredWindows(now);
      this.#windows.set(key, { start: now, count: 1 });

      return true;
    }

    window.count += 1;

    return window.count <= this.#limit;
  }

  blocked(key: string): boolean {
    const window = this.#windows.get(key);
    if (!window || Date.now() - window.start >= this.#windowMs) return false;

    return window.count >= this.#limit;
  }

  retryAfterSeconds(key: string): number {
    const window = this.#windows.get(key);
    if (!window) return 0;
    const remainingMs = this.#windowMs - (Date.now() - window.start);

    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  }

  #removeExpiredWindows(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) this.#windows.delete(key);
    }
  }
}
