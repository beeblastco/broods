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
  delete process.env.BROODS_BASE_URL;
  delete process.env.BROODS_TOKEN;
  delete process.env.BROODS_PROJECT;
  delete process.env.BROODS_STAGE;
});

test("compileProject maps workspace resources and env refs to the SaaS manifest shape", async () => {
  const cwd = await fixtureProject();

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const agent = manifest.resources.find(
    (resource) => resource.kind === "agent" && resource.name === "support",
  );

  expect(manifest.project).toBe("typed-app");
  expect(manifest.stage).toBe("development");
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
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineWorkspace, env } from "${RESOURCES_MODULE}";

export const repo = defineWorkspace({
  name: "repo",
  description: "Repository workspace",
  storage: { provider: "s3" },
});

export const support = defineAgent({
  name: "support",
  description: "Support assistant",
  provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
  model: { provider: "openai", modelId: "gpt-5-mini" },
  workspaces: [repo],
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });

  expect(manifest.resources).toContainEqual(
    expect.objectContaining({
      kind: "workspace",
      name: "repo",
      description: "Repository workspace",
    }),
  );
  expect(manifest.resources).toContainEqual(
    expect.objectContaining({
      kind: "agent",
      name: "support",
      description: "Support assistant",
    }),
  );
});

test("compileProject emits AI SDK Harness selection", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineHarness, defineSandbox, env } from "${RESOURCES_MODULE}";

export const runner = defineSandbox({
  name: "runner",
  provider: "sandbox",
  persistent: true,
  permissionMode: "bypass",
  network: { mode: "allow-all" },
  onCreate: ["bun install"],
  onResume: ["git status --short"],
});

const harness = defineHarness({
  type: "opencode",
  sandbox: runner,
  activeTools: ["bash", "read", "write"],
  debug: { enabled: true, level: "debug", subsystems: ["bridge"] },
  startupTimeoutMs: 180000,
});

export const coding = defineAgent({
  name: "coding",
  harness,
  provider: {
    custom: {
      apiKey: env("AI_API_KEY"),
      base_url: env("AI_BASE_URL"),
    },
  },
  model: { provider: "custom", modelId: "Qwen3.6-27B" },
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });

  expect(manifest.resources).toContainEqual(
    expect.objectContaining({
      kind: "agent",
      name: "coding",
      config: expect.objectContaining({
        harness: {
          type: "opencode",
          activeTools: ["bash", "read", "write"],
          debug: {
            enabled: true,
            level: "debug",
            subsystems: ["bridge"],
          },
          startupTimeoutMs: 180000,
        },
        sandbox: "runner",
      }),
    }),
  );
});

test("compileProject rejects an unexported AI SDK Harness sandbox", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineHarness, defineSandbox } from "${RESOURCES_MODULE}";

const runner = defineSandbox({
  name: "runner",
  provider: "sandbox",
  persistent: true,
});

export const coding = defineAgent({
  name: "coding",
  harness: defineHarness({ type: "opencode", sandbox: runner }),
  model: { provider: "custom", modelId: "Qwen3.6-27B" },
});
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    'Agent "coding" harness references sandbox "runner", but that sandbox is not exported from broods/',
  );
});

test("compileProject defaults to the Broods harness when harness is omitted", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent } from "${RESOURCES_MODULE}";

export const assistant = defineAgent({
  name: "assistant",
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });

  expect(manifest.resources).toContainEqual(
    expect.objectContaining({
      kind: "agent",
      name: "assistant",
      config: expect.not.objectContaining({
        harness: expect.anything(),
      }),
    }),
  );
});

test("compileProject carries the sandbox size + snapshot knobs into the manifest", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineSandbox } from "${RESOURCES_MODULE}";

export const curated = defineSandbox({
  name: "curated",
  provider: "sandbox", size: "small", snapshot: "img_curated",
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });

  expect(manifest.resources).toContainEqual(
    expect.objectContaining({
      kind: "sandbox",
      name: "curated",
      config: expect.objectContaining({
        provider: "sandbox",
        size: "small",
        snapshot: "img_curated",
      }),
    }),
  );
});

test("compileProject rejects provider-native workspace storage before upload", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineWorkspace } from "${RESOURCES_MODULE}";

export const repo = defineWorkspace({
  name: "repo",
  storage: { provider: "vercel" },
});
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    'Workspace "repo" uses storage.provider "vercel", but Vercel Drive workspace storage is not supported yet',
  );
});

test("compileProject rejects S3 workspaces on an incompatible default sandbox", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineSandbox, defineWorkspace } from "${RESOURCES_MODULE}";

export const repo = defineWorkspace({
  name: "repo",
  storage: { provider: "s3" },
});

export const runner = defineSandbox({
  name: "runner",
  provider: "vercel", persistent: true,
});

export const support = defineAgent({
  name: "support",
  sandbox: runner,
  workspaces: [repo],
});
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    'Agent "support" workspace "repo" uses sandbox "runner" (vercel) which does not support S3 workspace mounts',
  );
});

test("compileProject rejects S3 workspaces on an incompatible workspace sandbox override", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineSandbox, defineWorkspace } from "${RESOURCES_MODULE}";

export const repo = defineWorkspace({
  name: "repo",
  storage: { provider: "s3" },
});

export const defaultRunner = defineSandbox({
  name: "default-runner",
  provider: "lambda",
});

export const e2bRunner = defineSandbox({
  name: "e2b-runner",
  provider: "e2b", network: { mode: "allow-all" }, persistent: true,
});

export const support = defineAgent({
  name: "support",
  sandbox: defaultRunner,
  workspaces: [{ workspace: repo, sandbox: e2bRunner }],
});
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    'Agent "support" workspace "repo" uses sandbox "e2b-runner" (e2b) which does not support S3 workspace mounts',
  );
});

test("compileProject accepts env refs in webhook hook strings", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, env } from "${RESOURCES_MODULE}";

export const webhookAgent = defineAgent({
  name: "webhook-agent",
  provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
  model: { provider: "openai", modelId: "gpt-5-mini" },
  hooks: {
    webhooks: [{
      enabled: true,
      url: env("MOCK_WEBHOOK_URL"),
      secret: env("MOCK_WEBHOOK_SECRET"),
      events: ["agent.started", "agent.finished"],
    }],
  },
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const agent = manifest.resources.find(
    (resource) =>
      resource.kind === "agent" && resource.name === "webhook-agent",
  );

  expect(agent?.config).toMatchObject({
    hooks: {
      webhooks: [
        {
          url: { __beeblastEnv: true, name: "MOCK_WEBHOOK_URL" },
          secret: { __beeblastEnv: true, name: "MOCK_WEBHOOK_SECRET" },
        },
      ],
    },
  });
});

