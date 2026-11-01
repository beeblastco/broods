import { describe } from "bun:test";

import { ruleTester } from "../test/utils.ts";

const RULE = "broods/no-raw-resize-observer";
const component = ruleTester(RULE, { filename: "app/components/Chart.tsx" });

describe(RULE, () => {
  component.invalid(
    "reports a ResizeObserver built directly or off a global",
    `
      const a = new ResizeObserver(() => {});
      const b = new window.ResizeObserver(() => {});
      const c = new globalThis["ResizeObserver"](() => {});
    `,
    [
      { line: 1, message: "Use observeResize from `@/app/lib/observeResize`" },
      { line: 2, message: "lands a frame late" },
      { line: 3, message: "lands a frame late" },
    ],
  );

  component.valid(
    "allows the type and other observers",
    `
      let observer: ResizeObserver | null = null;
      const io = new IntersectionObserver(() => {});
      const local = new chart.ResizeObserver();
    `,
  );

  ruleTester(RULE, { filename: "app/lib/observeResize.ts" }).valid(
    "allows the module that wraps it by default",
    `export const shared = new ResizeObserver(() => {});`,
  );

  const custom = { ruleOptions: [{ allowIn: ["app/vendor/**/*.ts"] }] };
  ruleTester(RULE, { filename: "app/vendor/flow/size.ts", ...custom }).valid(
    "allows a module matched by an allowIn glob",
    `export const shared = new ResizeObserver(() => {});`,
  );
  ruleTester(RULE, { filename: "app/lib/observeResize.ts", ...custom }).invalid(
    "drops the default once allowIn is set",
    `export const shared = new ResizeObserver(() => {});`,
    [{ line: 1, message: "Use observeResize" }],
  );
});
