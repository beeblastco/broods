import { describe } from "bun:test";

import { ruleTester } from "../test/utils.ts";

const RULE = "broods/no-unreasoned-state-sync";
const lint = (filename: string) => ruleTester(RULE, { filename: filename });
const component = lint("app/components/Panel.tsx");

describe(RULE, () => {
  component.invalid(
    "reports every effect hook, including member calls",
    `
      import React, { useEffect } from "react";
      export function Panel() {
        useEffect(() => {}, []);
        React.useLayoutEffect(() => {});
        React.useInsertionEffect(() => {});
        return null;
      }
    `,
    [
      { line: 3, message: "Derive the value in render" },
      { line: 4, message: "useSyncExternalStore" },
      { line: 5, message: "-- <what outside React it syncs with>" },
    ],
  );

  component.valid(
    "ignores comments, strings and lookalike names",
    `
      // useEffect(() => {}) in a comment
      /* React.useLayoutEffect(() => {}) */
      const label = "useEffect(() => {})";
      const alias = useEffect;
      useEffectEvent(() => {});
      store[useEffect](() => {});
    `,
  );

  component.valid(
    "accepts an effect whose suppression says what it syncs with",
    `
      export function Panel() {
        // oxlint-disable-next-line broods/no-unreasoned-state-sync -- subscribes to the window's resize events
        React.useEffect(() => {});
        return null;
      }
    `,
  );

  for (const filename of [
    "app/components/Panel.test.tsx",
    "app/components/Panel.spec.tsx",
    "tests/Panel.tsx",
    "e2e/ui/Panel.tsx",
  ]) {
    lint(filename).valid(
      `skips ${filename}`,
      `export function Panel() { useEffect(() => {}); return null; }`,
    );
  }
});
