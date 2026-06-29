import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeGeneratedFiles } from "../src/codegen.ts";
import { loadBroodsRuntimeConfig } from "../src/runtime-config.ts";
import { collectEnvRefNames, compileProject } from "../src/manifest.ts";
import { diffManifests } from "../src/sync.ts";

// Resolve the SDK entrypoint relative to this test file so generated fixtures
// import it regardless of the cwd the suite runs from (repo root or package dir).
const RESOURCES_MODULE = join(import.meta.dir, "..", "src", "resources.ts");

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  delete process.env.BROODS_DASHBOARD_URL;
  delete process.env.BROODS_TOKEN;
  delete process.env.BROODS_PROJECT;
  delete process.env.BROODS_ENVIRONMENT;
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

test("compileProject accepts object-shaped resource definitions", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent, defineWorkspace, env } from "${RESOURCES_MODULE}";

export const repo = defineWorkspace({
  name: "repo",
  description: "Repository workspace",
  config: { storage: { provider: "s3" } },
});

export const support = defineAgent({
  name: "support",
  description: "Support assistant",
  config: {
    provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
    model: { provider: "openai", modelId: "gpt-5-mini" },
    workspaces: [repo],
  },
});
`);

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });

  expect(manifest.resources).toContainEqual(expect.objectContaining({
    kind: "workspace",
    name: "repo",
    description: "Repository workspace",
  }));
  expect(manifest.resources).toContainEqual(expect.objectContaining({
    kind: "agent",
    name: "support",
    description: "Support assistant",
  }));
});

test("compileProject carries the sandbox size + snapshot knobs into the manifest", async () => {
  const cwd = await fixtureProject("", `
import { defineSandbox } from "${RESOURCES_MODULE}";

export const curated = defineSandbox({
  name: "curated",
  config: { provider: "sandbox", size: "small", snapshot: "img_curated" },
});
`);

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });

  expect(manifest.resources).toContainEqual(expect.objectContaining({
    kind: "sandbox",
    name: "curated",
    config: expect.objectContaining({ provider: "sandbox", size: "small", snapshot: "img_curated" }),
  }));
});

test("compileProject rejects provider-native workspace storage before upload", async () => {
  const cwd = await fixtureProject("", `
import { defineWorkspace } from "${RESOURCES_MODULE}";

export const repo = defineWorkspace({
  name: "repo",
  config: { storage: { provider: "vercel" } },
});
`);

  await expect(compileProject({ cwd: cwd, command: "dev" }))
    .rejects.toThrow('Workspace "repo" uses storage.provider "vercel", but Vercel Drive workspace storage is not supported yet');
});

test("compileProject rejects S3 workspaces on an incompatible default sandbox", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent, defineSandbox, defineWorkspace } from "${RESOURCES_MODULE}";

export const repo = defineWorkspace({
  name: "repo",
  config: { storage: { provider: "s3" } },
});

export const runner = defineSandbox({
  name: "runner",
  config: { provider: "vercel", persistent: true },
});

export const support = defineAgent({
  name: "support",
  config: {
    sandbox: runner,
    workspaces: [repo],
  },
});
`);

  await expect(compileProject({ cwd: cwd, command: "dev" }))
    .rejects.toThrow('Agent "support" workspace "repo" uses sandbox "runner" (vercel) which does not support S3 workspace mounts');
});

test("compileProject rejects S3 workspaces on an incompatible workspace sandbox override", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent, defineSandbox, defineWorkspace } from "${RESOURCES_MODULE}";

export const repo = defineWorkspace({
  name: "repo",
  config: { storage: { provider: "s3" } },
});

export const defaultRunner = defineSandbox({
  name: "default-runner",
  config: { provider: "lambda" },
});

export const e2bRunner = defineSandbox({
  name: "e2b-runner",
  config: { provider: "e2b", network: { mode: "allow-all" }, persistent: true },
});