test("compileProject carries the per-agent publicAccess opt-in into the manifest", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, env } from "${RESOURCES_MODULE}";

export const publicAgent = defineAgent({
  name: "public-agent",
  provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
  model: { provider: "openai", modelId: "gpt-5-mini" },
  publicAccess: true,
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const agent = manifest.resources.find(
    (resource) => resource.kind === "agent" && resource.name === "public-agent",
  );

  expect(agent?.config).toMatchObject({ publicAccess: true });
});

test("compileProject carries channel trace settings into the manifest", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineZaloConnection, env } from "${RESOURCES_MODULE}";

export const zalo = defineZaloConnection({
  allowedChannelIds: ["*"],
  botToken: env("ZALO_BOT_TOKEN"),
  webhookSecret: env("ZALO_WEBHOOK_SECRET"),
  trace: "disabled",
});

export const privateReplies = defineAgent({
  name: "private-replies",
  connections: [zalo],
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const agent = manifest.resources.find(
    (resource) =>
      resource.kind === "agent" && resource.name === "private-replies",
  );

  expect(agent?.config).toMatchObject({
    channels: { zalo: { trace: "disabled" } },
  });
});

test("compileProject lowers all typed channel constructors into the existing keyed config", async () => {
  const cwd = await fixtureProject(
    "",
    `
import {
  defineAgent,
  defineTelegramConnection,
  defineGitHubConnection,
  defineSlackConnection,
  defineDiscordConnection,
  definePancakeConnection,
  defineZaloConnection,
  env,
} from "${RESOURCES_MODULE}";

export const telegram = defineTelegramConnection({
  botToken: env("TELEGRAM_BOT_TOKEN"),
  webhookSecret: env("TELEGRAM_WEBHOOK_SECRET"),
  allowedChannelIds: ["123"],
  reactionEmoji: "eyes",
  apiUrl: "https://telegram.example",
});
export const github = defineGitHubConnection({
  appId: env("GITHUB_APP_ID"),
  privateKey: env("GITHUB_PRIVATE_KEY"),
  webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
  allowedChannelIds: ["owner/repo"],
  apiUrl: "https://github.example/api/v3",
});
export const slack = defineSlackConnection({
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
  allowedChannelIds: ["C123"],
  reactionEmoji: "white_check_mark",
  apiUrl: "https://slack.example/api/",
});
export const discord = defineDiscordConnection({
  botToken: env("DISCORD_BOT_TOKEN"),
  publicKey: env("DISCORD_PUBLIC_KEY"),
  allowedChannelIds: ["D123"],
  apiUrl: "https://discord.example/api/v10",
});
export const pancake = definePancakeConnection({
  allowedChannelIds: ["*"],
  pageId: env("PANCAKE_PAGE_ID"),
  pageAccessToken: env("PANCAKE_PAGE_ACCESS_TOKEN"),
  webhookSecret: env("PANCAKE_WEBHOOK_SECRET"),
  senderId: "staff-1",
});
export const zalo = defineZaloConnection({
  allowedChannelIds: ["*"],
  botToken: env("ZALO_BOT_TOKEN"),
  webhookSecret: env("ZALO_WEBHOOK_SECRET"),
  allowedUserIds: ["user-1"],
});

export const support = defineAgent({
  name: "support",
  connections: [telegram, github, slack, discord, pancake, zalo],
});
`,
  );

  const { manifest, channels } = await compileProject({ cwd: cwd, command: "dev" });
  const agent = manifest.resources.find(
    (resource) => resource.kind === "agent",
  )!;

  expect(agent.config).toMatchObject({
    channels: {
      telegram: {
        allowedChannelIds: ["123"],
        reactionEmoji: "eyes",
        apiUrl: "https://telegram.example",
      },
      github: {
        allowedChannelIds: ["owner/repo"],
        apiUrl: "https://github.example/api/v3",
      },
      slack: {
        allowedChannelIds: ["C123"],
        reactionEmoji: "white_check_mark",
        apiUrl: "https://slack.example/api/",
      },
      discord: {
        allowedChannelIds: ["D123"],
        apiUrl: "https://discord.example/api/v10",
      },
      pancake: { senderId: "staff-1", allowedChannelIds: ["*"] },
      zalo: { allowedUserIds: ["user-1"], allowedChannelIds: ["*"] },
    },
  });
  expect(
    channels.map(({ alias, type, agentName }) => ({ alias: alias, type: type, agentName: agentName })),
  ).toEqual([
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
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineGitHubConnection, env } from "${RESOURCES_MODULE}";
export const github = defineGitHubConnection({
  allowedChannelIds: ["*"],
  appId: env("GITHUB_APP_ID"),
  privateKey: env("GITHUB_PRIVATE_KEY"),
  webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
});
export const first = defineAgent({ name: "first", connections: [github] });
export const second = defineAgent({ name: "second", connections: [github] });
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    'Channel github is already attached to agent "first" and cannot also attach to "second"',
  );
});

test("compileProject rejects duplicate channel types on one agent", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineGitHubConnection, env } from "${RESOURCES_MODULE}";
const one = defineGitHubConnection({ appId: env("APP_1"), privateKey: env("KEY_1"), webhookSecret: env("SECRET_1") });
const two = defineGitHubConnection({ appId: env("APP_2"), privateKey: env("KEY_2"), webhookSecret: env("SECRET_2") });
export const support = defineAgent({ name: "support", connections: [one, two] });
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    'Agent "support" cannot configure more than one github channel',
  );
});

test("compileProject lowers partition into the stored workspaceScope", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineGitHubConnection, defineSlackConnection, defineWorkspace, env } from "${RESOURCES_MODULE}";

export const slack = defineSlackConnection({
  allowedChannelIds: ["*"],
  partition: { by: "shared" },
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
});

export const github = defineGitHubConnection({
  allowedChannelIds: ["*"],
  partition: { by: "conversation", alias: "support" },
  appId: env("GITHUB_APP_ID"),
  privateKey: env("GITHUB_PRIVATE_KEY"),
  webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
});

