// An inline `execute` ships by bundling the module that exports it, addressed by
// export name — no `path`, and without dragging the SDK into the bundle.

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

test("compileProject bundles a tool declared with an inline execute", async () => {
  const cwd = await inlineFixture();

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const tool = manifest.resources.find((resource) => resource.kind === "tool");
  const config = tool?.config as { bundle?: string; sha256?: string };

  expect(tool?.name).toBe("weather");
  expect(config.bundle).toContain("temperature");
  expect(typeof config.sha256).toBe("string");
});

test("an inline tool bundle drops the SDK the module imported", async () => {
  const cwd = await inlineFixture();

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const tool = manifest.resources.find((resource) => resource.kind === "tool");
  const bundle = (tool?.config as { bundle: string }).bundle;

  // The fixture imports the bare `broods` specifier, so this only passes if the
  // stub actually intercepted it — the real package carries these markers.
  expect(bundle).not.toContain("__BROODS_SDK__");
  expect(bundle).not.toContain("gateway.broods.app");
  expect(bundle).toContain("temperature");
});

test("an inline tool rehashes identically across compiles", async () => {
  const cwd = await inlineFixture();

  // The SDK stub is written to a fresh mkdtemp dir per compile, so its path
  // comment must be normalized or the same source rehashes and redeploys.
  const first = await compileProject({ cwd: cwd, command: "dev" });
  const second = await compileProject({ cwd: cwd, command: "dev" });
  const sha = ({ manifest }: typeof first) => {
    const tool = manifest.resources.find(
      (resource) => resource.kind === "tool",
    );
    expect(tool).toBeDefined();

    return (tool?.config as { sha256?: string } | undefined)?.sha256;
  };

  expect(sha(first)).toBeString();
  expect(sha(first)).toBe(sha(second));
});

async function inlineFixture(): Promise<string> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "broods-inline-")));
  tempDirs.push(cwd);
  const projectDir = join(cwd, "broods");
  await mkdir(projectDir, { recursive: true });
  // A local `broods` package so the fixture imports the bare specifier the stub
  // plugin filters on; it re-exports the real helpers plus the SDK markers.
  const pkgDir = join(cwd, "node_modules", "broods");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "broods", type: "module", main: "index.mjs" }),
  );
  await writeFile(
    join(pkgDir, "index.mjs"),
    `export * from ${JSON.stringify(RESOURCES_MODULE)};\n` +
      // Module-level side effect: a bundler cannot prove it pure and drop it,
      // so its absence means the specifier really was aliased away.
      `globalThis.__BROODS_SDK__ = "gateway.broods.app";\n`,
  );
  await writeFile(
    join(projectDir, "agents.ts"),
    `import { defineAgent, defineBroods, defineTool, env } from "broods";\n` +
      `export default defineBroods({ project: "inline-app" });\n` +
      `export const weatherTool = defineTool({\n` +
      `  name: "weather",\n` +
      `  description: "Get the weather in a location.",\n` +
      `  inputSchema: { type: "object" },\n` +
      `  execute: async (input) => ({ location: input.location, temperature: 72 }),\n` +
      `});\n` +
      `export const myAgent = defineAgent({\n` +
      `  name: "my-agent",\n` +
      `  provider: { openai: { apiKey: env.OPENAI_API_KEY } },\n` +
      `  model: { provider: "openai", modelId: "gpt-5-mini" },\n` +
      `});\n`,
  );

  return cwd;
}
