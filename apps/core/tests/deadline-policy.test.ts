/**
 * The run's deadline policy: when a step boundary near the deadline yields
 * the worker slot, when it winds down instead, and what withdraws a yield.
 */

import { describe, expect, it } from "bun:test";
import { AGENT_MAX_TURN_UNLIMITED } from "../src/shared/domain/agent-config.ts";
import {
  createDeadlinePolicy,
  type DeadlinePolicy,
  type DeadlinePolicyOptions,
} from "../src/harness/deadline-policy.ts";

const policy = ({
  nowMs = 0,
  ...overrides
}: Partial<DeadlinePolicyOptions> & { nowMs?: number } = {}): DeadlinePolicy =>
  createDeadlinePolicy({
    deadlineMs: 10_000,
    canYield: false,
    windDownMs: 3_000,
    maxTurn: 30,
    now: (): number => nowMs,
    ...overrides,
  });

describe("createDeadlinePolicy", () => {
  it("never stops a run with no deadline", () => {
    const deadline = policy({ deadlineMs: undefined, nowMs: 1_000_000 });

    expect(deadline.shouldStop(1, 0)).toBe(false);
    expect(deadline.isWindingDown()).toBe(false);
    expect(deadline.hasYielded()).toBe(false);
  });

  it("takes normal steps until the wind-down line", () => {
    const deadline = policy({ nowMs: 6_999 });

    expect(deadline.shouldStop(1, 0)).toBe(false);
    expect(deadline.isWindingDown()).toBe(false);
  });

  it("winds down windDownMs before the deadline when it may not yield", () => {
    const deadline = policy({ nowMs: 7_000 });

    // Winding down is not a stop: the next step is the tool-free answer.
    expect(deadline.shouldStop(1, 0)).toBe(false);
    expect(deadline.isWindingDown()).toBe(true);
    expect(deadline.hasYielded()).toBe(false);
  });

  it("still winds down once past the deadline", () => {
    const deadline = policy({ nowMs: 20_000 });

    expect(deadline.shouldStop(1, 0)).toBe(false);
    expect(deadline.isWindingDown()).toBe(true);
  });

  it("yields the slot instead when the pool runs the conversation on", () => {
    const deadline = policy({ canYield: true, nowMs: 7_000 });

    expect(deadline.shouldStop(1, 0)).toBe(true);
    expect(deadline.hasYielded()).toBe(true);
    expect(deadline.isWindingDown()).toBe(false);
  });

  it("does not yield at the step cap", () => {
    // A next pass would start a fresh count, so the cap would never bind; the
    // step-count rule stops the run at this boundary instead.
    const deadline = policy({ canYield: true, maxTurn: 2, nowMs: 7_000 });

    expect(deadline.shouldStop(2, 0)).toBe(false);
    expect(deadline.hasYielded()).toBe(false);
  });

  it("yields under an unlimited step cap", () => {
    const deadline = policy({
      canYield: true,
      maxTurn: AGENT_MAX_TURN_UNLIMITED,
      nowMs: 7_000,
    });

    expect(deadline.shouldStop(500, 0)).toBe(true);
  });

  it("leaves a pending question to its own stop rule", () => {
    const deadline = policy({ canYield: true, nowMs: 7_000 });

    expect(deadline.shouldStop(1, 1)).toBe(false);
    expect(deadline.hasYielded()).toBe(false);
    expect(deadline.isWindingDown()).toBe(false);
  });

  it("withdraws a yield when a step waits on an approval", () => {
    const deadline = policy({ canYield: true, nowMs: 7_000 });
    expect(deadline.shouldStop(1, 0)).toBe(true);

    deadline.withdrawYield();

    expect(deadline.hasYielded()).toBe(false);
  });
});
