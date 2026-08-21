import { describe, expect, it } from "bun:test";
import { backoffDelayMs } from "../src/backoff.ts";

const NO_JITTER = (): number => 0;

describe("backoff", () => {
  it("grows exponentially from the base", () => {
    expect(backoffDelayMs(0, 300_000, NO_JITTER)).toBe(1_000);
    expect(backoffDelayMs(1, 300_000, NO_JITTER)).toBe(2_000);
    expect(backoffDelayMs(4, 300_000, NO_JITTER)).toBe(16_000);
  });

  it("never exceeds the ceiling however far the attempts run", () => {
    for (const random of [0, 0.5, 1]) {
      const delay = backoffDelayMs(30, 300_000, () => random);
      expect(delay).toBeLessThanOrEqual(300_000);
      expect(delay).toBeGreaterThanOrEqual(240_000);
    }
  });

  it("jitters the first retry too, so tokens do not re-dial in lockstep", () => {
    expect(backoffDelayMs(0, 300_000, () => 1)).toBe(800);
  });

  it("only ever shortens a delay, never lengthens it", () => {
    for (const attempt of [0, 1, 7]) {
      const undelayed = backoffDelayMs(attempt, 300_000, NO_JITTER);
      expect(backoffDelayMs(attempt, 300_000, () => 1)).toBeLessThan(undelayed);
      expect(backoffDelayMs(attempt, 300_000, () => 0.5)).toBeLessThan(
        undelayed,
      );
    }
  });
});
