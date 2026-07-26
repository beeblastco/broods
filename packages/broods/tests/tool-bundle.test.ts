/**
 * Tool bundle determinism. Bun stamps module paths into the bundle as comments,
 * and those paths move with the shim tempdir and the cwd — so identical source
 * used to rehash on every build and show a spurious update in every sync.
 */

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

async function toolFixture(): Promise<string> {
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
    join(projectDir, "tools", "echo.ts"),
    `export default { name: "echo", execute: (ctx, input) => ({ echo: input }) };\n`,
  );
  await writeFile(
    join(projectDir, "agents.ts"),
    `import { defineTool } from "${RESOURCES_MODULE}";\n` +
      `export const echo = defineTool({\n` +
      `  name: "echo",\n` +
      `  config: {\n` +
      `    path: "tools/echo.ts",\n` +
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