export const repo = defineWorkspace({
  name: "repo",
  storage: { provider: "s3" }, partitioned: true,
});

export const support = defineAgent({
  name: "support",
  connections: [slack, github], workspaces: [repo],
});
`,
  );

  const { manifest, channels } = await compileProject({ cwd: cwd, command: "dev" });
  const agent = manifest.resources.find(
    (resource) => resource.kind === "agent" && resource.name === "support",
  );

  expect(agent?.config).toMatchObject({
    channels: {
      slack: {
        id: "supportSlackChannel",
        workspaceScope: { level: "channel" },
      },
      github: {
        id: "supportGithubChannel",
        workspaceScope: { alias: "support", level: "conversation" },
      },
    },
    workspaces: [{ name: "repo", workspaceId: "repo" }],
  });
  expect(
    channels.map(({ alias, type, id, agentName }) => ({
      alias: alias,
      type: type,
      id: id,
      agentName: agentName,
    })),
  ).toEqual([
    { alias: "github", type: "github", id: "github", agentName: "support" },
    { alias: "slack", type: "slack", id: "slack", agentName: "support" },
  ]);
});

test("compileProject rejects a non-boolean partitioned flag", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineWorkspace } from "${RESOURCES_MODULE}";

export const repo = defineWorkspace({
  name: "repo",
  storage: { provider: "s3" }, partitioned: "channel",
});
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    'Workspace "repo" config.partitioned must be a boolean; string modes are not supported.',
  );
});

test("compileProject auto-generates the channel id for a partitioned connection", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineSlackConnection, defineWorkspace, env } from "${RESOURCES_MODULE}";

export const slack = defineSlackConnection({
  allowedChannelIds: ["*"],
  partition: { by: "shared" },
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
});
export const repo = defineWorkspace({ name: "repo", storage: { provider: "s3" }, partitioned: true });
export const support = defineAgent({ name: "support", connections: [slack], workspaces: [repo] });
`,
  );

  const { manifest, channels } = await compileProject({ cwd: cwd, command: "dev" });
  const agent = manifest.resources.find(
    (resource) => resource.kind === "agent" && resource.name === "support",
  );

  expect(agent?.config).toMatchObject({
    channels: {
      slack: {
        id: "supportSlackChannel",
        workspaceScope: { level: "channel" },
      },
    },
  });
  expect(
    channels.map(({ alias, type, id, agentName }) => ({
      alias: alias,
      type: type,
      id: id,
      agentName: agentName,
    })),
  ).toEqual([
    { alias: "slack", type: "slack", id: "slack", agentName: "support" },
  ]);
});

test("compileProject derives connection reach from the declared channels", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineSlackChannel, defineSlackConnection, env } from "${RESOURCES_MODULE}";

export const slackApp = defineSlackConnection({
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
});
export const desk = defineAgent({ name: "desk", connections: [slackApp] });
export const productEng = defineSlackChannel({
  name: "product-eng",
  connection: slackApp,
  channelId: "C042PRODENG",
});
export const support = defineSlackChannel({
  name: "support",
  connection: slackApp,
  channelId: "C07SUPPORT",
});
`,
  );

  const project = await compileProject({ cwd: cwd, command: "dev" });
  const agent = project.manifest.resources.find(
    (entry) => entry.kind === "agent",
  );
  const slack = (agent?.config as { channels: { slack: unknown } }).channels
    .slack;

  expect(slack).toMatchObject({
    allowedChannelIds: ["C042PRODENG", "C07SUPPORT"],
  });
});

test("compileProject emits the wildcard itself for a wildcard connection", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineTelegramConnection, env } from "${RESOURCES_MODULE}";

export const tgBot = defineTelegramConnection({
  allowedChannelIds: ["*"],
  botToken: env("TELEGRAM_BOT_TOKEN"),
  webhookSecret: env("TELEGRAM_WEBHOOK_SECRET"),
});
export const desk = defineAgent({ name: "desk", connections: [tgBot] });
`,
  );

  const project = await compileProject({ cwd: cwd, command: "dev" });
  const agent = project.manifest.resources.find(
    (entry) => entry.kind === "agent",
  );
  const telegram = (agent?.config as { channels: { telegram: object } })
    .channels.telegram;

  expect(telegram).toMatchObject({ allowedChannelIds: ["*"] });
});

test("compileProject rejects a github channel whose repo names no owner", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineGitHubChannel, defineGitHubConnection, env } from "${RESOURCES_MODULE}";

export const github = defineGitHubConnection({
  appId: env("GITHUB_APP_ID"),
  privateKey: env("GITHUB_PRIVATE_KEY"),
  webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
});
export const platform = defineGitHubChannel({
  name: "platform",
  connection: github,
  repo: "platform",
  agents: [],
});
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    'Channel "platform" repo must be "owner/name", not "platform"',
  );
});

test("compileProject rejects unsafe partition aliases", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineSlackConnection, defineWorkspace, env } from "${RESOURCES_MODULE}";

export const slack = defineSlackConnection({
  allowedChannelIds: ["*"],
  partition: { by: "conversation", alias: "../support" },
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
});
export const repo = defineWorkspace({ name: "repo", storage: { provider: "s3" }, partitioned: true });
export const support = defineAgent({ name: "support", connections: [slack], workspaces: [repo] });
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    'Agent "support" connection "slack" partition.alias must use only letters, numbers, dots, underscores, or hyphens',
  );
});

test("compileProject rejects a channel partition alias that walks out of its namespace", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineSlackChannel, defineSlackConnection, defineWorkspace, env } from "${RESOURCES_MODULE}";

export const slack = defineSlackConnection({
  allowedChannelIds: ["*"],
  partition: { by: "shared" },
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
});
export const repo = defineWorkspace({ name: "repo", storage: { provider: "s3" }, partitioned: true });
export const support = defineAgent({ name: "support", connections: [slack], workspaces: [repo] });
export const escape = defineSlackChannel({
  name: "escape",
  connection: slack,
  channelId: "C042ESCAPE",
  partition: { by: "conversation", alias: ".." },
});
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    'Channel "escape" partition.alias must not be "." or ".."',
  );
});

test("compileProject rejects unknown partition modes", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineSlackConnection, defineWorkspace, env } from "${RESOURCES_MODULE}";

