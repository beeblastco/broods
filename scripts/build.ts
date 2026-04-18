import { $ } from "bun";
import { access, readdir } from "node:fs/promises";

const FUNCTIONS_DIR = new URL("../functions/", import.meta.url);

const functionNames = await findFunctionNames();

await $`rm -rf dist`;

if (functionNames.length === 0) {
  console.log("No function folders found. Add a bootstrap.ts under functions/<name>/.");
  process.exit(0);
}

for (const functionName of functionNames) {
  console.log(`Building ${functionName}...`);
  await $`bun build --compile --target bun-linux-arm64 ./functions/${functionName}/bootstrap.ts --outfile dist/${functionName}/bootstrap`;
}

console.log("All functions built successfully.");

async function findFunctionNames() {
  const entries = await readdir(FUNCTIONS_DIR, { withFileTypes: true });
  const names = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          await access(new URL(`${entry.name}/bootstrap.ts`, FUNCTIONS_DIR));
          return entry.name;
        } catch {
          return null;
        }
      }),
  );

  return names.filter((name): name is string => name !== null).sort();
}
