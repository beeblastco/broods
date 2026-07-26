/**
 * Compiles the runner to ESM JavaScript. Lambda's nodejs runtime and the raw
 * `node` child both execute the output directly, so it ships as .mjs.
 */

import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, "dist");

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [
    join(root, "src", "handler.ts"),
    join(root, "src", "child-runner.ts"),
  ],
  outdir: outdir,
  target: "node",
  format: "esm",
  naming: "[dir]/[name].mjs",
});

if (!result.success) {
  for (const log of result.logs) console.error(log.message);
  process.exit(1);
}

console.log(`tool-runner built to ${outdir}`);