export const slack = defineSlackConnection({
  allowedChannelIds: ["*"],
  partition: { by: "workspace", alias: "support" },
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
});
export const repo = defineWorkspace({ name: "repo", storage: { provider: "s3" }, partitioned: true });
export const support = defineAgent({ name: "support", connections: [slack], workspaces: [repo] });
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    'Agent "support" connection "slack" partition.by must be one of: shared, conversation',
  );
});

test("compileProject rejects a partitioned connection with no partitioned workspace", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineSlackConnection, defineWorkspace, env } from "${RESOURCES_MODULE}";

export const slack = defineSlackConnection({
  allowedChannelIds: ["*"],
  partition: { by: "shared" },
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
});
export const repo = defineWorkspace({ name: "repo", storage: { provider: "s3" } });
export const support = defineAgent({ name: "support", connections: [slack], workspaces: [repo] });
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    'Agent "support" connection "slack" defines partition, but no attached workspace has partitioned: true.',
  );
});

test("compileProject rejects a partitioned workspace when a connection lacks partition", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineGitHubConnection, defineSlackConnection, defineWorkspace, env } from "${RESOURCES_MODULE}";

export const slack = defineSlackConnection({
  allowedChannelIds: ["*"],
  partition: { by: "shared" },
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
});
export const github = defineGitHubConnection({
  allowedChannelIds: ["*"],
  appId: env("GITHUB_APP_ID"),
  privateKey: env("GITHUB_PRIVATE_KEY"),
  webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
});
export const repo = defineWorkspace({ name: "repo", storage: { provider: "s3" }, partitioned: true });
export const support = defineAgent({ name: "support", connections: [slack, github], workspaces: [repo] });
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    'Agent "support" attaches partitioned workspace "repo", but connection "github" does not define partition.',
  );
});

test("compileProject rejects duplicate channel ids", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineGitHubConnection, defineSlackConnection, defineWorkspace, env } from "${RESOURCES_MODULE}";

export const slack = defineSlackConnection({
  allowedChannelIds: ["*"],
  id: "support-channel",
  partition: { by: "shared" },
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
});
export const github = defineGitHubConnection({
  allowedChannelIds: ["*"],
  id: "support-channel",
  partition: { by: "conversation", alias: "support" },
  appId: env("GITHUB_APP_ID"),
  privateKey: env("GITHUB_PRIVATE_KEY"),
  webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
});
export const repo = defineWorkspace({ name: "repo", storage: { provider: "s3" }, partitioned: true });
export const support = defineAgent({ name: "support", connections: [slack, github], workspaces: [repo] });
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    "Duplicate channel id: support-channel",
  );
});

test("compileProject rejects keyed channel configuration", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, env } from "${RESOURCES_MODULE}";
export const support = defineAgent({
  name: "support",
  channels: { github: { appId: env("APP_ID"), privateKey: env("PRIVATE_KEY"), webhookSecret: env("WEBHOOK_SECRET") } },
});
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    'Agent "support" has an unknown config key "channels". Did you mean "connections"?',
  );
});

test("compileProject keeps uploaded tool bundles intact beside typed channels", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineGitHubConnection, defineTool, env } from "${RESOURCES_MODULE}";
export const github = defineGitHubConnection({
  allowedChannelIds: ["*"],
  appId: env("GITHUB_APP_ID"),
  privateKey: env("GITHUB_PRIVATE_KEY"),
  webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
});
export const helper = defineTool({
  name: "helper",
  path: "tools/helper.ts",
  description: "Returns a result",
  inputSchema: { type: "object", properties: {} },
});
export const support = defineAgent({
  name: "support",
  connections: [github], tools: { [helper.name]: { enabled: true, needsApproval: false } },
});
`,
  );
  await mkdir(join(cwd, "broods", "tools"), { recursive: true });
  await writeFile(
    join(cwd, "broods", "tools", "helper.ts"),
    "export default { execute: async (_ctx: unknown, input: { value?: string }) => ({ ok: true, value: input.value }) };\n",
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const tool = manifest.resources.find((resource) => resource.kind === "tool");
  const agent = manifest.resources.find(
    (resource) => resource.kind === "agent",
  );
  expect(tool?.config).toMatchObject({
    path: "tools/helper.ts",
    description: "Returns a result",
  });
  expect(typeof (tool?.config as { bundle?: unknown }).bundle).toBe("string");
  expect((tool?.config as { bundle: string }).bundle).not.toContain(
    "_ctx: unknown",
  );
  expect(agent?.config).toMatchObject({
    channels: { github: {} },
    tools: { helper: { enabled: true, needsApproval: false } },
  });
});

test("compileProject rejects env refs in account-wide tool defaults", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineTool, env } from "${RESOURCES_MODULE}";
export const helper = defineTool({
  name: "helper",
  description: "Returns a configured value",
  inputSchema: { type: "object", properties: {} },
  defaultConfig: { apiToken: env("TOOL_API_TOKEN") },
  execute(_input, options) {
    return { configured: options.context.config.apiToken };
  },
});
export const support = defineAgent({
  name: "support",
  tools: { [helper.name]: { enabled: true } },
});
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    `Tool "helper" defaultConfig cannot contain env("NAME") references; put environment variable values in the agent's tools.<tool>.config`,
  );
});

test("compileProject emits inline agent hooks as one synthetic hook bundle", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, env } from "${RESOURCES_MODULE}";
export const support = defineAgent({
  name: "support",
  hooks: {
    onStart: (ctx, event: { system: string; messages: unknown[] }) => ({
      system: event.system + "\\n\\nBe terse.",
    }),
    onToolCall: (_ctx, event) =>
      event.toolName === "bash"
        ? { decision: "deny", denyReason: "no shell" }
        : { decision: "allow" },
    webhooks: [{
      url: env("MOCK_WEBHOOK_URL"),
      secret: env("MOCK_WEBHOOK_SECRET"),
      events: ["agent.started"],
    }],
  },
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const hook = manifest.resources.find((resource) => resource.kind === "hook");
  const agent = manifest.resources.find(
    (resource) => resource.kind === "agent",
  );
  const bundle = (hook?.config as { bundle?: unknown }).bundle;
  expect(hook?.name).toBe("support-hooks");
  expect(hook?.description).toBe("Inline hooks for agent support");
  expect(hook?.config).toMatchObject({
    events: ["agent.started", "tool.call.started"],
  });
  expect(typeof bundle).toBe("string");
  expect(bundle as string).toContain("export default");
  expect(bundle as string).toContain('"agent.started"');
  expect(bundle as string).toContain('"tool.call.started"');
  expect(bundle as string).not.toContain("event: { system: string");
  expect(typeof (hook?.config as { sha256?: unknown }).sha256).toBe("string");
  expect(agent?.config).toMatchObject({
    hooks: {
      webhooks: [
        {
          url: { __beeblastEnv: true, name: "MOCK_WEBHOOK_URL" },
          secret: { __beeblastEnv: true, name: "MOCK_WEBHOOK_SECRET" },
        },
      ],
      code: [{ hookId: "support-hooks" }],
    },
  });
});

