import { expect, test } from "bun:test";
import {
  formatAxisNumber,
  niceTicks,
  resampleRows,
  tokenParts,
} from "../app/lib/usageChart";

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

test("resampling keeps the endpoints and interpolates between them", () => {
  expect(resampleRows([[0], [10]], 3)).toEqual([[0], [5], [10]]);
  expect(resampleRows([[4, 2]], 1)).toEqual([[4, 2]]);
});
