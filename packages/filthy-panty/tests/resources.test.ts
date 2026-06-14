import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeGeneratedFiles } from "../src/codegen.ts";
import { loadFilthyPantyRuntimeConfig } from "../src/runtime-config.ts";
import { compileProject } from "../src/manifest.ts";
import { diffManifests } from "../src/sync.ts";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  delete process.env.FILTHY_PANTY_DASHBOARD_URL;
  delete process.env.FILTHY_PANTY_TOKEN;
  delete process.env.FILTHY_PANTY_PROJECT;
  delete process.env.FILTHY_PANTY_ENVIRONMENT;
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

test("compileProject works without a config file and infers project from cwd", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${join(process.cwd(), "src", "resources.ts")}";

export const support = defineAgent("support", {
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`);

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });

  expect(manifest.project).toStartWith("filthy-panty-test-");
  expect(manifest.environment).toBe("development");
});

test("compileProject accepts explicit project override", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${join(process.cwd(), "src", "resources.ts")}";

export const support = defineAgent("support", {
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`);

  const { manifest } = await compileProject({ cwd: cwd, command: "dev", project: "docs-demo" });

  expect(manifest.project).toBe("docs-demo");
});

test("compileProject preserves exported resource aliases for generated api handles", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${join(process.cwd(), "src", "resources.ts")}";

export const myAgent = defineAgent("my-agent", {
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`);

  const { resourceAliases } = await compileProject({ cwd: cwd, command: "dev" });

  expect(resourceAliases.agent).toEqual({ "my-agent": "myAgent" });
});

test("writeGeneratedFiles uses exported resource aliases for api property names", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${join(process.cwd(), "src", "resources.ts")}";

export const myAgent = defineAgent("my-agent", {
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`);
  const { manifest, resourceAliases } = await compileProject({ cwd: cwd, command: "dev" });

  await writeGeneratedFiles(manifest, {
    agents: { "my-agent": "agent_123" },
    workspaces: {},
    sandboxes: {},
    cronJobs: {},
    skills: {},
    tools: {},
  }, cwd, resourceAliases);

  const api = await readFile(join(cwd, "filthypanty", "_generated", "api.ts"), "utf8");

  expect(api).toContain('myAgent: { kind: "agent", name: "my-agent", id: ids.agents["my-agent"]');
  expect(api).not.toContain('"my-agent": { kind: "agent"');
});

test("compileProject loads project and environment from .env.local", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${join(process.cwd(), "src", "resources.ts")}";

export const support = defineAgent("support", {
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`);
  await writeFile(join(cwd, ".env.local"), [
    "FILTHY_PANTY_PROJECT=env-file-project",
    "FILTHY_PANTY_ENVIRONMENT=staging",
    "",
  ].join("\n"));

  const { manifest } = await compileProject({ cwd: cwd, command: "deploy" });

  expect(manifest.project).toBe("env-file-project");
  expect(manifest.environment).toBe("staging");
});

test("compileProject defaults deploy to development without an override", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${join(process.cwd(), "src", "resources.ts")}";

export const support = defineAgent("support", {
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`);

  const { manifest } = await compileProject({ cwd: cwd, command: "deploy" });

  expect(manifest.environment).toBe("development");
});

