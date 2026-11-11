import { expect, test } from "bun:test";
import { IdentifyBudget } from "../../../../apps/discord-forwarder/src/identify-budget.ts";

test("a budget counts down per token and recovers when its window ages out", (): void => {
  const budget = new IdentifyBudget(2, 1_000);

  expect(budget.consume("a", 0)).toBe(true);
  expect(budget.consume("a", 10)).toBe(true);
  expect(budget.consume("a", 20)).toBe(false);
  expect(budget.remaining("a", 20)).toBe(0);
  expect(budget.retryAt("a", 20)).toBe(1_000);
  expect(budget.consume("b", 20)).toBe(true);
  expect(budget.remaining("b", 20)).toBe(1);
  expect(budget.consume("a", 1_001)).toBe(true);
});

test("the default window is a day", (): void => {
  const budget = new IdentifyBudget(1);

  expect(budget.consume("t", 0)).toBe(true);
  expect(budget.retryAt("t", 1)).toBe(24 * 60 * 60 * 1_000);
  expect(budget.consume("t", 24 * 60 * 60 * 1_000 + 1)).toBe(true);
});
