/**
 * Bundles entry.ts for workerd with Bun's bundler: core's dependencies use
 * Bun-only import attributes (`with { type: "file" }`) that esbuild refuses.
 * Node built-ins stay external; workerd's nodejs_compat provides them.
 */

import { builtinModules } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The package's own entry file, found by walking up from the importer. */
function packageEntry(name: string, importer: string): string {
  for (let dir = dirname(importer); dir !== "/"; dir = dirname(dir)) {
    const root = join(dir, "node_modules", name);
    const manifestPath = join(root, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      exports?: { "."?: { import?: string } } | Record<string, unknown>;
      main?: string;
    };
    const exported = (manifest.exports as { "."?: { import?: string } })?.["."];
    const entry =
      (typeof exported === "object" ? exported?.import : undefined) ??
      manifest.main ??
      "index.js";
    return join(root, entry);
  }
  throw new Error(`cannot find ${name} from ${importer}`);
}

/** A package that sits only in Bun's store (node_modules/.bun), newest version. */
function storePackage(name: string): string {
  const store = new URL("../../node_modules/.bun/", import.meta.url).pathname;
  const dir = readdirSync(store)
    .filter((entry) => entry.startsWith(`${name}@`))
    .sort()
    .at(-1);
  if (!dir) throw new Error(`${name} is not in ${store}`);

  return packageEntry(name, join(store, dir, "node_modules", name, "x"));
}

const shim = new URL("./bun-shim.ts", import.meta.url).pathname;
const processShim = new URL("./process-shim.ts", import.meta.url).pathname;
const NOT_EXTERNAL = new Set(["process", "node:process"]);
const result = await Bun.build({
  entrypoints: ["./entry.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  minify: true,
  // workerd leaves import.meta.url undefined; createRequire needs a file URL.
  define: { "import.meta.url": JSON.stringify("file:///bundle/entry.js") },
  conditions: ["workerd", "worker", "browser"],
  external: [
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ].filter((name) => !NOT_EXTERNAL.has(name)),
  plugins: [
    {
      name: "bun-shim",
      setup: function (build) {
        build.onResolve({ filter: /^bun$/ }, () => ({ path: shim }));
        build.onResolve({ filter: /^(node:)?process$/ }, () => ({
          path: processShim,
        }));
        // Bun ships its own "ws" and "undici" and treats them as built-ins;
        // workerd has neither, so bundle the packages the importer depends on.
        build.onResolve({ filter: /^(ws|undici)$/ }, (args) => ({
          path: packageEntry(args.path, args.importer),
        }));
        // bun-shim's Bun.Glob stand-in; core gets picomatch only transitively.
        build.onResolve({ filter: /^picomatch$/ }, () => ({
          path: storePackage("picomatch"),
        }));
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const output of result.outputs) {
  console.log(output.path, (output.size / 1e6).toFixed(2), "MB");
}
