import { expect, test } from "bun:test";
import {
  bucketStartsAcrossRange,
  formatAxisNumber,
  niceTicks,
  perTaskAverages,
  resampleRows,
  tokenParts,
} from "../app/lib/usageChart";

test("per-task averages divide each bin by its own tasks, 0 when it had none", () => {
  const bins = [
    { invocations: 4, modelCalls: 14, totalTokens: 40_000 },
    { invocations: 0, modelCalls: 0, totalTokens: 0 },
    { invocations: 1, modelCalls: 2, totalTokens: 500 },
  ];

  expect(perTaskAverages(bins, [0.4, 0, 0.01])).toEqual({
    cost: [0.1, 0, 0.01],
    calls: [3.5, 0, 2],
    tokens: [10_000, 0, 500],
  });
});

test("token parts stack to input + output without double counting", () => {
  const parts = tokenParts({
    inputTokens: 800,
    outputTokens: 200,
    reasoningTokens: 80,
    cachedInputTokens: 500,
    cacheWriteTokens: 100,
  });

  expect(parts).toEqual({
    uncachedInput: 200,
    cacheRead: 500,
    cacheWrite: 100,
    textOutput: 120,
    reasoning: 80,
  });
  expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBe(1000);
});

test("ticks are round and reach the max", () => {
  expect(niceTicks(9300, 4)).toEqual([0, 2500, 5000, 7500, 10000]);
  expect(niceTicks(400, 4)).toEqual([0, 100, 200, 300, 400]);
  expect(niceTicks(0, 4)).toEqual([0, 1]);
  expect(formatAxisNumber(500_000)).toBe("500K");
});

test("range bins line up with the server's bins, even when the range is not whole bins", () => {
  const week = 7 * 24 * 60 * 60;
  const starts = bucketStartsAcrossRange(
    week,
    365 * 24 * 60 * 60,
    Date.UTC(2026, 8, 24, 14),
  );
  const weekMs = week * 1000;

  expect(starts.every((t) => t % weekMs === 0)).toBe(true);
  expect(starts).toHaveLength(53);
});

test("resampling keeps the endpoints and interpolates between them", () => {
  expect(resampleRows([[0], [10]], 3)).toEqual([[0], [5], [10]]);
  expect(resampleRows([[4, 2]], 1)).toEqual([[4, 2]]);
});
