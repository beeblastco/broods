import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Run in a `node` child: Bun loads TypeScript natively and would pass either way.
// File URLs: a Windows path in a module specifier turns its separators into escapes.
const MANIFEST_MODULE = pathToFileURL(
  join(import.meta.dir, "..", "src", "manifest.ts"),
).href;
const RESOURCES_MODULE = pathToFileURL(
  join(import.meta.dir, "..", "src", "resources.ts"),
).href;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function fixtureProject(source: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "broods-node-runtime-"));
  tempDirs.push(cwd);
  await mkdir(join(cwd, "broods"), { recursive: true });
  await writeFile(join(cwd, "broods", "agents.ts"), source, "utf8");

  return cwd;
}

async function compileWithNode(
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const script = `
    const { compileProject } = await import(${JSON.stringify(MANIFEST_MODULE)});
    const { manifest } = await compileProject({ cwd: ${JSON.stringify(cwd)}, command: "dev" });
    console.log(JSON.stringify(manifest.resources));
  `;
  const proc = Bun.spawn({
    cmd: ["node", "--input-type=module", "-e", script],
    cwd: cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode: exitCode, stdout: stdout, stderr: stderr };
}

test("node compiles a resource file Node's own loader cannot strip", async () => {
  const cwd = await fixtureProject(`
import { defineAgent } from "${RESOURCES_MODULE}";

enum Tone {
  terse = "terse",
}

export const support = defineAgent({
  name: "support",
  model: { provider: "openai", modelId: "gpt-5-mini" },
  agent: { system: Tone.terse },
});
`);

  const result = await compileWithNode(cwd);

  expect(result.stderr).not.toContain("enum is not supported");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    {
      kind: "agent",
      name: "support",
      config: {
        model: { provider: "openai", modelId: "gpt-5-mini" },
        agent: { system: "terse" },
      },
    },
  ]);
});

test("node keeps a resource file's own module URL", async () => {
  const cwd = await fixtureProject(`
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  model: { provider: "openai", modelId: "gpt-5-mini" },
  agent: { system: new URL(".", import.meta.url).pathname },
});
`);

  const result = await compileWithNode(cwd);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(join(cwd, "broods"));
});

test.each([
  ["./prompts/support", "support.ts"],
  ["./prompts/support.js", "support.ts"],
  ["./prompts", "index.ts"],
  ["./prompts/support.en", "support.en.ts"],
])("node resolves %s to the .ts file Bun would", async (specifier, file) => {
  const cwd = await fixtureProject(`
import { defineAgent } from "${RESOURCES_MODULE}";
import { SYSTEM } from "${specifier}";

export const support = defineAgent({
  name: "support",
  model: { provider: "openai", modelId: "gpt-5-mini" },
  agent: { system: SYSTEM },
});
`);
  await mkdir(join(cwd, "broods", "prompts"), { recursive: true });
  await writeFile(
    join(cwd, "broods", "prompts", file),
    'export const SYSTEM: string = "be brief";\n',
    "utf8",
  );

  const result = await compileWithNode(cwd);

  expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("be brief");
});
