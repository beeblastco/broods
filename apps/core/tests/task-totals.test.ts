/**
 * The run's task token totals: how finished steps sum into the usage row and
 * root span numbers, and when the turn total from onEnd replaces that sum.
 */

import { describe, expect, it } from "bun:test";
import type { LanguageModelUsage } from "ai";
import { createTaskTotals } from "../src/harness/usage-metering.ts";

const stepUsage = (
  input: number,
  output: number,
  details: { cached?: number; cacheWrite?: number; reasoning?: number } = {},
): LanguageModelUsage => ({
  inputTokens: input,
  inputTokenDetails: {
    noCacheTokens: undefined,
    cacheReadTokens: details.cached,
    cacheWriteTokens: details.cacheWrite,
  },
  outputTokens: output,
  outputTokenDetails: {
    textTokens: undefined,
    reasoningTokens: details.reasoning,
  },
  totalTokens: input + output,
});

describe("createTaskTotals", () => {
  it("starts empty", () => {
    const totals = createTaskTotals();

    expect(totals.usage()).toBeUndefined();
    expect(totals.steps()).toBe(0);
    expect(totals.cacheWriteTokens()).toBe(0);
  });

  it("sums input, output, cached and reasoning tokens across steps", () => {
    const totals = createTaskTotals();
    totals.addStep(0, stepUsage(10, 5, { cached: 4, reasoning: 2 }), 0);
    totals.addStep(1, stepUsage(20, 7, { cached: 6, reasoning: 3 }), 0);

    expect(totals.usage()).toEqual({
      inputTokens: 30,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
      },
      outputTokens: 12,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: 5 },
      totalTokens: 42,
    });
  });

  it("counts a step with no usage as zero tokens", () => {
    const totals = createTaskTotals();
    totals.addStep(0, stepUsage(10, 5), 0);
    totals.addStep(1, undefined, 0);

    expect(totals.usage()?.totalTokens).toBe(15);
    expect(totals.steps()).toBe(2);
  });

  it("accumulates the metered cache-write tokens separately from the usage shape", () => {
    const totals = createTaskTotals();
    // The usage shape carries the count on step 0; step 1 only had it in
    // providerMetadata, so the caller metered it and the shape reads 0.
    totals.addStep(0, stepUsage(10, 5, { cacheWrite: 100 }), 100);
    totals.addStep(1, stepUsage(10, 5), 40);

    expect(totals.cacheWriteTokens()).toBe(140);
    expect(totals.usage()?.inputTokenDetails?.cacheWriteTokens).toBe(100);
  });

  it("reports the step count as the last finished step number plus one", () => {
    const totals = createTaskTotals();
    totals.addStep(0, stepUsage(1, 1), 0);
    expect(totals.steps()).toBe(1);
    totals.addStep(1, stepUsage(1, 1), 0);
    expect(totals.steps()).toBe(2);
  });

  it("lets the turn total from onEnd replace the step sum", () => {
    const totals = createTaskTotals();
    totals.addStep(0, stepUsage(10, 5), 0);
    totals.addStep(1, stepUsage(10, 5), 0);
    // A harness counts calls no step reported, so the turn total is larger.
    totals.finish(stepUsage(50, 20), 3);

    expect(totals.usage()).toEqual(stepUsage(50, 20));
    expect(totals.steps()).toBe(3);
  });

  it("keeps the step sum when onEnd reports an empty turn total", () => {
    const totals = createTaskTotals();
    totals.addStep(0, stepUsage(10, 5), 7);
    // A stop thrown from prepareStep leaves the turn total empty.
    totals.finish(stepUsage(0, 0), 1);

    expect(totals.usage()?.totalTokens).toBe(15);
    expect(totals.steps()).toBe(1);
    expect(totals.cacheWriteTokens()).toBe(7);
  });
});
