import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { defineConfig, globalIgnores } from "eslint/config";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "object-shorthand": ["error", "never"],
      "padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: "return" },
      ],
      // Every exported function states its own return type, so a module's surface
      // is readable without running the inference. Components return
      // `React.JSX.Element`; a hook returning an object gets a named interface
      // rather than an inlined structural type.
      "@typescript-eslint/explicit-module-boundary-types": "error",
    },
  },
  {
    // Vendored shadcn/ui. `shadcn add` rewrites these files wholesale, so any
    // annotation here is undone the next time a component is pulled or updated.
    files: ["app/components/ui/**"],
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "off",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "convex/_generated/**",
  ]),
]);

export default eslintConfig;