export const support = defineAgent({
  name: "support",
  config: {
    sandbox: defaultRunner,
    workspaces: [{ workspace: repo, sandbox: e2bRunner }],
  },
});
`);

  await expect(compileProject({ cwd: cwd, command: "dev" }))
    .rejects.toThrow('Agent "support" workspace "repo" uses sandbox "e2b-runner" (e2b) which does not support S3 workspace mounts');
});

test("compileProject accepts env refs in webhook hook strings", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent, env } from "${RESOURCES_MODULE}";

export const webhookAgent = defineAgent({
  name: "webhook-agent",
  config: {
    provider: { openai: { apiKey: env.OPENAI_API_KEY } },
    model: { provider: "openai", modelId: "gpt-5-mini" },
    hooks: {
      webhooks: [{
        enabled: true,
        url: env.MOCK_WEBHOOK_URL,
        secret: env.MOCK_WEBHOOK_SECRET,
        events: ["agent.started", "agent.finished"],
      }],
    },
  },
});
`);

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const agent = manifest.resources.find((resource) => resource.kind === "agent" && resource.name === "webhook-agent");

  expect(agent?.config).toMatchObject({
    hooks: {
      webhooks: [{
        url: { __beeblastEnv: true, name: "MOCK_WEBHOOK_URL" },
        secret: { __beeblastEnv: true, name: "MOCK_WEBHOOK_SECRET" },
      }],
    },
  });
});

test("compileProject carries the per-agent publicAccess opt-in into the manifest", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent, env } from "${RESOURCES_MODULE}";

export const publicAgent = defineAgent({
  name: "public-agent",
  config: {
    provider: { openai: { apiKey: env.OPENAI_API_KEY } },
    model: { provider: "openai", modelId: "gpt-5-mini" },
    publicAccess: true,
  },
});
`);

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const agent = manifest.resources.find((resource) => resource.kind === "agent" && resource.name === "public-agent");

  expect(agent?.config).toMatchObject({ publicAccess: true });
});

test("compileProject lowers all typed channel constructors into the existing keyed config", async () => {
  const cwd = await fixtureProject("", `
import {
  defineAgent,
  defineTelegramChannel,
  defineGitHubChannel,
  defineSlackChannel,
  defineDiscordChannel,
  definePancakeChannel,
  defineZaloChannel,
  env,
} from "${RESOURCES_MODULE}";

export const telegram = defineTelegramChannel({
  botToken: env.TELEGRAM_BOT_TOKEN,
  webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
  allowedChatIds: [123],
  reactionEmoji: "eyes",
  apiUrl: "https://telegram.example",
});
export const github = defineGitHubChannel({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_PRIVATE_KEY,
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  allowedRepos: ["owner/repo"],
  apiUrl: "https://github.example/api/v3",
});
export const slack = defineSlackChannel({
  botToken: env.SLACK_BOT_TOKEN,
  signingSecret: env.SLACK_SIGNING_SECRET,
  allowedChannelIds: ["C123"],
  reactionEmoji: "white_check_mark",
  apiUrl: "https://slack.example/api/",
});
export const discord = defineDiscordChannel({
  botToken: env.DISCORD_BOT_TOKEN,
  publicKey: env.DISCORD_PUBLIC_KEY,
  allowedGuildIds: ["G123"],
  apiUrl: "https://discord.example/api/v10",
});
export const pancake = definePancakeChannel({
  pageId: env.PANCAKE_PAGE_ID,
  pageAccessToken: env.PANCAKE_PAGE_ACCESS_TOKEN,
  webhookSecret: env.PANCAKE_WEBHOOK_SECRET,
  senderId: "staff-1",
  ignoreTagIds: ["handoff"],
});
export const zalo = defineZaloChannel({
  botToken: env.ZALO_BOT_TOKEN,
  webhookSecret: env.ZALO_WEBHOOK_SECRET,
  allowedUserIds: ["user-1"],
});

