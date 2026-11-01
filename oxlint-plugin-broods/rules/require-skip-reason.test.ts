import { describe } from "bun:test";

import { ruleTester } from "../test/utils.ts";

const RULE = "broods/require-skip-reason";
const rule = ruleTester(RULE, { filename: "fixture.test.ts" });
const COMMENT = "put `// skip: <reason or issue URL>` on the line above";

describe(RULE, () => {
  rule.valid(
    "allows a skip with a skip: comment above it",
    `
      import { describe, it, test } from "bun:test";

      // skip: needs a Docker daemon, CI has none
      describe.skipIf(!process.env.DOCKER_HOST)("docker", () => {});
      // skip: https://github.com/oven-sh/bun/issues/1
      test.todo("streams a terminal resize");
      /* skip: the runner binary is built only by test:isolate */
      export const realRunnerIt = process.env.RUNNER ? it : it.skip;
    `,
  );

  rule.valid(
    "allows Playwright skips that pass the reason after the condition",
    `
      import { test } from "@playwright/test";

      const MISSING_PROBE = "set E2E_ADMIN_KEY";
      test.skip(!process.env.E2E_ADMIN_KEY, MISSING_PROBE);
      test("a page", async ({ browserName }) => {
        test.skip(browserName === "webkit", "webkit has no clipboard API");
        test.fixme(({ isMobile }) => isMobile, \`mobile \${browserName} drops the drag\`);
      });
    `,
  );

  rule.valid(
    "ignores skip properties on things that are not test functions",
    `
      const test = { skip: () => {} };
      test.skip();
      export const step = { skip: true }.skip;
    `,
  );

  rule.invalid(
    "reports bun skips and todos with no reason",
    `
      import { describe, it, test } from "bun:test";

      describe.skipIf(!process.env.URL)("live", () => {});
      // flaky, will fix later
      test.skip("pending", () => {});
      test.todo("later");
      const realRunnerIt = process.env.RUNNER ? it : it.skip;
    `,
    [
      { line: 3, message: COMMENT },
      { line: 5, message: COMMENT },
      { line: 6, message: COMMENT },
      { line: 7, message: COMMENT },
    ],
  );

  rule.invalid(
    "reports Playwright skips with a title, no reason or an empty reason",
    `
      import { test } from "@playwright/test";

      test.skip("a disabled flow", async () => {});
      test("a page", async () => {
        test.skip();
        test.skip(true, "");
        test.describe.fixme("broken suite", () => {});
      });
    `,
    [
      { line: 3, message: "or pass the reason after the condition" },
      { line: 5, message: "or pass the reason after the condition" },
      { line: 6, message: "or pass the reason after the condition" },
      { line: 7, message: "or pass the reason after the condition" },
    ],
  );

  rule.invalid(
    "does not take a reason from a comment that is not attached",
    `
      import { test } from "bun:test";

      // skip: this belongs to the first one
      const first = 1;
      test.skip("second", () => {});
    `,
    [{ line: 5, message: COMMENT }],
  );
});
