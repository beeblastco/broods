import { describe } from "bun:test";

import { ruleTester } from "../test/utils.ts";

const RULE = "broods/no-continuous-animation";
const rule = ruleTester(RULE, { filename: "fixture.tsx" });
const STILL = "Show a still state instead of";

describe(RULE, () => {
  rule.valid(
    "allows one-shot animations",
    `
      const a = "animate-in fade-in-0 zoom-in-95 animate-out animate-trace-flash animate-none repeat-1";
      const b = cn("animate-[trace-flash_1.5s_ease-out]", "[animation:pop_200ms_ease-out]");
      const c = <div style={{ animation: "pop 200ms ease-out", animationIterationCount: "2" }} />;
    `,
  );

  rule.valid(
    "accepts a continuous animation whose suppression says why",
    `
      // oxlint-disable-next-line broods/no-continuous-animation -- the upload has no progress to show
      const el = <Loader className="animate-spin" />;
    `,
  );

  rule.invalid(
    "reports the looping Tailwind utilities",
    `
      const a = <Loader className="size-4 animate-spin" />;
      const b = cn("motion-safe:animate-pulse", busy && "animate-ping");
      const c = cva("animate-bounce", { variants: { caret: { true: "animate-caret-blink repeat-infinite" } } });
    `,
    [
      { line: 1, message: "`animate-spin`" },
      { line: 2, message: "`motion-safe:animate-pulse`" },
      { line: 2, message: "`animate-ping`" },
      { line: 3, message: "`animate-bounce`" },
      { line: 3, message: "`animate-caret-blink`" },
      { line: 3, message: "`repeat-infinite`" },
    ],
  );

  rule.invalid(
    "reports arbitrary animations that repeat forever",
    `
      const a = "animate-[spin_1s_linear_infinite] repeat-[infinite]";
      const b = \`flex \${x} [animation:dash_2s_linear_infinite] [animation-iteration-count:infinite]\`;
    `,
    [
      { line: 1, message: "`animate-[spin_1s_linear_infinite]`" },
      { line: 1, message: "`repeat-[infinite]`" },
      { line: 2, message: STILL },
      { line: 2, message: "`[animation-iteration-count:infinite]`" },
    ],
  );

  rule.invalid(
    "reports inline styles that repeat forever",
    `
      const a = <div style={{ animation: "dash 2s linear infinite" }} />;
      const b = { animationIterationCount: "infinite" };
    `,
    [
      { line: 1, message: "`animation: dash 2s linear infinite`" },
      { line: 2, message: "-- <reason>" },
    ],
  );
});