export const support = defineAgent({
  name: "support",
  config: { channels: [telegram, github, slack, discord, pancake, zalo] },
});
`);

  const { manifest, channels } = await compileProject({ cwd, command: "dev" });
  const agent = manifest.resources.find((resource) => resource.kind === "agent")!;

  expect(agent.config).toMatchObject({
    channels: {
      telegram: { allowedChatIds: [123], reactionEmoji: "eyes", apiUrl: "https://telegram.example" },
      github: { allowedRepos: ["owner/repo"], apiUrl: "https://github.example/api/v3" },
      slack: { allowedChannelIds: ["C123"], reactionEmoji: "white_check_mark", apiUrl: "https://slack.example/api/" },
      discord: { allowedGuildIds: ["G123"], apiUrl: "https://discord.example/api/v10" },
      pancake: { senderId: "staff-1", options: { ignoreTagIds: ["handoff"] } },
      zalo: { allowedUserIds: ["user-1"] },
    },
  });
  expect(channels.map(({ alias, type, agentName }) => ({ alias, type, agentName }))).toEqual([
    { alias: "discord", type: "discord", agentName: "support" },
    { alias: "github", type: "github", agentName: "support" },
    { alias: "pancake", type: "pancake", agentName: "support" },
    { alias: "slack", type: "slack", agentName: "support" },
    { alias: "telegram", type: "telegram", agentName: "support" },
    { alias: "zalo", type: "zalo", agentName: "support" },
  ]);
  expect(collectEnvRefNames(manifest)).toContain("GITHUB_PRIVATE_KEY");
});

test("compileProject rejects a channel reused by two agents", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent, defineGitHubChannel, env } from "${RESOURCES_MODULE}";
export const github = defineGitHubChannel({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_PRIVATE_KEY,
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
});
export const first = defineAgent({ name: "first", config: { channels: [github] } });
export const second = defineAgent({ name: "second", config: { channels: [github] } });
`);

  await expect(compileProject({ cwd, command: "dev" })).rejects.toThrow(
    'Channel github is already attached to agent "first" and cannot also attach to "second"',
  );
});

test("compileProject rejects duplicate channel types on one agent", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent, defineGitHubChannel, env } from "${RESOURCES_MODULE}";
const one = defineGitHubChannel({ appId: env.APP_1, privateKey: env.KEY_1, webhookSecret: env.SECRET_1 });
const two = defineGitHubChannel({ appId: env.APP_2, privateKey: env.KEY_2, webhookSecret: env.SECRET_2 });
export const support = defineAgent({ name: "support", config: { channels: [one, two] } });
`);

  await expect(compileProject({ cwd, command: "dev" })).rejects.toThrow(
    'Agent "support" cannot configure more than one github channel',
  );
});

test("compileProject rejects keyed channel configuration", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent, env } from "${RESOURCES_MODULE}";
export const support = defineAgent({
  name: "support",
  config: { channels: { github: { appId: env.APP_ID, privateKey: env.PRIVATE_KEY, webhookSecret: env.WEBHOOK_SECRET } } },
});
`);

  await expect(compileProject({ cwd, command: "dev" })).rejects.toThrow(
    'Agent "support" config.channels must be an array of channel definitions',
  );
});

test("compileProject keeps uploaded tool bundles intact beside typed channels", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent, defineGitHubChannel, defineTool, env } from "${RESOURCES_MODULE}";
export const github = defineGitHubChannel({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_PRIVATE_KEY,
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
});
export const helper = defineTool({
  name: "helper",
  config: {
    path: "tools/helper.ts",
    description: "Returns a result",
    inputSchema: { type: "object", properties: {} },
  },
});
export const support = defineAgent({
  name: "support",
  config: { channels: [github], tools: { [helper.name]: { enabled: true, needsApproval: false } } },
});
`);
  await mkdir(join(cwd, "broods", "tools"), { recursive: true });
  await writeFile(
    join(cwd, "broods", "tools", "helper.ts"),
    "export default { execute: async (_ctx: unknown, input: { value?: string }) => ({ ok: true, value: input.value }) };\n",
  );

  const { manifest } = await compileProject({ cwd, command: "dev" });
  const tool = manifest.resources.find((resource) => resource.kind === "tool");
  const agent = manifest.resources.find((resource) => resource.kind === "agent");
  expect(tool?.config).toMatchObject({ path: "tools/helper.ts", description: "Returns a result" });
  expect(typeof (tool?.config as { bundle?: unknown }).bundle).toBe("string");
  expect((tool?.config as { bundle: string }).bundle).not.toContain("_ctx: unknown");
  expect(agent?.config).toMatchObject({
    channels: { github: {} },
    tools: { helper: { enabled: true, needsApproval: false } },
  });
});

test("collectEnvRefNames returns the sorted, de-duplicated env.NAME references", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent, env } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  config: {
    provider: { openai: { apiKey: env.OPENAI_API_KEY } },
    model: { provider: "openai", modelId: "gpt-5-mini" },
  },
});

export const billing = defineAgent({
  name: "billing",
  config: {
    provider: { stripe: { apiKey: env("STRIPE_API_KEY"), webhook: env.OPENAI_API_KEY } },
    model: { provider: "openai", modelId: "gpt-5-mini" },
  },
});
`);

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });

  expect(collectEnvRefNames(manifest)).toEqual(["OPENAI_API_KEY", "STRIPE_API_KEY"]);
});

