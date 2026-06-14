#!/usr/bin/env bun
/**
 * CLI entry point for code-first filthy-panty resources.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, relative, resolve } from "node:path";
import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { compileProject } from "../manifest.ts";
import { GENERATED_DIR, PROJECT_DIR } from "../config.ts";
import { writeGeneratedFiles } from "../codegen.ts";
import { diffManifests, FilthyPantySyncClient, type RemoteManifestResponse } from "../sync.ts";
import { FilthyPantyClient } from "../client.ts";
import { loadFilthyPantyRuntimeConfig } from "../runtime-config.ts";
import { hasFlag, loginWithBrowser, optionValue, promptConfirm, promptSecret, requireAuth } from "./utils.ts";

const VERSION = "0.1.0";
const DEFAULT_DASHBOARD_URL = "https://dashboard.beeblast.co";

const HELP = `filthy-panty v${VERSION}

Usage: filthy-panty <command>

Commands:
  init                 Create a filthypanty/ project shell
  login                Authenticate with WorkOS through the dashboard
  dev                  Watch resources and sync the dev environment (confirms before deleting)
  dev --once           Sync the dev environment a single time and exit (no watch)
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
  await writeLocalEnvDefaults({
    dashboardUrl: optionValue(args, "--dashboard-url") ?? DEFAULT_DASHBOARD_URL,
    project: optionValue(args, "--project") ?? inferProjectName(process.cwd()),
    environment: optionValue(args, "--env") ?? "development",
    force: force,
  });
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
  await writeLocalEnvDefaults({
    dashboardUrl: auth.dashboardUrl,
    project: optionValue(args, "--project") ?? process.env.FILTHY_PANTY_PROJECT ?? inferProjectName(process.cwd()),
    environment: optionValue(args, "--env") ?? process.env.FILTHY_PANTY_ENVIRONMENT ?? "development",
    force: false,
  });
  const user = auth.user?.email || auth.user?.name || auth.user?.authId;
  const org = auth.org ? `${auth.org.name} (${auth.org.slug})` : undefined;
  const account = auth.account?.username;
  console.log(`Logged in to ${auth.dashboardUrl}`);
  if (user) console.log(`User: ${user}`);
  if (org) console.log(`Org: ${org}`);
  if (account) console.log(`Account: ${account}`);
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
  const { manifest, config, resourceAliases } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "deploy",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const client = new FilthyPantySyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
  const result = await client.putManifest(manifest, hasFlag(args, "--prune"));
  await writeGeneratedFiles(manifest, result.ids, process.cwd(), resourceAliases);
  console.log(`Synced ${result.manifest.resources.length} resources to ${manifest.project}/${manifest.environment}`);
}

async function dev(args: string[]): Promise<void> {
  if (hasFlag(args, "--once")) {
    const result = await syncDev(args);
    console.log(`Synced ${result.manifest.resources.length} resources to ${result.manifest.project}/${result.manifest.environment}`);
    return;
  }

  // Each sync runs in a FRESH child process (`dev --once`). Bun does not bust the
  // dynamic-import cache via query strings, so an in-process watch would keep
  // recompiling the file content captured at startup and never see edits. The
  // child shares a declined-deletes file so a removed resource is not re-prompted
  // on every later save.
  const declinedFile = join(tmpdir(), `filthy-panty-declined-${process.pid}.txt`);
  const childEnv = { ...process.env, FILTHY_PANTY_DECLINED_FILE: declinedFile };

  await runSyncChild(args, childEnv);
  console.log(`Watching ${PROJECT_DIR}/`);

  let timer: NodeJS.Timeout | undefined;
  let syncing = false;
  let pending = false;
  let lastSourceSignature = await sourceSignature();

  const runSync = (): void => {
    if (syncing) {
      pending = true;
      return;
    }
    syncing = true;
    sourceSignature()
      .then(async (signature) => {
        if (signature === lastSourceSignature) return;
        lastSourceSignature = signature;
        await runSyncChild(args, childEnv);
      })
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
    if (!filename || isGeneratedPath(filename)) return;
    clearTimeout(timer);
    timer = setTimeout(runSync, 150);
  });

  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });
}

/**
 * Runs one `dev --once` sync in a fresh child process with inherited stdio, so
 * each compile starts from an empty module cache (see {@link dev}) and any delete
 * confirmation prompt still reaches the terminal.
 */
function runSyncChild(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const entryPoint = process.argv[1] ?? "";
    const child = spawn(process.execPath, [entryPoint, "dev", "--once", ...args], {
      stdio: "inherit",
      env: env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(signal
        ? `Sync child exited from signal ${signal}`
        : `Sync child exited with code ${code ?? "unknown"}`));
    });
  });
}

/**
 * Syncs the dev environment once. Creates/updates are pushed first so they apply
 * immediately; deletions (resources removed from code) are then confirmed
 * interactively before pruning, so an edit-in-progress never silently destroys
 * an agent's history or a workspace's files — and a slow answer never blocks the
 * non-destructive sync. Declined deletes are remembered (across watch child
 * processes via `FILTHY_PANTY_DECLINED_FILE`) so they are not re-prompted.
 */
