import { describe, expect, it } from "bun:test";
import { backoffDelayMs } from "../src/backoff.ts";

const NO_JITTER = (): number => 0;

describe("backoff", () => {
  it("grows exponentially from the base", () => {
    expect(backoffDelayMs(0, 1_000, 300_000, NO_JITTER)).toBe(1_000);
    expect(backoffDelayMs(1, 1_000, 300_000, NO_JITTER)).toBe(2_000);
    expect(backoffDelayMs(4, 1_000, 300_000, NO_JITTER)).toBe(16_000);
  });

  it("never exceeds the ceiling however far the attempts run", () => {
    for (const random of [0, 0.5, 1]) {
      const delay = backoffDelayMs(30, 1_000, 300_000, () => random);
      expect(delay).toBeLessThanOrEqual(300_000);
      expect(delay).toBeGreaterThanOrEqual(240_000);
    }
  });

  it("never returns less than the base delay", () => {
    expect(backoffDelayMs(0, 1_000, 300_000, () => 1)).toBe(1_000);
  });
});