test("collectEnvRefNames returns nothing when no env refs are present", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  config: {
    model: { provider: "openai", modelId: "gpt-5-mini" },
  },
});
`);

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });

  expect(collectEnvRefNames(manifest)).toEqual([]);
});

test("compileProject works without a config file and infers project from cwd", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  config: {
    model: { provider: "openai", modelId: "gpt-5-mini" },
  },
});
`);

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });

  expect(manifest.project).toStartWith("broods-test-");
  expect(manifest.environment).toBe("development");
});

test("compileProject accepts explicit project override", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  config: {
    model: { provider: "openai", modelId: "gpt-5-mini" },
  },
});
`);

  const { manifest } = await compileProject({ cwd: cwd, command: "dev", project: "docs-demo" });

  expect(manifest.project).toBe("docs-demo");
});

test("compileProject preserves exported resource aliases for generated api handles", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${RESOURCES_MODULE}";

export const myAgent = defineAgent({
  name: "my-agent",
  config: {
    model: { provider: "openai", modelId: "gpt-5-mini" },
  },
});
`);

  const { resourceAliases } = await compileProject({ cwd: cwd, command: "dev" });

  expect(resourceAliases.agent).toEqual({ "my-agent": "myAgent" });
});

test("writeGeneratedFiles uses exported resource aliases for api property names", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${RESOURCES_MODULE}";

export const myAgent = defineAgent({
  name: "my-agent",
  config: {
    model: { provider: "openai", modelId: "gpt-5-mini" },
  },
});
`);
  const { manifest, resourceAliases } = await compileProject({ cwd: cwd, command: "dev" });

  await writeGeneratedFiles(manifest, {
    agents: { "my-agent": "agent_123" },
    workspaces: {},
    sandboxes: {},
    crons: {},
    skills: {},
    tools: {},
  }, cwd, resourceAliases);

  const api = await readFile(join(cwd, "broods", "_generated", "api.ts"), "utf8");

  expect(api).toContain('myAgent: { kind: "agent", name: "my-agent", id: ids.agents["my-agent"]');
  expect(api).not.toContain('"my-agent": { kind: "agent"');
});

test("writeGeneratedFiles keys non-agent resources by export alias under api.crons", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent, defineWorkspace, defineCron } from "${RESOURCES_MODULE}";

export const cron = defineAgent({
  name: "cron-agent",
  config: {
    model: { provider: "openai", modelId: "gpt-5-mini" },
  },
});

export const myRepo = defineWorkspace({
  name: "my-repo",
  config: {
    storage: { provider: "s3" },
  },
});

export const oneMinuteCron = defineCron({
  name: "one-minute-cron-test",
  config: {
    agent: cron,
    conversationKey: "cron:test",
    input: "Confirm the test ran.",
    scheduleExpression: "at(2030-01-01T00:00:00)",
    timezone: "UTC",
  },
});
`);
  const { manifest, resourceAliases } = await compileProject({ cwd: cwd, command: "dev" });

  await writeGeneratedFiles(manifest, {
    agents: { "cron-agent": "agent_1" },
    workspaces: { "my-repo": "workspace_1" },
    sandboxes: {},
    crons: { "one-minute-cron-test": "cron_1" },
    skills: {},
    tools: {},
  }, cwd, resourceAliases);

  const api = await readFile(join(cwd, "broods", "_generated", "api.ts"), "utf8");

  // Renamed namespace + export-name keys pointing at the unchanged ids contract.
  expect(api).toContain('crons: {');
  expect(api).toContain('oneMinuteCron: ids.crons["one-minute-cron-test"],');
  expect(api).toContain('myRepo: ids.workspaces["my-repo"],');
  expect(api).not.toContain('crons: ids.crons');
  expect(api).not.toContain('"one-minute-cron-test":');
  // Kinds with no local resources stay as an empty literal.
  expect(api).toContain('sandboxes: {}');
});