test("compileProject serializes method-shorthand hooks into valid function expressions", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent } from "${RESOURCES_MODULE}";
export const support = defineAgent({
  name: "support",
  hooks: {
    onStart(_ctx, event: { system: string; messages: unknown[] }) {
      return { system: event.system + "\\n\\nBe terse." };
    },
    async onFinish(_ctx, event) {
      return { output: event.response };
    },
  },
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const hook = manifest.resources.find((resource) => resource.kind === "hook");
  const bundle = (hook?.config as { bundle: string }).bundle;
  // Shorthand `onStart(ctx) {}` toString is not a valid expression on its own;
  // the manifest must emit it as a function expression or the bundle won't parse.
  expect(bundle).toContain('"agent.started": function onStart');
  expect(bundle).toContain('"agent.finished": async function onFinish');
});

test('collectEnvRefNames returns sorted, de-duplicated env("NAME") references', async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, env } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
  model: { provider: "openai", modelId: "gpt-5-mini" },
});

export const billing = defineAgent({
  name: "billing",
  provider: { custom: { apiKey: env("STRIPE_API_KEY"), baseURL: env("OPENAI_API_KEY") } },
  model: { provider: "custom", modelId: "gpt-5-mini" },
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });

  expect(collectEnvRefNames(manifest)).toEqual([
    "OPENAI_API_KEY",
    "STRIPE_API_KEY",
  ]);
});

test("collectEnvRefNames returns nothing when no env refs are present", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });

  expect(collectEnvRefNames(manifest)).toEqual([]);
});

test("compileProject works without a config file and infers project from cwd", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });

  expect(manifest.project).toStartWith("broods-test-");
  expect(manifest.stage).toBe("development");
});

test("compileProject accepts explicit project override", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`,
  );

  const { manifest } = await compileProject({
    cwd: cwd,
    command: "dev",
    project: "docs-demo",
  });

  expect(manifest.project).toBe("docs-demo");
});

test("compileProject preserves exported resource aliases for generated api handles", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent } from "${RESOURCES_MODULE}";

export const myAgent = defineAgent({
  name: "my-agent",
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`,
  );

  const { resourceAliases } = await compileProject({
    cwd: cwd,
    command: "dev",
  });

  expect(resourceAliases.agent).toEqual({ "my-agent": "myAgent" });
});

test("writeGeneratedFiles uses exported resource aliases for api property names", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent } from "${RESOURCES_MODULE}";

export const myAgent = defineAgent({
  name: "my-agent",
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`,
  );
  const { manifest, resourceAliases } = await compileProject({
    cwd: cwd,
    command: "dev",
  });

  await writeGeneratedFiles(
    manifest,
    {
      agents: { "my-agent": "agent_123" },
      workspaces: {},
      sandboxes: {},
      crons: {},
      skills: {},
      tools: {},
      hooks: {},
    },
    cwd,
    resourceAliases,
  );

  const api = await readFile(
    join(cwd, "broods", "_generated", "api.ts"),
    "utf8",
  );

  expect(api).toContain(
    'myAgent: { kind: "agent", name: "my-agent", id: ids.agents["my-agent"]',
  );
  expect(api).not.toContain('"my-agent": { kind: "agent"');
});

test("writeGeneratedFiles keys non-agent resources by export alias under api.crons", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineWorkspace, defineCron } from "${RESOURCES_MODULE}";

export const cron = defineAgent({
  name: "cron-agent",
  model: { provider: "openai", modelId: "gpt-5-mini" },
});

export const myRepo = defineWorkspace({
  name: "my-repo",
  storage: { provider: "s3" },
});

export const oneMinuteCron = defineCron({
  name: "one-minute-cron-test",
  agent: cron,
  conversationKey: "cron:test",
  input: "Confirm the test ran.",
  scheduleExpression: "at(2030-01-01T00:00:00)",
  timezone: "UTC",
});
`,
  );
  const { manifest, resourceAliases } = await compileProject({
    cwd: cwd,
    command: "dev",
  });

  await writeGeneratedFiles(
    manifest,
    {
      agents: { "cron-agent": "agent_1" },
      workspaces: { "my-repo": "workspace_1" },
      sandboxes: {},
      crons: { "one-minute-cron-test": "cron_1" },
      skills: {},
      tools: {},
      hooks: {},
    },
    cwd,
    resourceAliases,
  );

  const api = await readFile(
    join(cwd, "broods", "_generated", "api.ts"),
    "utf8",
  );

  // Renamed namespace + export-name keys pointing at the unchanged ids contract.
  expect(api).toContain("crons: {");
  expect(api).toContain('oneMinuteCron: ids.crons["one-minute-cron-test"],');
  expect(api).toContain('myRepo: ids.workspaces["my-repo"],');
  expect(api).not.toContain("crons: ids.crons");
  expect(api).not.toContain('"one-minute-cron-test":');
  // Kinds with no local resources stay as an empty literal.
  expect(api).toContain("sandboxes: {}");
});

test("compileProject loads project and stage from .env.local", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`,
  );
  await writeFile(
    join(cwd, ".env.local"),
    ["BROODS_PROJECT=env-file-project", "BROODS_STAGE=staging", ""].join("\n"),
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "deploy" });

  expect(manifest.project).toBe("env-file-project");
  expect(manifest.stage).toBe("staging");
});

test("compileProject defaults deploy to production without an override", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`,
  );
  const { manifest } = await compileProject({ cwd: cwd, command: "deploy" });

  expect(manifest.stage).toBe("production");
});

