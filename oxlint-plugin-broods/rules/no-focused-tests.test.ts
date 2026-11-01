import { describe } from "bun:test";

import { ruleTester } from "../test/utils.ts";

const RULE = "broods/no-focused-tests";
const rule = ruleTester(RULE, { filename: "fixture.test.ts" });

describe(RULE, () => {
  rule.valid(
    "allows plain, skipped and parameterized tests",
    `
      import { describe, expect, test } from "bun:test";

      describe("suite", () => {
        test("runs", () => expect(1).toBe(1));
        test.each([1, 2])("handles %d", (value) => expect(value).toBeGreaterThan(0));
      });
    `,
  );

  rule.valid(
    "ignores an only property on something that is not a test function",
    `
      const test = { only: true };
      const options = { only: test.only };
      export const flags = options.only;
    `,
  );

  rule.invalid(
    "reports bun:test focus modifiers",
    `
      import { describe, it, test } from "bun:test";

      describe.only("suite", () => {});
      test.only("case", () => {});
      it.only("case", () => {});
      test.only.each([1])("case %d", () => {});
    `,
    [
      { line: 3, message: "Drop `.only`" },
      { line: 4, message: "Drop `.only`" },
      { line: 5, message: "Drop `.only`" },
      { line: 6, message: "Drop `.only`" },
    ],
  );

  rule.invalid(
    "reports Playwright focus modifiers and bracket access",
    `
      import { test } from "@playwright/test";

      test.describe.only("flow", () => {});
      test["only"]("case", async () => {});
    `,
    [
      { line: 3, message: "Drop `.only`" },
      { line: 4, message: "Drop `.only`" },
    ],
  );

  rule.invalid(
    "reports the bun test globals",
    `
      describe.only("suite", () => {});
    `,
    [{ line: 1, message: "Drop `.only`" }],
  );
});
