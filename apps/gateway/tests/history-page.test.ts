import { expect, test } from "bun:test";
import { historyPage } from "../src/history-page.ts";
import { isObservabilityClientMessage } from "../../../packages/broods/src/observability-contracts.ts";

test("pages preserve timestamp groups without omissions", (): void => {
  const all = [10, 9, 9, 8, 7, 6];
  const seen: number[] = [];
  let to = 11;
  while (true) {
    const candidates = all.filter((at): boolean => at < to).slice(0, 4);
    const page = historyPage(candidates, 3, (at): number => at);
    seen.push(...page.rows);
    if (page.nextTo === undefined) break;
    expect(page.nextTo).toBeLessThan(to);
    to = page.nextTo;
  }
  expect(seen).toEqual(all);
});

test("a saturated timestamp is an explicit error rather than a skipped group", (): void => {
  expect(() => historyPage([10, 10, 10], 2, (at): number => at)).toThrow(
    "share a timestamp",
  );
});

test("history bounds reject reversed, fractional, negative and excessive ranges", (): void => {
  const message = {
    type: "subscribe",
    stream: "logs",
    historyOnly: true,
    backfill: 50,
  };
  expect(
    isObservabilityClientMessage({
      ...message,
      range: { from: 0, to: 3600000 },
    }),
  ).toBe(true);
  for (const range of [
    null,
    { from: 2, to: 1 },
    { from: -1, to: 1 },
    { from: 0.1, to: 1 },
    { from: 0, to: 31 * 86400000 },
  ]) {
    expect(isObservabilityClientMessage({ ...message, range: range })).toBe(
      false,
    );
  }
});