test("compileProject can ignore runtime env when deploy uses command defaults", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`,
  );
  await writeFile(
    join(cwd, ".env.local"),
    ["BROODS_STAGE=development", ""].join("\n"),
  );

  const { manifest } = await compileProject({
    cwd: cwd,
    command: "deploy",
    useRuntimeStage: false,
  });

  expect(manifest.stage).toBe("production");
});

test("compileProject maps workspace overrides, subagents, skills, and tools", async () => {
  const cwd = await fixtureProject(
    `
import { defineBroods } from "${RESOURCES_MODULE}";

export default defineBroods({ project: "typed-app" });
`,
    `
import { defineAgent, defineSkill, defineTool, defineWorkspace, defineSandbox } from "${RESOURCES_MODULE}";

export const docs = defineSkill({
  name: "greeting-skill",
  path: "skills/greeting-skill",
});
export const progress = defineTool({
  name: "stream_progress",
  path: "tools/stream_progress.mjs",
  description: "Streams progress updates.",
  inputSchema: { type: "object", properties: { steps: { type: "number" } } },
});
export const repo = defineWorkspace({ name: "repo", storage: { provider: "s3" } });
export const readonly = defineWorkspace({ name: "readonly", storage: { provider: "s3" } });
export const runner = defineSandbox({ name: "runner", provider: "lambda" });
export const helper = defineAgent({
  name: "helper",
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
export const support = defineAgent({
  name: "support",
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
});
`,
  );
  await mkdir(join(cwd, "broods", "skills", "greeting-skill"), {
    recursive: true,
  });
  await writeFile(
    join(cwd, "broods", "skills", "greeting-skill", "SKILL.md"),
    `---
name: greeting-skill
description: Says hello.
---

# Greeting
`,
  );
  await mkdir(join(cwd, "broods", "tools"), { recursive: true });
  await writeFile(
    join(cwd, "broods", "tools", "stream_progress.mjs"),
    "export default { name: 'stream_progress' };\n",
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const support = manifest.resources.find(
    (resource) => resource.kind === "agent" && resource.name === "support",
  );
  const skill = manifest.resources.find(
    (resource) =>
      resource.kind === "skill" && resource.name === "greeting-skill",
  );
  const tool = manifest.resources.find(
    (resource) =>
      resource.kind === "tool" && resource.name === "stream_progress",
  );

  expect(support?.config).toMatchObject({
    agent: {
      system: [
        {
          role: "system",
          content: "Use the support policy.",
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        },
      ],
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
    files: [
      expect.objectContaining({
        path: "SKILL.md",
        contentBase64: expect.any(String),
      }),
    ],
  });
  expect((tool?.config as Record<string, unknown>).path).toBe(
    "tools/stream_progress.mjs",
  );
  expect((tool?.config as Record<string, unknown>).description).toBe(
    "Streams progress updates.",
  );
  expect((tool?.config as Record<string, unknown>).bundle).toContain(
    'name: "stream_progress"',
  );
  expect(typeof (tool?.config as Record<string, unknown>).sha256).toBe(
    "string",
  );
});

test("compileProject maps policy resources and agent policy refs", async () => {
  const cwd = await fixtureProject(
    `
import { defineBroods } from "${RESOURCES_MODULE}";

export default defineBroods({ project: "typed-app" });
`,
    `
import { defineAgent, definePolicy } from "${RESOURCES_MODULE}";

export const filesystemPolicy = definePolicy({
  name: "filesystem-guard",
  description: "Restricts workspace writes.",
  rules: [
    { id: "allow-read", effect: "allow", actions: ["workspace.read"] },
    {
      id: "deny-secrets",
      effect: "deny",
      actions: ["workspace.write"],
      resources: { filePaths: ["/workspace/secrets"] },
    },
  ],
});

export const support = defineAgent({
  name: "support",
  model: { provider: "openai", modelId: "gpt-5-mini" },
  policy: { mode: "audit", policies: [filesystemPolicy] },
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const policy = manifest.resources.find(
    (resource) =>
      resource.kind === "policy" && resource.name === "filesystem-guard",
  );
  const agent = manifest.resources.find(
    (resource) => resource.kind === "agent" && resource.name === "support",
  );

  expect(policy?.description).toBe("Restricts workspace writes.");
  expect(policy?.config).toMatchObject({
    version: 1,
    rules: [
      { id: "allow-read", effect: "allow", actions: ["workspace.read"] },
      {
        id: "deny-secrets",
        effect: "deny",
        actions: ["workspace.write"],
        resources: { filePaths: ["/workspace/secrets"] },
      },
    ],
  });
  expect(agent?.config).toMatchObject({
    policy: {
      mode: "audit",
      policyIds: ["filesystem-guard"],
    },
  });
});

test("compileProject drops empty agent policy config", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  model: { provider: "openai", modelId: "gpt-5-mini" },
  policy: {},
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const agent = manifest.resources.find(
    (resource) => resource.kind === "agent" && resource.name === "support",
  );

  expect(agent?.config).not.toHaveProperty("policy");
});

test("compileProject rejects unknown agent policy config keys", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent } from "${RESOURCES_MODULE}";

export const support = defineAgent({
  name: "support",
  model: { provider: "openai", modelId: "gpt-5-mini" },
  policy: { enabbled: true },
});
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    'Agent "support" config.policy.enabbled is not supported',
  );
});

test("compileProject rejects skill and tool paths outside broods project root", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineSkill, defineTool } from "${RESOURCES_MODULE}";

export const escapedSkill = defineSkill({
  name: "escaped-skill",
  path: "../outside-skill",
});

export const escapedTool = defineTool({
  name: "escaped_tool",
  path: "../outside-tool.mjs",
  description: "Should not bundle.",
  inputSchema: { type: "object" },
});
`,
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    "must stay inside broods/",
  );
});

test("compileProject skips hidden and secret-looking files from skill bundles", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineSkill } from "${RESOURCES_MODULE}";

export const docs = defineSkill({
  name: "safe-skill",
  path: "skills/safe-skill",
});
`,
  );
  const skillRoot = join(cwd, "broods", "skills", "safe-skill");
  await mkdir(join(skillRoot, ".cache"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "# Safe\n");
  await writeFile(join(skillRoot, "notes.txt"), "ok\n");
  await writeFile(join(skillRoot, ".env"), "TOKEN=secret\n");
  await writeFile(join(skillRoot, ".cache", "payload.txt"), "secret\n");
  await writeFile(join(skillRoot, "private.pem"), "secret\n");

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const skill = manifest.resources.find(
    (resource) => resource.kind === "skill" && resource.name === "safe-skill",
  );
  const files = (
    (skill?.config as Record<string, unknown>).files as Array<{ path: string }>
  ).map((file) => file.path);

  expect(files.sort()).toEqual(["SKILL.md", "notes.txt"].sort());
});

