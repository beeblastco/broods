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

test("an inline tool bundle carries neither the SDK nor its sibling agent", async () => {
  const cwd = await inlineFixture();

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const tool = manifest.resources.find((resource) => resource.kind === "tool");
  const bundle = (tool?.config as { bundle: string }).bundle;

  expect(bundle).not.toContain("BroodsClient");
  expect(bundle).not.toContain("gateway.broods.app");
});

async function inlineFixture(): Promise<string> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "broods-inline-")));
  tempDirs.push(cwd);
  const projectDir = join(cwd, "broods");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "agents.ts"),
    `import { defineAgent, defineBroods, defineTool, env } from "${RESOURCES_MODULE}";\n` +
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