test("compileProject loads project and environment from .env.local", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  config: {
    model: { provider: "openai", modelId: "gpt-5-mini" },
  },
});
`);
  await writeFile(join(cwd, ".env.local"), [
    "BROODS_PROJECT=env-file-project",
    "BROODS_ENVIRONMENT=staging",
    "",
  ].join("\n"));

  const { manifest } = await compileProject({ cwd: cwd, command: "deploy" });

  expect(manifest.project).toBe("env-file-project");
  expect(manifest.environment).toBe("staging");
});

test("compileProject defaults deploy to production without an override", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  config: {
    model: { provider: "openai", modelId: "gpt-5-mini" },
  },
});
`);

  const { manifest } = await compileProject({ cwd: cwd, command: "deploy" });

  expect(manifest.environment).toBe("production");
});

test("compileProject can ignore runtime env when deploy uses command defaults", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  config: {
    model: { provider: "openai", modelId: "gpt-5-mini" },
  },
});
`);
  await writeFile(join(cwd, ".env.local"), [
    "BROODS_ENVIRONMENT=development",
    "",
  ].join("\n"));

  const { manifest } = await compileProject({
    cwd: cwd,
    command: "deploy",
    useRuntimeEnvironment: false,
  });

  expect(manifest.environment).toBe("production");
});

test("compileProject maps workspace overrides, subagents, skills, and tools", async () => {
  const cwd = await fixtureProject(`
import { defineBroods } from "${RESOURCES_MODULE}";

export default defineBroods({ project: "typed-app" });
`, `
import { defineAgent, defineSkill, defineTool, defineWorkspace, defineSandbox } from "${RESOURCES_MODULE}";

export const docs = defineSkill({
  name: "greeting-skill",
  config: { path: "skills/greeting-skill" },
});
export const progress = defineTool({
  name: "stream_progress",
  config: {
    path: "tools/stream_progress.mjs",
    description: "Streams progress updates.",
    inputSchema: { type: "object", properties: { steps: { type: "number" } } },
  },
});
export const repo = defineWorkspace({ name: "repo", config: { storage: { provider: "s3" } } });
export const readonly = defineWorkspace({ name: "readonly", config: { storage: { provider: "s3" } } });
export const runner = defineSandbox({ name: "runner", config: { provider: "lambda" } });
export const helper = defineAgent({
  name: "helper",
  config: { model: { provider: "openai", modelId: "gpt-5-mini" } },
});
export const support = defineAgent({
  name: "support",
  config: {
    agent: {
      system: [{
        role: "system",
        content: "Use the support policy.",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      }],
    },
    model: { provider: "openai", modelId: "gpt-5-mini" },
    sandbox: runner,
    workspaces: [repo, { workspace: readonly, sandbox: null }],
    skills: { enabled: true, allowed: [docs] },
    subagent: { enabled: true, allowed: [helper] },
    tools: { [progress.name]: { enabled: true } },
  },
});
`);
  await mkdir(join(cwd, "broods", "skills", "greeting-skill"), { recursive: true });
  await writeFile(join(cwd, "broods", "skills", "greeting-skill", "SKILL.md"), `---
name: greeting-skill
description: Says hello.
---