test("compileProject rejects hidden or secret-looking tool bundle paths", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineTool } from "${RESOURCES_MODULE}";

export const hiddenTool = defineTool({
  name: "hidden_tool",
  path: ".secret/tool.mjs",
  description: "Should not bundle.",
  inputSchema: { type: "object" },
});
`,
  );
  await mkdir(join(cwd, "broods", ".secret"), { recursive: true });
  await writeFile(
    join(cwd, "broods", ".secret", "tool.mjs"),
    "export default {};\n",
  );

  await expect(compileProject({ cwd: cwd, command: "dev" })).rejects.toThrow(
    "looks like a hidden file or secret",
  );
});

test("diffManifests reports create, update, and delete operations", () => {
  const local = {
    version: 1 as const,
    project: "app",
    stage: "dev",
    resources: [
      { kind: "agent" as const, name: "new", config: { a: 1 } },
      { kind: "workspace" as const, name: "changed", config: { a: 2 } },
    ],
  };
  const remote = {
    version: 1 as const,
    project: "app",
    stage: "dev",
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
    stage: "dev",
    resources: [
      {
        kind: "agent" as const,
        name: "async-search",
        config: { model: { provider: "google", modelId: "gemma" } },
      },
    ],
  };
  const remote = {
    version: 1 as const,
    project: "app",
    stage: "dev",
    resources: [
      {
        kind: "agent" as const,
        name: "async-search-assistant",
        config: { model: { provider: "google", modelId: "gemma" } },
      },
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
    stage: "dev",
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
    stage: "dev",
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

  await writeGeneratedFiles(
    manifest,
    {
      agents: { support: "agent_123" },
      workspaces: { repo: "workspace_123" },
      sandboxes: {},
      crons: {},
      skills: {},
      tools: {},
      hooks: {},
    },
    cwd,
  );

  const api = await readFile(
    join(cwd, "broods", "_generated", "api.ts"),
    "utf8",
  );
  const ids = await readFile(
    join(cwd, "broods", "_generated", "ids.ts"),
    "utf8",
  );
  const dataModel = await readFile(
    join(cwd, "broods", "_generated", "dataModel.ts"),
    "utf8",
  );

  expect(api).toContain("export const api = {");
  expect(api).toContain(
    'support: { kind: "agent", name: "support", id: ids.agents["support"], project: "typed-app", stage: "development" }',
  );
  expect(ids).toContain('"support": "agent_123"');
  expect(dataModel).toContain("AgentReference");
  expect(api).not.toContain("new BroodsClient");
  await expect(
    readFile(join(cwd, "broods", "_generated", "client.ts"), "utf8"),
  ).rejects.toThrow();
});

test("writeGeneratedFiles emits typed channel references with authoritative webhook paths", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineGitHubConnection, env } from "${RESOURCES_MODULE}";
export const github = defineGitHubConnection({ allowedChannelIds: ["*"], appId: env("APP_ID"), privateKey: env("KEY"), webhookSecret: env("SECRET") });
export const support = defineAgent({ name: "support", connections: [github] });
`,
  );
  const { manifest, resourceAliases, channels } = await compileProject({
    cwd: cwd,
    command: "dev",
  });
  await writeGeneratedFiles(
    manifest,
    {
      agents: { support: "agent/123" },
      workspaces: {},
      sandboxes: {},
      crons: {},
      skills: {},
      tools: {},
      hooks: {},
    },
    cwd,
    resourceAliases,
    {
      accountId: "account/123",
      endpointId: "endpoint-1",
      projectSlug: "typed-app",
      stageSlug: "development",
    },
    channels,
  );

  const api = await readFile(
    join(cwd, "broods", "_generated", "api.ts"),
    "utf8",
  );
  expect(api).toContain('github: { kind: "channel", type: "github"');
  expect(api).toContain('webhookPath: "/webhooks/account%2F123/github"');
  // client.ts and websocket.ts build the scoped invoke URL from this field.
  expect(api).toContain('stageSlug: "development"');
});

test("writeGeneratedFiles marks the webhook path of a stage that is not production", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent, defineGitHubConnection, env } from "${RESOURCES_MODULE}";
export const github = defineGitHubConnection({ allowedChannelIds: ["*"], appId: env("APP_ID"), privateKey: env("KEY"), webhookSecret: env("SECRET") });
export const support = defineAgent({ name: "support", connections: [github] });
`,
  );
  const { manifest, resourceAliases, channels } = await compileProject({
    cwd: cwd,
    command: "dev",
  });
  await writeGeneratedFiles(
    manifest,
    {
      agents: { support: "agent/123" },
      workspaces: {},
      sandboxes: {},
      crons: {},
      skills: {},
      tools: {},
      hooks: {},
    },
    cwd,
    resourceAliases,
    {
      accountId: "account/123",
      endpointId: "stage-abcd1234",
      projectSlug: "typed-app",
      stageSlug: "na-test",
      stageKind: "development",
    },
    channels,
  );

  const api = await readFile(
    join(cwd, "broods", "_generated", "api.ts"),
    "utf8",
  );
  expect(api).toContain(
    'webhookPath: "/webhooks/account%2F123/dev/stage-abcd1234/github"',
  );
});

test("writeGeneratedFiles only exposes ids for locally declared resources", async () => {
  const cwd = await fixtureProject(
    "",
    `
import { defineAgent } from "${RESOURCES_MODULE}";

