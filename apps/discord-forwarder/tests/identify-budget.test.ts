import { describe, expect, it } from "bun:test";
import { IdentifyBudget } from "../src/identify-budget.ts";

describe("identify budget", () => {
  it("stops consuming once the window is full", () => {
    const budget = new IdentifyBudget(3, 60_000);
    const start = 1_000_000;

    expect(budget.consume("token", start)).toBe(true);
    expect(budget.consume("token", start + 1)).toBe(true);
    expect(budget.consume("token", start + 2)).toBe(true);
    expect(budget.consume("token", start + 3)).toBe(false);
    expect(budget.remaining("token", start + 3)).toBe(0);
  });

  it("counts each token separately", () => {
    const budget = new IdentifyBudget(1, 60_000);
    const start = 1_000_000;

    expect(budget.consume("first", start)).toBe(true);
    expect(budget.consume("second", start)).toBe(true);
    expect(budget.consume("first", start)).toBe(false);
  });

  it("frees the oldest slot when it leaves the window", () => {
    const budget = new IdentifyBudget(2, 60_000);
    const start = 1_000_000;
    budget.consume("token", start);
    budget.consume("token", start + 10_000);

    expect(budget.consume("token", start + 20_000)).toBe(false);
    expect(budget.consume("token", start + 61_000)).toBe(true);
  });

  it("reports when an exhausted token has room again", () => {
    const budget = new IdentifyBudget(1, 60_000);
    const start = 1_000_000;
    budget.consume("token", start);

    expect(budget.consume("token", start + 1)).toBe(false);
    expect(budget.retryAt("token", start + 1)).toBe(start + 60_000);
    // `GatewaySocket.reserveIdentify` re-dials at exactly this instant, so the
    // boundary has to be inclusive or that wake-up is refused and the socket
    // parks for another whole window.
    expect(budget.consume("token", start + 60_000)).toBe(true);
  });

  it("has no retry time while the window has room", () => {
    const budget = new IdentifyBudget(2, 60_000);
    budget.consume("token", 1_000_000);

    expect(budget.retryAt("token", 1_000_001)).toBeNull();
  });
});