# Greeting
`);
  await mkdir(join(cwd, "broods", "tools"), { recursive: true });
  await writeFile(join(cwd, "broods", "tools", "stream_progress.mjs"), "export default { name: 'stream_progress' };\n");

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const support = manifest.resources.find((resource) => resource.kind === "agent" && resource.name === "support");
  const skill = manifest.resources.find((resource) => resource.kind === "skill" && resource.name === "greeting-skill");
  const tool = manifest.resources.find((resource) => resource.kind === "tool" && resource.name === "stream_progress");

  expect(support?.config).toMatchObject({
    agent: {
      system: [{
        role: "system",
        content: "Use the support policy.",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      }],
    },
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
  expect((tool?.config as Record<string, unknown>).bundle).toContain('name: "stream_progress"');
  expect(typeof (tool?.config as Record<string, unknown>).sha256).toBe("string");
});

test("compileProject rejects skill and tool paths outside broods project root", async () => {
  const cwd = await fixtureProject("", `
import { defineSkill, defineTool } from "${RESOURCES_MODULE}";

export const escapedSkill = defineSkill({
  name: "escaped-skill",
  config: { path: "../outside-skill" },
});

export const escapedTool = defineTool({
  name: "escaped_tool",
  config: {
    path: "../outside-tool.mjs",
    description: "Should not bundle.",
    inputSchema: { type: "object" },
  },
});
`);

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow("must stay inside broods/");
});

test("compileProject skips hidden and secret-looking files from skill bundles", async () => {
  const cwd = await fixtureProject("", `
import { defineSkill } from "${RESOURCES_MODULE}";

export const docs = defineSkill({
  name: "safe-skill",
  config: { path: "skills/safe-skill" },
});
`);
  const skillRoot = join(cwd, "broods", "skills", "safe-skill");
  await mkdir(join(skillRoot, ".cache"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "# Safe\n");
  await writeFile(join(skillRoot, "notes.txt"), "ok\n");
  await writeFile(join(skillRoot, ".env"), "TOKEN=secret\n");
  await writeFile(join(skillRoot, ".cache", "payload.txt"), "secret\n");
  await writeFile(join(skillRoot, "private.pem"), "secret\n");

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const skill = manifest.resources.find((resource) => resource.kind === "skill" && resource.name === "safe-skill");
  const files = ((skill?.config as Record<string, unknown>).files as Array<{ path: string }>).map((file) => file.path);

  expect(files.sort()).toEqual(["SKILL.md", "notes.txt"].sort());
});

test("compileProject rejects hidden or secret-looking tool bundle paths", async () => {
  const cwd = await fixtureProject("", `
import { defineTool } from "${RESOURCES_MODULE}";

export const hiddenTool = defineTool({
  name: "hidden_tool",
  config: {
    path: ".secret/tool.mjs",
    description: "Should not bundle.",
    inputSchema: { type: "object" },
  },
});
`);
  await mkdir(join(cwd, "broods", ".secret"), { recursive: true });
  await writeFile(join(cwd, "broods", ".secret", "tool.mjs"), "export default {};\n");

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow("looks like a hidden file or secret");
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
    { operation: "update", kind: "workspace", name: "changed" },
    { operation: "delete", kind: "sandbox", name: "old" },
  ]);
});

test("diffManifests reports a pure resource rename without delete prompt noise", () => {
  const local = {
    version: 1 as const,
    project: "app",
    environment: "dev",
    resources: [
      { kind: "agent" as const, name: "async-search", config: { model: { provider: "google", modelId: "gemma" } } },
    ],
  };
  const remote = {
    version: 1 as const,
    project: "app",
    environment: "dev",
    resources: [
      { kind: "agent" as const, name: "async-search-assistant", config: { model: { provider: "google", modelId: "gemma" } } },
    ],
  };

  expect(diffManifests(local, remote)).toEqual([
    {
      operation: "rename",
      kind: "agent",
      previousName: "async-search-assistant",
      name: "async-search",
    },
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
    crons: {},
    skills: {},
    tools: {},
  }, cwd);

  const api = await readFile(join(cwd, "broods", "_generated", "api.ts"), "utf8");
  const ids = await readFile(join(cwd, "broods", "_generated", "ids.ts"), "utf8");
  const dataModel = await readFile(join(cwd, "broods", "_generated", "dataModel.ts"), "utf8");

  expect(api).toContain('export const api = {');
  expect(api).toContain('support: { kind: "agent", name: "support", id: ids.agents["support"], project: "typed-app", environment: "development" }');
  expect(ids).toContain('"support": "agent_123"');
  expect(dataModel).toContain("AgentReference");
  expect(api).not.toContain("new BroodsClient");
  await expect(readFile(join(cwd, "broods", "_generated", "client.ts"), "utf8")).rejects.toThrow();
});

test("writeGeneratedFiles emits typed channel references with authoritative webhook paths", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent, defineGitHubChannel, env } from "${RESOURCES_MODULE}";
export const github = defineGitHubChannel({ appId: env.APP_ID, privateKey: env.KEY, webhookSecret: env.SECRET });
export const support = defineAgent({ name: "support", config: { channels: [github] } });
`);
  const { manifest, resourceAliases, channels } = await compileProject({ cwd, command: "dev" });
  await writeGeneratedFiles(manifest, {
    agents: { support: "agent/123" }, workspaces: {}, sandboxes: {}, crons: {}, skills: {}, tools: {},
  }, cwd, resourceAliases, {
    accountId: "account/123",
    endpointId: "endpoint-1",
    projectSlug: "typed-app",
    environmentSlug: "development",
  }, channels);

  const api = await readFile(join(cwd, "broods", "_generated", "api.ts"), "utf8");
  expect(api).toContain('github: { kind: "channel", type: "github"');
  expect(api).toContain('webhookPath: "/webhooks/account%2F123/agent%2F123/github"');
});