test("compileProject maps workspace overrides, subagents, skills, and tools", async () => {
  const cwd = await fixtureProject(`
import { defineFilthyPanty } from "${join(process.cwd(), "src", "resources.ts")}";

export default defineFilthyPanty({ project: "typed-app" });
`, `
import { defineAgent, defineSkill, defineTool, defineWorkspace, defineSandbox } from "${join(process.cwd(), "src", "resources.ts")}";

export const docs = defineSkill("greeting-skill", { path: "skills/greeting-skill" });
export const progress = defineTool("stream_progress", {
  path: "tools/stream_progress.mjs",
  description: "Streams progress updates.",
  inputSchema: { type: "object", properties: { steps: { type: "number" } } },
});
export const repo = defineWorkspace("repo", { storage: { provider: "s3" } });
export const readonly = defineWorkspace("readonly", { storage: { provider: "s3" } });
export const runner = defineSandbox("runner", { provider: "lambda" });
export const helper = defineAgent("helper", { model: { provider: "openai", modelId: "gpt-5-mini" } });
export const support = defineAgent("support", {
  model: { provider: "openai", modelId: "gpt-5-mini" },
  sandbox: runner,
  workspaces: [repo, { workspace: readonly, sandbox: null }],
  skills: { enabled: true, allowed: [docs] },
  subagent: { enabled: true, allowed: [helper] },
  tools: { [progress.name]: { enabled: true } },
});
`);
  await mkdir(join(cwd, "filthypanty", "skills", "greeting-skill"), { recursive: true });
  await writeFile(join(cwd, "filthypanty", "skills", "greeting-skill", "SKILL.md"), `---
name: greeting-skill
description: Says hello.
---

# Greeting
`);
  await mkdir(join(cwd, "filthypanty", "tools"), { recursive: true });
  await writeFile(join(cwd, "filthypanty", "tools", "stream_progress.mjs"), "export default { name: 'stream_progress' };\n");

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const support = manifest.resources.find((resource) => resource.kind === "agent" && resource.name === "support");
  const skill = manifest.resources.find((resource) => resource.kind === "skill" && resource.name === "greeting-skill");
  const tool = manifest.resources.find((resource) => resource.kind === "tool" && resource.name === "stream_progress");

  expect(support?.config).toMatchObject({
    sandbox: "runner",
    workspaces: [
      { name: "repo", workspaceId: "repo" },
      { name: "readonly", workspaceId: "readonly", sandbox: null },
    ],
    skills: { enabled: true, allowed: ["greeting-skill"] },
    subagent: { enabled: true, allowed: ["helper"] },
    tools: { stream_progress: { enabled: true } },
  });
  expect(skill?.config).toMatchObject({
    source: "files",
    path: "skills/greeting-skill",
    files: [expect.objectContaining({ path: "SKILL.md", contentBase64: expect.any(String) })],
  });
  expect((tool?.config as Record<string, unknown>).path).toBe("tools/stream_progress.mjs");
  expect((tool?.config as Record<string, unknown>).description).toBe("Streams progress updates.");
  expect((tool?.config as Record<string, unknown>).bundle).toBe("export default { name: 'stream_progress' };\n");
  expect(typeof (tool?.config as Record<string, unknown>).sha256).toBe("string");
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

test("diffManifests treats env refs and remote placeholders as equal", () => {
  const local = {
    version: 1 as const,
    project: "app",
    environment: "dev",
    resources: [
      {
        kind: "agent" as const,
        name: "support",
        config: {
          provider: {
            openai: {
              apiKey: { __beeblastEnv: true, name: "OPENAI_API_KEY" },
            },
          },
        },
      },
    ],
  };
  const remote = {
    version: 1 as const,
    project: "app",
    environment: "dev",
    resources: [
      {
        kind: "agent" as const,
        name: "support",
        config: {
          provider: {
            openai: {
              apiKey: "${OPENAI_API_KEY}",
            },
          },
        },
      },
    ],
  };

  expect(diffManifests(local, remote)).toEqual([]);
});

test("writeGeneratedFiles creates Convex-style typed resource references", async () => {
  const cwd = await fixtureProject();
  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });

  await writeGeneratedFiles(manifest, {
    agents: { support: "agent_123" },
    workspaces: { repo: "workspace_123" },
    sandboxes: {},
    cronJobs: {},
    skills: {},
    tools: {},
  }, cwd);

  const api = await readFile(join(cwd, "filthypanty", "_generated", "api.ts"), "utf8");
  const ids = await readFile(join(cwd, "filthypanty", "_generated", "ids.ts"), "utf8");
  const dataModel = await readFile(join(cwd, "filthypanty", "_generated", "dataModel.ts"), "utf8");

  expect(api).toContain('export const api = {');
  expect(api).toContain('support: { kind: "agent", name: "support", id: ids.agents["support"], project: "typed-app", environment: "development" }');
  expect(ids).toContain('"support": "agent_123"');
  expect(dataModel).toContain("AgentReference");
  expect(api).not.toContain("new FilthyPantyClient");
  await expect(readFile(join(cwd, "filthypanty", "_generated", "client.ts"), "utf8")).rejects.toThrow();
});

test("writeGeneratedFiles only exposes ids for locally declared resources", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${join(process.cwd(), "src", "resources.ts")}";

export const myAgent = defineAgent("my-agent", {
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`);
  const { manifest, resourceAliases } = await compileProject({ cwd: cwd, command: "dev" });

  await writeGeneratedFiles(manifest, {
    agents: { "my-agent": "agent_1", "remote-only": "agent_2" },
    workspaces: { "remote-workspace": "workspace_1" },
    sandboxes: {},
    cronJobs: {},
    skills: {},
    tools: {},
  }, cwd, resourceAliases);

  const api = await readFile(join(cwd, "filthypanty", "_generated", "api.ts"), "utf8");
  const ids = await readFile(join(cwd, "filthypanty", "_generated", "ids.ts"), "utf8");

  expect(api).toContain("myAgent");
  expect(api).not.toContain("remote-only");
  expect(ids).toContain('"my-agent": "agent_1"');
  expect(ids).not.toContain("remote-only");
  expect(ids).not.toContain("remote-workspace");
});

test("runtime config loads .env.local without manual client wiring", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "filthy-panty-env-test-"));
  tempDirs.push(cwd);
  await writeFile(join(cwd, ".env.local"), [
    "FILTHY_PANTY_DASHBOARD_URL=https://dashboard.dev.beeblast.co",
    "FILTHY_PANTY_TOKEN=fp_cli_test",
    "FILTHY_PANTY_PROJECT=sandbox-stateless",
    "FILTHY_PANTY_ENVIRONMENT=development",
    "",
  ].join("\n"));

  const config = loadFilthyPantyRuntimeConfig(cwd);

  expect(config).toEqual({
    dashboardUrl: "https://dashboard.dev.beeblast.co",
    token: "fp_cli_test",
    project: "sandbox-stateless",
    environment: "development",
  });
});

async function fixtureProject(configSource?: string, resourcesSource?: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "filthy-panty-test-"));
  tempDirs.push(cwd);
  const projectDir = join(cwd, "filthypanty");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "filthy-panty.config.ts"), configSource ?? `
import { defineFilthyPanty } from "${join(process.cwd(), "src", "resources.ts")}";

export default defineFilthyPanty({
  project: "typed-app",
  environments: { dev: "development", deploy: "production" },
});
`);
  await writeFile(join(projectDir, "agents.ts"), resourcesSource ?? `
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
