#!/usr/bin/env bun
/**
 * CLI entry point for code-first filthy-panty resources.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { watch } from "node:fs";
import { compileProject } from "../manifest.ts";
import { GENERATED_DIR, PROJECT_DIR } from "../config.ts";
import { writeGeneratedFiles } from "../codegen.ts";
import { diffManifests, FilthyPantySyncClient } from "../sync.ts";
import { FilthyPantyClient } from "../client.ts";
import { loadFilthyPantyRuntimeConfig } from "../runtime-config.ts";
import { hasFlag, loginWithBrowser, optionValue, promptSecret, requireAuth } from "./utils.ts";

const VERSION = "0.1.0";
const DEFAULT_DASHBOARD_URL = "https://dashboard.beeblast.co";

const HELP = `filthy-panty v${VERSION}

Usage: filthy-panty <command>

Commands:
  init                 Create a filthypanty/ project shell
  login                Authenticate with WorkOS through the dashboard
  dev                  Watch resources and sync non-destructive changes
  diff                 Show local desired state vs remote state
  deploy               Sync resources once (--prune deletes undeclared remote resources)
  env set <name>       Store an encrypted environment variable
  logs                 Fetch recent SaaS/runtime logs
  run <agent> <prompt> Run an agent and stream the result

Options:
  --dashboard-url <url> Dashboard base URL (default: ${DEFAULT_DASHBOARD_URL})
  --project <name>      Project name override (default: package name or folder)
  --env <name>          Target environment override
  --prune               Allow deploy to delete undeclared remote resources
  --force               Allow init to overwrite starter files`;

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case undefined:
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case "init":
      await init(args);
      return;
    case "login":
      await login(args);
      return;
    case "diff":
      await diff(args);
      return;
    case "deploy":
      await deploy(args);
      return;
    case "dev":
      await dev(args);
      return;
    case "env":
      await envCommand(args);
      return;
    case "logs":
      await logs(args);
      return;
    case "run":
      await run(args);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

async function init(args: string[]): Promise<void> {
  const force = hasFlag(args, "--force");
  const root = resolve(process.cwd(), PROJECT_DIR);
  await mkdir(resolve(root, GENERATED_DIR), { recursive: true });
  await writeStarter(resolve(root, "agents.ts"), starterAgent(), force);
  await writeStarter(resolve(root, ".gitignore"), "_generated/*.tmp\n.cache/\n", force);
  console.log(`Created ${PROJECT_DIR}/`);
}

async function login(args: string[]): Promise<void> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log("Usage: filthy-panty login [--dashboard-url <url>]");
    return;
  }
  const runtime = loadFilthyPantyRuntimeConfig();
  const dashboardUrl = optionValue(args, "--dashboard-url") ??
    runtime.dashboardUrl ??
    DEFAULT_DASHBOARD_URL;
  const auth = await loginWithBrowser(dashboardUrl);
  console.log(`Logged in to ${auth.dashboardUrl}`);
}

async function diff(args: string[]): Promise<void> {
  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "dev",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const client = new FilthyPantySyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
  const remote = await client.getManifest(manifest.project, manifest.environment);
  printDiff(diffManifests(manifest, remote?.manifest ?? null));
}

async function deploy(args: string[]): Promise<void> {
  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "deploy",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const client = new FilthyPantySyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
  const result = await client.putManifest(manifest, hasFlag(args, "--prune"));
  await writeGeneratedFiles(result.manifest, result.ids);
  console.log(`Synced ${result.manifest.resources.length} resources to ${manifest.project}/${manifest.environment}`);
}

async function dev(args: string[]): Promise<void> {
  await syncDev(args);
  console.log(`Watching ${PROJECT_DIR}/`);

  let timer: NodeJS.Timeout | undefined;
  let syncing = false;
  let pending = false;

  const runSync = (): void => {
    if (syncing) {
      pending = true;
      return;
    }
    syncing = true;
    syncDev(args)
      .catch((error) => console.error(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        syncing = false;
        if (pending) {
          pending = false;
          runSync();
        }
      });
  };

  const watcher = watch(resolve(process.cwd(), PROJECT_DIR), { recursive: true }, (_event, filename) => {
    if (!filename || filename.includes("generated")) return;
    clearTimeout(timer);
    timer = setTimeout(runSync, 150);
  });

  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });
}

async function syncDev(args: string[]): Promise<void> {
  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "dev",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const client = new FilthyPantySyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
  const remote = await client.getManifest(manifest.project, manifest.environment);
  const diff = diffManifests(manifest, remote?.manifest ?? null);
  printDiff(diff.filter((entry) => entry.operation !== "delete"));
  const result = await client.putManifest(manifest, false);
  await writeGeneratedFiles(result.manifest, result.ids);
  const deletes = diff.filter((entry) => entry.operation === "delete");
  if (deletes.length > 0) {
    console.log(`${deletes.length} remote resources are undeclared locally; run deploy --prune to remove them.`);
  }
}

async function envCommand(args: string[]): Promise<void> {
  if (args[0] !== "set" || !args[1]) {
    throw new Error("Usage: filthy-panty env set <name>");
  }
  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "dev",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const client = new FilthyPantySyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
  const value = await promptSecret(args[1]);
  await client.setEnv(manifest.project, manifest.environment, args[1], value);
  console.log(`Stored ${args[1]} for ${manifest.project}/${manifest.environment}`);
}

async function logs(args: string[]): Promise<void> {
  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "dev",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const client = new FilthyPantySyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
  const payload = await client.logs(manifest.project, manifest.environment, { limit: 50 });
  console.log(JSON.stringify(payload.logs, null, 2));
}

async function run(args: string[]): Promise<void> {
  const [agentName, ...promptParts] = args.filter((arg) => !arg.startsWith("--"));
  if (!agentName || promptParts.length === 0) {
    throw new Error("Usage: filthy-panty run <agent> <prompt>");
  }
  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "dev",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const agent = manifest.resources.find((resource) => resource.kind === "agent" && resource.name === agentName);
  if (!agent) throw new Error(`Unknown local agent: ${agentName}`);
  const remote = await new FilthyPantySyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token })
    .getManifest(manifest.project, manifest.environment);
  const agentId = remote?.ids.agents[agentName];
  if (!agentId) throw new Error(`Agent ${agentName} is not deployed. Run filthy-panty deploy first.`);

  const client = new FilthyPantyClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
  for await (const part of client.stream({
    kind: "agent",
    name: agentName,
    id: agentId,
    project: manifest.project,
    environment: manifest.environment,
  }, { input: promptParts.join(" ") })) {
    if (part.type === "text-delta") process.stdout.write(part.text);
  }
  process.stdout.write("\n");
}

async function writeStarter(path: string, contents: string, force: boolean): Promise<void> {
  try {
    await writeFile(path, contents, { flag: force ? "w" : "wx" });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return;
    throw error;
  }
}

function starterAgent(): string {
  return `import { defineAgent, defineWorkspace, env } from "filthy-panty";\n\n` +
    `export const repo = defineWorkspace("repo", {\n` +
    `  storage: { provider: "s3" },\n` +
    `});\n\n` +
    `export const support = defineAgent("support", {\n` +
    `  provider: {\n` +
    `    openai: { apiKey: env("OPENAI_API_KEY") },\n` +
    `  },\n` +
    `  model: {\n` +
    `    provider: "openai",\n` +
    `    modelId: "gpt-5-mini",\n` +
    `  },\n` +
    `  agent: {\n` +
    `    system: "You are a helpful support agent.",\n` +
    `  },\n` +
    `  workspaces: [repo],\n` +
    `});\n`;
}

function printDiff(entries: ReturnType<typeof diffManifests>): void {
  if (entries.length === 0) {
    console.log("No changes.");
    return;
  }
  for (const entry of entries) {
    console.log(`${entry.operation.padEnd(6)} ${entry.kind}:${entry.name}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