export const myAgent = defineAgent({
  name: "my-agent",
  model: { provider: "openai", modelId: "gpt-5-mini" },
});
`,
  );
  const { manifest, resourceAliases } = await compileProject({
    cwd: cwd,
    command: "dev",
  });

  await writeGeneratedFiles(
    manifest,
    {
      agents: { "my-agent": "agent_1", "remote-only": "agent_2" },
      workspaces: { "remote-workspace": "workspace_1" },
      sandboxes: {},
      crons: {},
      skills: {},
      tools: {},
      hooks: {},
    },
    cwd,
    resourceAliases,
  );

  const api = await readFile(
    join(cwd, "broods", "_generated", "api.ts"),
    "utf8",
  );
  const ids = await readFile(
    join(cwd, "broods", "_generated", "ids.ts"),
    "utf8",
  );

  expect(api).toContain("myAgent");
  expect(api).not.toContain("remote-only");
  expect(ids).toContain('"my-agent": "agent_1"');
  expect(ids).not.toContain("remote-only");
  expect(ids).not.toContain("remote-workspace");
});

test("runtime config loads .env.local without manual client wiring", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "broods-env-test-"));
  tempDirs.push(cwd);
  await writeFile(
    join(cwd, ".env.local"),
    [
      "BROODS_DASHBOARD_URL=https://dashboard.dev.broods.app",
      // Pin baseUrl too: without it the field falls back to ~/.broods/config.json
      // stored auth, which exists on logged-in dev machines but not in CI.
      "BROODS_BASE_URL=https://gateway.dev.broods.app",
      "BROODS_TOKEN=fp_cli_test",
      "BROODS_PROJECT=sandbox-stateless",
      "BROODS_STAGE=development",
      "",
    ].join("\n"),
  );

  const config = loadBroodsRuntimeConfig(cwd);

  expect(config).toEqual({
    dashboardUrl: "https://dashboard.dev.broods.app",
    baseUrl: "https://gateway.dev.broods.app",
    token: "fp_cli_test",
    project: "sandbox-stateless",
    stage: "development",
  });
});

test("compileProject emits the SDK calling-convention adapter for defineTool bundles", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "broods-test-"));
  tempDirs.push(cwd);
  const projectDir = join(cwd, "broods");
  await mkdir(join(projectDir, "tools"), { recursive: true });
  await writeFile(
    join(projectDir, "broods.config.ts"),
    `import { defineBroods } from "${RESOURCES_MODULE}";\nexport default defineBroods({ project: "tool-app" });\n`,
  );
  // Authoring stays broods-native: execute(ctx, input).
  await writeFile(
    join(projectDir, "tools", "echo.ts"),
    `export default { name: "echo_tool", async execute(ctx, input) { return { echo: input, cfgSeen: ctx.config }; } };\n`,
  );
  await writeFile(
    join(projectDir, "tools.ts"),
    `import { defineTool } from "${RESOURCES_MODULE}";
export const echoTool = defineTool({
  name: "echo_tool",
  path: "tools/echo.ts", description: "Echo", inputSchema: { type: "object" },
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const tool = manifest.resources.find((resource) => resource.kind === "tool");
  const bundle = (tool?.config as { bundle?: string } | undefined)?.bundle;
  expect(typeof bundle).toBe("string");

  // The runtime calls execute(input, options) with ctx at options.context; the
  // emitted adapter must map that back to the author's execute(ctx, input).
  const builtDir = await mkdtemp(join(tmpdir(), "broods-built-"));
  tempDirs.push(builtDir);
  const builtPath = join(builtDir, "tool.mjs");
  await writeFile(builtPath, bundle!, "utf8");
  const mod = await import(builtPath);
  // The shim forwards the author's name so the isolate runner's manifest-name
  // integrity check still fires for adapter-built tools.
  expect(mod.default.name).toBe("echo_tool");
  const result = await mod.default.execute(
    { q: "hi" },
    { context: { config: { a: 1 } }, toolCallId: "call_1" },
  );
  expect(result).toEqual({ echo: { q: "hi" }, cfgSeen: { a: 1 } });
});

// A channel record is the one resource that binds a place to an agent rather
// than describing the agent, so its refs must survive compilation by name — the
// backend resolves them to ids, and a raw agent name reaching Convex would bind
// to nothing.
test("compileProject lowers a channel onto its connection, agents and policy", async () => {
  const cwd = await fixtureProject(
    undefined,
    `
import { defineAgent, definePolicy, defineSlackChannel, defineSlackConnection, env } from "${RESOURCES_MODULE}";

export const opsOnly = definePolicy({
  name: "ops-only",
  rules: [{ id: "r1", effect: "deny", actions: ["agent.invoke"] }],
});

export const slackApp = defineSlackConnection({
  allowedChannelIds: ["*"],
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
});

export const desk = defineAgent({
  name: "desk",
  model: { provider: "openai", modelId: "gpt-5-mini" },
  connections: [slackApp],
});

export const scribe = defineAgent({
  name: "scribe",
  model: { provider: "openai", modelId: "gpt-5-mini" },
});

export const productEng = defineSlackChannel({
  name: "product-eng",
  connection: slackApp,
  channelId: "C042PRODENG",
  teamId: "T09BEEBLAST",
  agents: [desk, { agent: scribe, reply: false }],
  policies: [opsOnly],
  instructions: "Escalate billing to #finance.",
  threadPolicy: "always-thread",
});
`,
  );

  const { manifest } = await compileProject({ cwd: cwd, command: "dev" });
  const record = manifest.resources.find(
    (resource) => resource.kind === "channelRecord",
  );

  expect(record?.name).toBe("product-eng");
  // `platform` comes off the connection and the credentials never follow it.
  expect(record?.config).toEqual({
    platform: "slack",
    externalId: "C042PRODENG",
    workspaceRef: "T09BEEBLAST",
    agents: ["desk", { agent: "scribe", reply: false }],
    policies: ["ops-only"],
    instructions: "Escalate billing to #finance.",
    threadPolicy: "always-thread",
  });
});

async function fixtureProject(
  configSource?: string,
  resourcesSource?: string,
): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "broods-test-"));
  tempDirs.push(cwd);
  const projectDir = join(cwd, "broods");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "broods.config.ts"),
    configSource ??
      `
import { defineBroods } from "${RESOURCES_MODULE}";

export default defineBroods({
  project: "typed-app",
  stages: { dev: "development", deploy: "production" },
});
`,
  );
  await writeFile(
    join(projectDir, "agents.ts"),
    resourcesSource ??
      `
import { defineAgent, defineWorkspace, env } from "${RESOURCES_MODULE}";

export const repo = defineWorkspace({
  name: "repo",
  storage: { provider: "s3" },
});

export const support = defineAgent({
  name: "support",
  provider: {
    openai: { apiKey: env("OPENAI_API_KEY") },
  },
  model: {
    provider: "openai",
    modelId: "gpt-5-mini",
  },
  workspaces: [repo],
});
`,
  );

  return cwd;
}
