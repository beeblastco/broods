import { $ } from "bun";
import { access, readdir, writeFile } from "node:fs/promises";
import { syncSystemPromptModule } from "./system-prompt.ts";

const FUNCTIONS_DIR = new URL("../functions/", import.meta.url);
const CONVEX_ADAPTER_INDEX = new URL(
  "../functions/_shared/storage/convex/index.ts",
  import.meta.url,
);

const functionNames = await findFunctionNames();

await $`rm -rf dist`;
await syncSystemPromptModule();
await ensureConvexAdapterStub();

if (functionNames.length === 0) {
  console.log("No function folders found. Add a bootstrap.ts under functions/<name>/.");
  process.exit(0);
}

for (const functionName of functionNames) {
  console.log(`Building ${functionName}...`);
  await $`bun build --compile --target bun-linux-arm64 ./functions/${functionName}/bootstrap.ts --outfile dist/${functionName}/bootstrap`;
}

console.log("All functions built successfully.");

// Community / OSS builds don't init the private filthy-panty-convex-adapter
// submodule, so functions/_shared/storage/convex/ is empty. Bun's bundler
// needs *some* file at that path to resolve the static require() in the
// storage factory. We write a tiny stub that exports a null provider; the
// factory checks for null and throws a clear error if STORAGE_PROVIDER=convex
// is set on a build without the real adapter.
async function ensureConvexAdapterStub() {
  try {
    await access(CONVEX_ADAPTER_INDEX);
    return; // real adapter present (SaaS build) — leave it alone
  } catch {
    // not present; fall through to write stub
  }
  const stub = `// Auto-generated stub for community / OSS builds. The real Convex adapter
// lives in the private filthy-panty-convex-adapter submodule, mounted at
// this path on SaaS builds. STORAGE_PROVIDER=convex is unsupported here.
export const convexStorageProvider = null;
`;
  await writeFile(CONVEX_ADAPTER_INDEX, stub, "utf8");
  console.log("Wrote Convex adapter stub (submodule not present).");
}

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
