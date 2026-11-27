import { afterEach, expect, test } from "bun:test";
import {
  booleanEnv,
  getHarnessPublicUrl,
} from "../../../../apps/core/src/shared/env.ts";
import {
  EMPTY_USAGE,
  meterCostByCategoryEur,
  meterCostEur,
  UNIT_RATES_EUR,
  USAGE_CATEGORY,
} from "../../../../packages/convex/model/pricing.ts";

const originalPublicUrl = process.env.PUBLIC_BASE_URL;
const variable = "FORMAL_AGENT8A_BOOLEAN";

afterEach((): void => {
  delete process.env[variable];
  if (originalPublicUrl === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = originalPublicUrl;
});

test.each([
  ["1", true],
  [" TRUE ", true],
  ["yes", true],
  ["On", true],
  ["0", false],
  [" FALSE ", false],
  ["no", false],
  ["Off", false],
] as const)("boolean environment %p", (value, expected): void => {
  process.env[variable] = value;

  expect(booleanEnv(variable)).toBe(expected);
});

test.each([true, false])("missing boolean defaults to %p", (fallback): void => {
  delete process.env[variable];

  expect(booleanEnv(variable, fallback)).toBe(fallback);
});

test.each(["perhaps", "  ", "2"])("invalid boolean %p", (value): void => {
  process.env[variable] = value;

  expect((): boolean => booleanEnv(variable)).toThrow(
    `${variable} must be a boolean-like value`,
  );
});

test.each([
  [undefined, undefined],
  ["", undefined],
  ["https://example.test///", "https://example.test"],
  ["https://example.test/path", "https://example.test/path"],
] as const)("public harness URL %p", (value, expected): void => {
  if (value === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = value;

  expect(getHarnessPublicUrl()).toBe(expected);
});

test.each(Object.keys(UNIT_RATES_EUR) as (keyof typeof UNIT_RATES_EUR)[])(
  "prices one unit of %p in its category",
  (key): void => {
    const usage = { ...EMPTY_USAGE, [key]: 1 };
    const expected = {
      sandboxes: 0,
      hostedMcp: 0,
      storage: 0,
      egress: 0,
      [USAGE_CATEGORY[key]]: UNIT_RATES_EUR[key],
    };

    expect(meterCostByCategoryEur(usage)).toEqual(expected);
    expect(meterCostEur(usage)).toBe(UNIT_RATES_EUR[key]);
  },
);

test("empty usage costs zero", (): void => {
  expect(meterCostByCategoryEur(EMPTY_USAGE)).toEqual({
    sandboxes: 0,
    hostedMcp: 0,
    storage: 0,
    egress: 0,
  });
  expect(meterCostEur(EMPTY_USAGE)).toBe(0);
});
