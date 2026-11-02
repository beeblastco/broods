import { describe } from "bun:test";

import { ruleTester } from "../test/utils.ts";

const RULE = "broods/no-hookless-use-function";
const rule = ruleTester(RULE, { filename: "fixture.tsx" });

describe(RULE, () => {
  rule.valid(
    "allows hooks that call a hook directly, by member or through use()",
    `
      function useCount() { const [count] = useState(0); return count; }
      const useTheme = () => use(ThemeContext);
      const useStore = function () { return React.useContext(StoreContext); };
      export default function useFirst() { return useQuery(api.first); }
    `,
  );

  rule.valid(
    "allows plain functions and names that only start with use",
    `
      function formatLabel(value) { return String(value); }
      function user() { return null; }
      const usage = () => 1;
      const handlers = { useCache: () => cache };
    `,
  );

  rule.invalid(
    "reports hook-less declarations, arrows and function expressions",
    `
      function useFontFamily(weight) { return FONT_FAMILIES[weight]; }
      const useUpdateSettings = () => (patch) => persist(patch);
      const useCompleteOnboarding = function () { return completeOnboarding; };
    `,
    [
      { line: 1, message: "Rename `useFontFamily` to a plain function" },
      { line: 2, message: "Rename `useUpdateSettings` to a plain function" },
      {
        line: 3,
        message: "Rename `useCompleteOnboarding` to a plain function",
      },
    ],
  );

  rule.invalid(
    "reports a hook call that only happens inside a nested callback",
    `
      function useHandler() {
        return () => useState(0);
      }
    `,
    [{ line: 1, message: "the use prefix only binds its callers" }],
  );

  rule.invalid(
    "judges a nested hook-less use function on its own",
    `
      function usePanel() {
        const [open] = useState(false);
        const useLabel = () => (open ? "Close" : "Open");
        return useLabel;
      }
    `,
    [{ line: 3, message: "Rename `useLabel`" }],
  );
});
