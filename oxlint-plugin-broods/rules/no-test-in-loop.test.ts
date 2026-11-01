import { describe } from "bun:test";

import { ruleTester } from "../test/utils.ts";

const RULE = "broods/no-test-in-loop";
const rule = ruleTester(RULE, { filename: "fixture.test.ts" });

describe(RULE, () => {
  rule.valid(
    "allows test.each, describe.each and loops inside a test body",
    `
      import { describe, expect, test } from "bun:test";

      test.each([1, 2])("handles %d", (value) => expect(value).toBeGreaterThan(0));
      describe.each(["a", "b"])("bundle %s", (name) => {
        test("loads", () => expect(name).toBeTruthy());
      });
      test("checks every value", () => {
        for (const value of [1, 2]) expect(value).toBeGreaterThan(0);
        [1, 2].forEach((value) => expect(value).toBeGreaterThan(0));
      });
    `,
  );

  rule.valid(
    "ignores Playwright, which has no .each and documents loops",
    `
      import { test } from "@playwright/test";

      for (const route of ["/", "/settings"]) {
        test(\`renders \${route}\`, async ({ page }) => {
          await page.goto(route);
        });
      }
    `,
  );

  rule.valid(
    "ignores a local function named test",
    `
      const test = (_name: string) => {};
      for (const name of ["a"]) test(name);
    `,
  );

  rule.invalid(
    "reports tests declared in for loops",
    `
      import { describe, it, test } from "bun:test";

      for (const value of [1, 2]) {
        test(\`handles \${value}\`, () => {});
      }
      describe("cases", () => {
        for (let index = 0; index < 2; index++) {
          it.skipIf(index > 0)(\`case \${index}\`, () => {});
        }
      });
    `,
    [
      { line: 4, message: "Use test.each(cases)(name, fn)" },
      { line: 8, message: "Use it.each(cases)(name, fn)" },
    ],
  );

  rule.invalid(
    "reports tests declared in forEach and map callbacks",
    `
      import { test } from "vitest";

      ["a", "b"].forEach((name) => test(name, () => {}));
      Object.keys({ a: 1 }).map((key) => {
        test(key, () => {});
      });
    `,
    [
      { line: 3, message: "Use test.each(cases)(name, fn)" },
      { line: 5, message: "Use test.each(cases)(name, fn)" },
    ],
  );

  rule.invalid(
    "reports a describe in a loop once, not the tests inside it",
    `
      for (const bundle of ["a.js", "b.js"]) {
        describe(bundle, () => {
          test("first", () => {});
          test("second", () => {});
        });
      }
    `,
    [{ line: 2, message: "Use describe.each(cases)(name, fn)" }],
  );
});
