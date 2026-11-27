import { describe } from "bun:test";

import { ruleTester } from "../test/utils.ts";

const rule = ruleTester("broods/require-suppression-reason", {
  filename: "fixture.tsx",
});

describe("broods/require-suppression-reason", () => {
  rule.valid(
    "allows directives that end with a reason",
    `
      // oxlint-disable-next-line no-control-regex -- ANSI sequences start with ESC.
      const ansi = /\\x1b\\[/;
      /* eslint-disable no-console -- this script reports to the terminal */
      const value = 1; // oxlint-disable-line no-unused-vars -- read by the eval below
    `,
  );

  rule.valid(
    "allows a JSX directive with a reason",
    `const el = <div>{/* oxlint-disable-next-line react/no-danger -- sanitized above */}</div>;`,
  );

  rule.valid("ignores enable directives", `/* oxlint-enable no-console */`);

  rule.valid(
    "allows @ts-expect-error with a reason",
    `
      // @ts-expect-error the fixture passes a string on purpose
      const count: number = "text";
      // @ts-expect-error: a page is not a boolean
      const flag: boolean = [];
      const input = <input {/* @ts-expect-error not in React's typedefs */ ...{ webkitdirectory: "" }} />;
    `,
  );

  rule.invalid(
    "reports lint directives without a reason",
    `
      // oxlint-disable-next-line no-control-regex
      const ansi = /\\x1b\\[/;
      /* oxlint-disable eslint/no-useless-escape */
      const value = 1; // eslint-disable-line no-unused-vars
      const el = <div>{/* oxlint-disable-next-line react/no-danger */}</div>;
    `,
    [
      { line: 1, message: "end the directive with `-- <reason>`" },
      { line: 3, message: "end the directive with `-- <reason>`" },
      { line: 4, message: "end the directive with `-- <reason>`" },
      { line: 5, message: "end the directive with `-- <reason>`" },
    ],
  );

  rule.invalid(
    "does not take the reason from the comment above",
    `
      // Positions are stable for a given string.
      // oxlint-disable-next-line react/no-array-index-key
      const items = ["a"].map((item, index) => <li key={index}>{item}</li>);
    `,
    [{ line: 2, message: "end the directive with `-- <reason>`" }],
  );

  rule.invalid(
    "reports @ts-expect-error without a reason",
    `
      // @ts-expect-error
      const count: number = "text";
      // @ts-expect-error -
      const other: number = "text";
    `,
    [
      { line: 1, message: "write the reason after `@ts-expect-error`" },
      { line: 3, message: "write the reason after `@ts-expect-error`" },
    ],
  );

  rule.invalid(
    "bans @ts-ignore and @ts-nocheck even with a reason",
    `
      // @ts-nocheck
      // @ts-ignore the types lag behind the runtime
      const count: number = "text";
    `,
    [
      { line: 1, message: "Drop `@ts-nocheck`" },
      { line: 2, message: "Drop `@ts-ignore`" },
    ],
  );
});
