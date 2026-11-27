import { describe } from "bun:test";

import { ruleTester } from "../test/utils.ts";

const RULE = "broods/no-backdrop-blur";
const rule = ruleTester(RULE, { filename: "fixture.tsx" });
const OPAQUE = "Use an opaque surface token such as bg-popover";

describe(RULE, () => {
  rule.valid(
    "allows opaque surfaces, element blur and turning blur off",
    `
      const a = "bg-popover blur-sm backdrop-blur-none backdrop-brightness-50";
      const b = <div style={{ filter: "blur(2px)", backdropFilter: "brightness(0.5)" }} />;
    `,
  );

  rule.invalid(
    "reports backdrop-blur utilities and arbitrary backdrop filters",
    `
      const a = <div className="bg-background/80 backdrop-blur" />;
      const b = cn("supports-[backdrop-filter]:backdrop-blur-md", "backdrop-blur-[2px]");
      const c = \`\${x} [backdrop-filter:blur(8px)_saturate(1.2)]\`;
    `,
    [
      { line: 1, message: "`backdrop-blur`" },
      { line: 2, message: "`supports-[backdrop-filter]:backdrop-blur-md`" },
      { line: 2, message: "`backdrop-blur-[2px]`" },
      { line: 3, message: OPAQUE },
    ],
  );

  rule.invalid(
    "reports inline backdrop blur",
    `
      const a = <div style={{ backdropFilter: "blur(8px)" }} />;
      const b = { WebkitBackdropFilter: "saturate(1.2) blur(4px)" };
    `,
    [
      { line: 1, message: "`backdrop-filter: blur(8px)`" },
      { line: 2, message: "re-rasterizes whatever moves beneath it" },
    ],
  );
});