async function syncDev(args: string[]): Promise<RemoteManifestResponse> {
  const { manifest, config, resourceAliases } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "dev",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const client = new FilthyPantySyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
  const remote = await client.getManifest(manifest.project, manifest.environment);
  const diff = diffManifests(manifest, remote?.manifest ?? null);
  printDiff(diff.filter((entry) => entry.operation !== "delete"));

  // Push creates/updates (and canvas wiring) immediately, undeleted.
  let result = await client.putManifest(manifest, false);
  await writeGeneratedFiles(manifest, result.ids, process.cwd(), resourceAliases);

  const declined = await loadDeclinedDeletes();
  const deletes = diff.filter((entry) => entry.operation === "delete");
  const undecided = deletes.filter((entry) => !declined.has(`${entry.kind}:${entry.name}`));
  let pruned = false;
  if (undecided.length > 0) {
    console.log("These remote resources are no longer declared locally:");
    for (const entry of undecided) console.log(`  delete ${entry.kind}:${entry.name}`);
    if (await promptConfirm(`Delete ${undecided.length} resource(s) from ${manifest.project}/${manifest.environment}?`)) {
      result = await client.putManifest(manifest, true);
      await writeGeneratedFiles(manifest, result.ids, process.cwd(), resourceAliases);
      await clearDeclinedDeletes();
      pruned = true;
    } else {
      await rememberDeclinedDeletes(undecided.map((entry) => `${entry.kind}:${entry.name}`));
    }
  }

  // Persistent reminder: kept-but-undeclared resources are easy to forget once
  // the prompt stops re-asking, so re-surface them (non-blocking) every sync
  // until they are re-declared in code or pruned.
  if (!pruned && deletes.length > 0) {
    const names = deletes.map((entry) => `${entry.kind}:${entry.name}`).join(", ");
    console.log(`⚠ ${deletes.length} undeclared resource(s) kept remotely: ${names} — re-declare in code or run \`deploy --prune\` to remove.`);
  }

  return result;
}

/** Reads the delete keys already declined this watch session, if any. */
async function loadDeclinedDeletes(): Promise<Set<string>> {
  const path = process.env.FILTHY_PANTY_DECLINED_FILE;
  if (!path) return new Set();
  const text = await readTextIfExists(path);

  return new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

/** Appends declined delete keys so later watch syncs do not re-prompt for them. */
async function rememberDeclinedDeletes(keys: string[]): Promise<void> {
  const path = process.env.FILTHY_PANTY_DECLINED_FILE;
  if (!path || keys.length === 0) return;
  await writeFile(path, `${keys.join("\n")}\n`, { flag: "a" });
}

/** Resets declined deletes after a prune so re-added-then-removed resources prompt again. */
async function clearDeclinedDeletes(): Promise<void> {
  const path = process.env.FILTHY_PANTY_DECLINED_FILE;
  if (!path) return;
  await writeFile(path, "", "utf8");
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

async function writeLocalEnvDefaults(options: {
  dashboardUrl: string;
  project: string;
  environment: string;
  force: boolean;
}): Promise<void> {
  const path = resolve(process.cwd(), ".env.local");
  const current = await readTextIfExists(path);
  const values = parseEnv(current);
  const nextValues = {
    FILTHY_PANTY_DASHBOARD_URL: options.dashboardUrl,
    FILTHY_PANTY_PROJECT: options.project,
    FILTHY_PANTY_ENVIRONMENT: options.environment,
  };
  const lines = current ? current.replace(/\n?$/, "\n").split(/\n/) : [
    "# Local filthy-panty CLI settings. Tokens are stored outside the repo.",
  ];
  let changed = false;

  for (const [key, value] of Object.entries(nextValues)) {
    if (values[key] !== undefined && !options.force) continue;
    const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${quoteEnv(value)}`;
    else lines.push(`${key}=${quoteEnv(value)}`);
    changed = true;
  }

  if (!changed && current) return;
  const body = `${lines.filter((line, index, all) => !(line === "" && index === all.length - 1)).join("\n")}\n`;
  await writeFile(path, body, "utf8");
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "";
    throw error;
  }
}

function parseEnv(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }

  return values;
}

function quoteEnv(value: string): string {
  return JSON.stringify(value);
}

function inferProjectName(cwd: string): string {
  return basename(resolve(cwd))
    .replace(/^@/, "")
    .replace(/\//g, "-")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "filthy-panty-app";
}

async function sourceSignature(): Promise<string> {
  const root = resolve(process.cwd(), PROJECT_DIR);
  const files: string[] = [];
  await collectSourceFiles(root, files);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }

  return hash.digest("hex");
}

async function collectSourceFiles(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === GENERATED_DIR || entry.name === "generated" || entry.name === ".cache") continue;
      await collectSourceFiles(full, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
}

function isGeneratedPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => part === GENERATED_DIR || part === "generated" || part === ".cache");
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
