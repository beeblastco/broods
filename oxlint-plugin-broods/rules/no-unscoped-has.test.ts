import { describe } from "bun:test";

import { ruleTester } from "../test/utils.ts";

const RULE = "broods/no-unscoped-has";
const rule = ruleTester(RULE, { filename: "fixture.tsx" });
const ANCHOR = "Anchor the :has()";

describe(RULE, () => {
  rule.valid(
    "allows :has() on the element itself, inside :not() and in has-* variants",
    `
      const a = "[&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]";
      const b = "[&:not(:has(+[data-slot=footer]))]:rounded-b-2xl";
      const c = "has-[>[data-slot=icon]]:ps-2 group-has-[:checked]:opacity-100";
      const d = "[&:not(.collapsed):not(:has(>[data-slot=icon]))]:ps-2";
      const e = "[:has(>input)]:p-2 not-[:has(>[data-slot=icon])]:ps-2";
    `,
  );

  rule.valid(
    "allows :has() anchored to an attribute, a group, a peer or an own branch",
    `
      const a = "[&+[data-composer]:has(>[data-slot=banner])]:mt-0";
      const b = "group-[:has(input)]:p-2 peer-[:has(input)]:p-2 group-[&:has(input)]/row:p-2";
      const c = "[:is(.a,.b):has(x)_&]:p-2 [&:not(.a,:has(x))]:p-2";
    `,
  );

  rule.valid(
    "ignores prose, arbitrary values and quoted attribute values",
    `
      const note = "uses :has( for styling";
      const a = "before:content-[':has(foo)']";
      const b = "data-[foo='_:has(x)']:p-2 [&_[data-query='_:has(foo)']]:p-2";
    `,
  );

  rule.invalid(
    "reports sibling, descendant and universal :has() with nothing anchoring it",
    `
      const a = "[&+:has([data-composer])_[data-composer]]:before:rounded-none";
      const b = cn("p-2", "[&_:has(>input)]:gap-1");
      const c = \`flex [*:has([data-open])_&]:hidden\`;
      const el = <div className="[&_:has(>input)]:gap-1" />;
    `,
    [
      { line: 1, message: ANCHOR },
      { line: 2, message: "[&_:has(>input)]" },
      { line: 3, message: ANCHOR },
      { line: 4, message: ANCHOR },
    ],
  );

  rule.invalid(
    "reports a negated-only anchor, uppercase :HAS() and the document root",
    `
      const a = "[*:not(.safe):has([data-open])_&]:hidden";
      const b = "[*:HAS([data-open])_&]:hidden";
      const c = "[body:has([data-dialog-open])_&]:overflow-hidden";
    `,
    [
      { line: 1, message: ANCHOR },
      { line: 2, message: ANCHOR },
      { line: 3, message: "below the document root" },
    ],
  );

  rule.invalid(
    "reports a branch that borrows another branch's anchor",
    `
      const a = "[.safe,:has(input)_&]:p-2";
      const b = "[&_:is(.safe,:has(input))]:p-2";
    `,
    [
      { line: 1, message: ANCHOR },
      { line: 2, message: ANCHOR },
    ],
  );

  rule.invalid(
    "reports unanchored :has() in group, ancestor and in-* variants",
    `
      const a = "group-[&_:has(x)]/row:p-2";
      const b = "[:has(x)_.foo]:p-2";
      const c = "group-[:has(x)_.y]:p-2";
      const d = "in-[:has(x)]:p-2";
    `,
    [
      { line: 1, message: ANCHOR },
      { line: 2, message: ANCHOR },
      { line: 3, message: ANCHOR },
      { line: 4, message: ANCHOR },
    ],
  );
});