test("writeGeneratedFiles only exposes ids for locally declared resources", async () => {
  const cwd = await fixtureProject("", `
import { defineAgent } from "${RESOURCES_MODULE}";

export const myAgent = defineAgent({
  name: "my-agent",
  config: {
    model: { provider: "openai", modelId: "gpt-5-mini" },
  },
});
`);
  const { manifest, resourceAliases } = await compileProject({ cwd: cwd, command: "dev" });

  await writeGeneratedFiles(manifest, {
    agents: { "my-agent": "agent_1", "remote-only": "agent_2" },
    workspaces: { "remote-workspace": "workspace_1" },
    sandboxes: {},
    crons: {},
    skills: {},
    tools: {},
  }, cwd, resourceAliases);

  const api = await readFile(join(cwd, "broods", "_generated", "api.ts"), "utf8");
  const ids = await readFile(join(cwd, "broods", "_generated", "ids.ts"), "utf8");

  expect(api).toContain("myAgent");
  expect(api).not.toContain("remote-only");
  expect(ids).toContain('"my-agent": "agent_1"');
  expect(ids).not.toContain("remote-only");
  expect(ids).not.toContain("remote-workspace");
});

test("runtime config loads .env.local without manual client wiring", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "broods-env-test-"));
  tempDirs.push(cwd);
  await writeFile(join(cwd, ".env.local"), [
    "BROODS_DASHBOARD_URL=https://dashboard.dev.broods.app",
    "BROODS_TOKEN=fp_cli_test",
    "BROODS_PROJECT=sandbox-stateless",
    "BROODS_ENVIRONMENT=development",
    "",
  ].join("\n"));

  const config = loadBroodsRuntimeConfig(cwd);

  expect(config).toEqual({
    dashboardUrl: "https://dashboard.dev.broods.app",
    token: "fp_cli_test",
    project: "sandbox-stateless",
    environment: "development",
  });
});

async function fixtureProject(configSource?: string, resourcesSource?: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "broods-test-"));
  tempDirs.push(cwd);
  const projectDir = join(cwd, "broods");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "broods.config.ts"), configSource ?? `
import { defineBroods } from "${RESOURCES_MODULE}";

export default defineBroods({
  project: "typed-app",
  environments: { dev: "development", deploy: "production" },
});
`);
  await writeFile(join(projectDir, "agents.ts"), resourcesSource ?? `
import { defineAgent, defineWorkspace, env } from "${RESOURCES_MODULE}";

export const repo = defineWorkspace({
  name: "repo",
  config: {
    storage: { provider: "s3" },
  },
});

export const support = defineAgent({
  name: "support",
  config: {
    provider: {
      openai: { apiKey: env("OPENAI_API_KEY") },
    },
    model: {
      provider: "openai",
      modelId: "gpt-5-mini",
    },
    workspaces: [repo],
  },
});
`);

  return cwd;
}
