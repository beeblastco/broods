import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeGeneratedFiles } from "../src/codegen.ts";
import { compileProject } from "../src/manifest.ts";
import { diffManifests } from "../src/sync.ts";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

test("compileProject maps workspace resources and env refs to the SaaS manifest shape", async () => {
  const cwd = await fixtureProject();

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const agent = manifest.resources.find((resource) => resource.kind === "agent" && resource.name === "support");

  expect(manifest.project).toBe("typed-app");
  expect(manifest.environment).toBe("development");
  expect(agent?.config).toEqual({
    provider: {
      openai: {
        apiKey: {
          __beeblastEnv: true,
          name: "OPENAI_API_KEY",
        },
      },
    },
    model: {
      provider: "openai",
      modelId: "gpt-5-mini",
    },
    workspaces: [{ name: "repo", workspaceId: "repo" }],
  });
});

test("diffManifests reports create, update, and delete operations", () => {
  const local = {
    version: 1 as const,
    project: "app",
    environment: "dev",
    resources: [
      { kind: "agent" as const, name: "new", config: { a: 1 } },
      { kind: "workspace" as const, name: "changed", config: { a: 2 } },
    ],
  };
  const remote = {
    version: 1 as const,
    project: "app",
    environment: "dev",
    resources: [
      { kind: "workspace" as const, name: "changed", config: { a: 1 } },
      { kind: "sandbox" as const, name: "old", config: { provider: "lambda" } },
    ],
  };

  expect(diffManifests(local, remote)).toEqual([
    { operation: "create", kind: "agent", name: "new" },
    { operation: "delete", kind: "sandbox", name: "old" },
    { operation: "update", kind: "workspace", name: "changed" },
  ]);
});

test("writeGeneratedFiles creates typed IDs and client files", async () => {
  const cwd = await fixtureProject();
  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });

  await writeGeneratedFiles(manifest, {
    agents: { support: "agent_123" },
    workspaces: { repo: "workspace_123" },
    sandboxes: {},
    cronJobs: {},
  }, cwd);

  const client = await readFile(join(cwd, "filthypanty", "generated", "client.ts"), "utf8");
  const ids = await readFile(join(cwd, "filthypanty", "generated", "ids.ts"), "utf8");

  expect(client).toContain('"support": client.agent("support", ids.agents["support"])');
  expect(ids).toContain('"support": "agent_123"');
});

async function fixtureProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "filthy-panty-test-"));
  tempDirs.push(cwd);
  const projectDir = join(cwd, "filthypanty");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "filthy-panty.config.ts"), `
import { defineFilthyPanty } from "${join(process.cwd(), "src", "resources.ts")}";

export default defineFilthyPanty({
  project: "typed-app",
  environments: { dev: "development", deploy: "production" },
});
`);
  await writeFile(join(projectDir, "agents.ts"), `
import { defineAgent, defineWorkspace, env } from "${join(process.cwd(), "src", "resources.ts")}";

export const repo = defineWorkspace("repo", {
  storage: { provider: "s3" },
});

export const support = defineAgent("support", {
  provider: {
    openai: { apiKey: env("OPENAI_API_KEY") },
  },
  model: {
    provider: "openai",
    modelId: "gpt-5-mini",
  },
  workspaces: [repo],
});
`);

  return cwd;
}
