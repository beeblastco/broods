// Tool bundle determinism: identical source must hash the same regardless of
// the shim tempdir and the cwd Bun stamps into the bundle as path comments.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProject } from "../src/manifest.ts";

const RESOURCES_MODULE = join(import.meta.dir, "..", "src", "resources.ts");
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

test("compileProject hashes identical tool source to the same bundle", async () => {
  const cwd = await toolFixture();

  const first = await toolSha256(cwd);
  const second = await toolSha256(cwd);

  expect(second).toBe(first);
});

test("compileProject hashes a tool the same from any working directory", async () => {
  const cwd = await toolFixture();
  const original = process.cwd();

  const fromRoot = await toolSha256(cwd);
  process.chdir(cwd);
  try {
    const fromProject = await toolSha256(cwd);
    expect(fromProject).toBe(fromRoot);
  } finally {
    process.chdir(original);
  }
});

test("compileProject keeps a tool path with regex replacement syntax literal", async () => {
  // `$&` in a replacement string expands to the match, so a path carrying it
  // would rewrite itself into the bundle and move the hash.
  const cwd = await toolFixture("ec$&ho.ts");

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const tool = manifest.resources.find((resource) => resource.kind === "tool");
  const bundle = (tool?.config as { bundle?: unknown }).bundle;

  expect(bundle).toContain("// tools/ec$&ho.ts");
});

async function toolFixture(toolFile = "echo.ts"): Promise<string> {
  // realpath so /var and /private/var agree: the bundler resolves the symlinked
  // macOS tempdir differently from the path mkdtemp hands back.
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "broods-tool-fixture-")));
  tempDirs.push(cwd);
  const projectDir = join(cwd, "broods");
  await mkdir(join(projectDir, "tools"), { recursive: true });
  await writeFile(
    join(projectDir, "broods.config.ts"),
    `import { defineBroods } from "${RESOURCES_MODULE}";\n` +
      `export default defineBroods({ project: "hash-app" });\n`,
  );
  await writeFile(
    join(projectDir, "tools", toolFile),
    `export default { name: "echo", execute: (ctx, input) => ({ echo: input }) };\n`,
  );
  await writeFile(
    join(projectDir, "agents.ts"),
    `import { defineTool } from "${RESOURCES_MODULE}";\n` +
      `export const echo = defineTool({\n` +
      `  name: "echo",\n` +
      `  config: {\n` +
      `    path: "tools/${toolFile}",\n` +
      `    description: "Echoes its input.",\n` +
      `    inputSchema: { type: "object" },\n` +
      `  },\n` +
      `});\n`,
  );

  return cwd;
}

async function toolSha256(cwd: string): Promise<string> {
  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const tool = manifest.resources.find(
    (resource) => resource.kind === "tool" && resource.name === "echo",
  );
  const sha256 = (tool?.config as { sha256?: unknown } | undefined)?.sha256;
  if (typeof sha256 !== "string") throw new Error("tool bundle sha256 missing");

  return sha256;
}
