import { readFile } from "node:fs/promises";

// The published .d.ts may only import from real dependencies. A backend type
// reached by a bare specifier gets externalized rather than inlined, and no
// `npm i broods` consumer can resolve it.
const ALLOWED_DTS_IMPORTS = new Set(["ai"]);

for (const bundle of ["dist/index.d.ts", "dist/account.d.ts"]) {
  const source = await readFile(bundle, "utf8");
  // `from "x"` plus the `import("x").T` form declaration emit uses for a type
  // it never imports at the top level.
  for (const [, specifier] of source.matchAll(
    /(?:from|import)\s*\(?\s*['"]([^'".][^'"]*)['"]/g,
  )) {
    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0]!;
    if (ALLOWED_DTS_IMPORTS.has(packageName)) continue;
    throw new Error(
      `${bundle} imports "${specifier}", which consumers cannot resolve. ` +
        `Map it to source in tsconfig.dts.json so the rollup inlines it.`,
    );
  }
}
