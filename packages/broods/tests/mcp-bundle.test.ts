// Hosted MCP bundles are validated at deploy time: a bundle whose default
// export cannot serve throws during compile instead of uploading and failing
// only inside the Lambda.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProject } from "../src/manifest.ts";

const RESOURCES_MODULE = join(import.meta.dir, "..", "src", "resources.ts");
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

test("compileProject bundles a servable hosted MCP server", async () => {
  const cwd = await mcpFixture(
    `export default (request) => new Response("{}", { status: 200 });\n`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const server = manifest.resources.find((entry) => entry.kind === "mcp");
  const bundle = (server?.config as { bundle?: unknown } | undefined)?.bundle;
  expect(typeof bundle).toBe("string");
});

test("compileProject rejects a bundle without a fetch-style default export", async () => {
  const cwd = await mcpFixture(`export default 42;\n`);

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    "default export must be a fetch handler",
  );
});

test("compileProject rejects a server that crashes on import", async () => {
  // The project scan imports every broods/ module, so an import-time crash
  // surfaces with the author's own error before bundling even starts.
  const cwd = await mcpFixture(`throw new Error("boom at import");\n`);

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    "boom at import",
  );
});

async function mcpFixture(serverSource: string): Promise<string> {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "broods-mcp-fixture-")),
  );
  tempDirs.push(cwd);
  const projectDir = join(cwd, "broods");
  await mkdir(join(projectDir, "servers"), { recursive: true });
  await writeFile(
    join(projectDir, "broods.config.ts"),
    `import { defineBroods } from "${RESOURCES_MODULE}";\n` +
      `export default defineBroods({ project: "mcp-app" });\n`,
  );
  await writeFile(join(projectDir, "servers", "search.ts"), serverSource);
  await writeFile(
    join(projectDir, "agents.ts"),
    `import { defineMcp } from "${RESOURCES_MODULE}";\n` +
      `export const search = defineMcp({\n` +
      `  name: "search",\n` +
      `  path: "servers/search.ts",\n` +
      `});\n`,
  );

  return cwd;
}
