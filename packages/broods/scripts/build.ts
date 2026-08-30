import { chmod, readFile, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await rm(".dts-temp", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/index.ts", "src/account.ts", "src/cli/index.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  loader: { ".md": "text", ".sh": "text" },
  splitting: true,
  minify: true,
  sourcemap: "none",
  external: ["esbuild"],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log.message);
  }
  process.exit(1);
}

const cliPath = "dist/cli/index.js";
const cliSource = await readFile(cliPath, "utf8");
if (!cliSource.startsWith("#!")) {
  await writeFile(cliPath, `#!/usr/bin/env node\n${cliSource}`, "utf8");
}
await chmod(cliPath, 0o755);
