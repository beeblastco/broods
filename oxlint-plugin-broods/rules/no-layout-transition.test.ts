import { describe } from "bun:test";

import { ruleTester } from "../test/utils.ts";

const RULE = "broods/no-layout-transition";
const rule = ruleTester(RULE, { filename: "fixture.tsx" });
const USE = "Use transition-[opacity,transform], transition-transform";

describe(RULE, () => {
  rule.valid(
    "allows transitions of paint and composite properties",
    `
      const a = "transition transition-colors transition-opacity transition-transform transition-shadow transition-none";
      const b = cn("transition-[opacity,transform] duration-150", "transition-[color,box-shadow]");
      const c = cva("hover:transition-[transform,opacity]", { variants: { open: { true: "[transition-property:opacity]" } } });
      const d = <div className={\`h-full \${open ? "w-2/5" : "w-0"} transition-opacity\`} />;
      const e = <div style={{ transition: "opacity 150ms ease-out, transform 150ms cubic-bezier(0.4, 0, 0.2, 1)" }} />;
      const f = { transitionProperty: "opacity, transform", transition: "none" };
    `,
  );

  rule.valid(
    "ignores CSS text and motion configs outside class strings and styles",
    `
      const note = "the width transition lags";
      const label = "transition: all";
      const motion = { transition: { duration: 0.2 } };
    `,
  );

  rule.invalid(
    "reports transition-all and layout transitions in class strings",
    `
      const a = "rounded-md transition-all hover:ring-2";
      const b = cn("md:transition-[width]", open && "transition-[left,right,width]");
      const c = cva("transition-[margin,opacity] group-data-[collapsible=icon]:transition-[width,height,padding]!");
      const el = <div className="motion-safe:[transition:max-height_200ms_ease]" />;
      const t = \`flex \${gap} [transition-property:grid-template-columns]\`;
    `,
    [
      { line: 1, message: "`transition-all` can animate layout" },
      { line: 2, message: "`md:transition-[width]`" },
      { line: 2, message: "`transition-[left,right,width]`" },
      { line: 3, message: "`transition-[margin,opacity]`" },
      { line: 3, message: USE },
      { line: 4, message: "relays out the page on every frame" },
      { line: 5, message: "[transition-property:grid-template-columns]" },
    ],
  );

  rule.invalid(
    "reports inline styles that transition layout, including the implicit all",
    `
      const a = <div style={{ transition: "width 200ms ease" }} />;
      const b = { transitionProperty: "opacity, flex-basis" };
      const c = { "transition-property": "padding-inline" };
      const d = { transition: \`200ms ease-out\` };
      const e = { transition: "opacity 1s, all 2s" };
    `,
    [
      { line: 1, message: "`transition: width 200ms ease`" },
      { line: 2, message: "`transition-property: opacity, flex-basis`" },
      { line: 3, message: USE },
      { line: 4, message: "`transition: 200ms ease-out`" },
      { line: 5, message: USE },
    ],
  );
});
