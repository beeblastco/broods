import { describe } from "bun:test";

import { ruleTester } from "../test/utils.ts";

const RULE = "broods/no-low-value-comments";
const rule = ruleTester(RULE);
const wide = `// ${"word ".repeat(20)}and then some more so the line passes column one hundred`;

describe(RULE, () => {
  rule.valid(
    "allows a short why-comment",
    `
      // Discord retries a webhook that takes longer than 3s, so ack first.
      const ackFirst = true;
      /** Bun cannot load the addon; the tests spawn node instead. */
      export function spawnRunner(): void {}
    `,
  );

  rule.valid(
    "exempts directives from the length caps",
    `
      // oxlint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC, and this one is long on purpose.
      const ansi = /\\x1b\\[/;
      /// <reference types="bun" />
      // #region generated
    `,
  );

  rule.valid(
    "exempts a license header from the line cap",
    `
      /**
       * Copyright (c) Broods contributors.
       *
       * Licensed under the terms in LICENSE.md.
       * Redistribution requires this notice.
       * See the file for details.
       */
      export const version = "1";
    `,
  );

  rule.valid(
    "allows a tracked task marker and placeholder text",
    `
      // TODO(#412): drop once the gateway speaks v2.
      const legacy = true;
      // FIXME https://github.com/oven-sh/bun/issues/1 hangs on close.
      const closeTimeoutMs = 50;
      // Keys look like sk-XXX-XXX.
      const prefix = "sk-";
    `,
  );

  rule.valid(
    "does not count a URL against the column cap",
    `
      // https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28#about-secondary-rate-limits
      const secondaryLimitMs = 60_000;
    `,
  );

  rule.valid(
    "allows a markdown heading in TSDoc",
    `
      /**
       * ## Usage
       * Call it once per process.
       */
      export function install(): void {}
    `,
  );

  ruleTester(RULE, { filename: "fixture.mjs" }).valid(
    "allows JSDoc types in JavaScript",
    `
      /** @param {string} name the bundle to load */
      export function load(name) {
        return name;
      }
    `,
  );

  rule.invalid(
    "reports section dividers",
    `
      // ---------------------------------------------
      const a = 1;
      // ==== Helpers ====
      const b = 2;
      /* *************************** */
      const c = 3;
      // ── Slack ─────────────────
      const slack = 4;
    `,
    [
      { line: 1, message: "section divider" },
      { line: 3, message: "section divider" },
      { line: 5, message: "section divider" },
      { line: 7, message: "section divider" },
    ],
  );

  rule.invalid(
    "reports test step labels",
    `
      // Arrange
      const input = 1;
      // then:
      const output = input;
    `,
    [
      { line: 1, message: "test step label" },
      { line: 3, message: "test step label" },
    ],
  );

  rule.invalid(
    "reports task markers with no tracking link",
    `
      // TODO: handle the retry.
      const retries = 0;
      /* This is a HACK around the SDK. */
      const sdk = {};
    `,
    [
      { line: 1, message: "Link the issue" },
      { line: 3, message: "Link the issue" },
    ],
  );

  rule.invalid(
    "reports JSDoc types and empty tags in TypeScript",
    `
      /**
       * Loads a bundle by its manifest name.
       * @param {string} name the bundle to load
       */
      export function load(name: string): string {
        return name;
      }
      /**
       * Resolves the stage from the environment variables.
       * @param env
       * @returns
       */
      export function stage(env: string): string {
        return env;
      }
    `,
    [
      { line: 1, message: "Drop the JSDoc type" },
      { line: 8, message: "no description" },
    ],
  );

  rule.invalid(
    "reports commented-out code",
    `
      // const result = await fetchAccount(id);
      // if (result.ok) {
      //   return result;
      // }
      const live = true;
    `,
    [{ line: 1, message: "commented-out code" }],
  );

  rule.invalid(
    "reports a comment that only restates the next name",
    `
      // Max retries
      const maxRetries = 3;
      /** The account id. */
      export type AccountId = string;
    `,
    [
      { line: 1, message: "repeats the name" },
      { line: 3, message: "repeats the name" },
    ],
  );

  rule.invalid(
    "reports comment blocks past the line cap",
    `
      // One.
      // Two.
      // Three.
      // Four.
      // Five.
      const a = 1;
      /**
       * One.
       * Two.
       *
       * Three.
       * Four.
       * Five.
       */
      export const b = 2;
    `,
    [
      { line: 1, message: "Cut this to 4 lines" },
      { line: 7, message: "Cut this to 4 lines" },
    ],
  );

  rule.invalid(
    "does not let a directive exempt the comment above it",
    `
      // One.
      // Two.
      // Three.
      // Four.
      // Five.
      // oxlint-disable-next-line no-debugger -- the fixture pauses here
      debugger;
    `,
    [{ line: 1, message: "Cut this to 4 lines" }],
  );

  rule.invalid(
    "reports comment lines past the column cap",
    `
      ${wide}
      const a = 1;
      const settleMs = 250; // ${"the debounce window ".repeat(5)}
    `,
    [
      { line: 1, message: "Wrap the comment at 100 columns" },
      { line: 3, message: "Wrap the comment at 100 columns" },
    ],
  );

  const sdk = ruleTester(RULE, { ruleOptions: [{ maxLines: 6 }] });
  sdk.valid(
    "honours a larger maxLines",
    `
      /**
       * One.
       * Two.
       * Three.
       * Four.
       * Five.
       * Six.
       */
      export const a = 1;
    `,
  );
  sdk.invalid(
    "keeps the default maxColumns when only maxLines is set",
    `
      // 1.
      // 2.
      // 3.
      // 4.
      // 5.
      // 6.
      // 7.
      ${wide}
      const a = 1;
    `,
    [
      { line: 1, message: "Cut this to 6 lines" },
      { line: 8, message: "Wrap the comment at 100 columns" },
    ],
  );

  ruleTester(RULE, { ruleOptions: [{ maxLines: 2, maxColumns: 40 }] }).invalid(
    "honours custom limits",
    `
      // A reason that runs past forty columns wide.
      // Two.
      // Three.
      const a = 1;
    `,
    [
      { line: 1, message: "Cut this to 2 lines" },
      { line: 1, message: "Wrap the comment at 40 columns" },
    ],
  );
});
