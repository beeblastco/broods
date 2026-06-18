#!/usr/bin/env bun
/**
 * CLI entry point for code-first filthy-panty resources.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { collectEnvRefNames, compileProject } from "../manifest.ts";
import type { CliManifest } from "../contracts.ts";
import { GENERATED_DIR, PROJECT_DIR, USER_CONFIG_PATH } from "../config.ts";
import { writeGeneratedFiles } from "../codegen.ts";
import { type CliLogEntry, type CliOnboardingContext, type CliOnboardingOrg, diffManifests, FilthyPantySyncClient, type RemoteManifestResponse } from "../sync.ts";
import { FilthyPantyClient } from "../client.ts";
import { loadFilthyPantyRuntimeConfig } from "../runtime-config.ts";
import { hasFlag, loginWithBrowser, optionValue, promptConfirm, promptSecret, promptSelect, promptText, requireAuth } from "./utils.ts";
import { printDeploymentTarget, printDiffEntries, printEnvSync, printReadyLine, printWarning } from "./output.ts";

const VERSION = "0.1.0";
const DEFAULT_DASHBOARD_URL = "https://dashboard.beeblast.co";

const HELP = `filthy-panty v${VERSION}

Usage: filthy-panty <command>

Commands:
  init                 Create a filthypanty/ project shell
  login                Authenticate with WorkOS through the dashboard
  dev                  Watch resources and sync Development (confirms before deleting);
                       auto-pushes any env.NAME values found in .env.local to the cloud
  dev --once           Sync Development a single time and exit (no watch)
  diff                 Show local desired state vs remote state
  deploy               Sync Production once; writes FILTHY_PANTY_API_KEY to .env.local on first run
                       (--prune deletes undeclared remote resources; --rotate-key mints a fresh key)
  env set <name>       Store an encrypted environment variable
  env get <name>       Reveal a variable's value (audited)
  env list             List environment variable names (values stay hidden)
  env rm <name>        Remove an environment variable
  logs [-f]            Show recent ERROR logs; -f/--follow tails them live (Ctrl+C to stop)
  run <agent> <prompt> Run an agent and stream the result

Options:
  --dashboard-url <url> Dashboard base URL (default: ${DEFAULT_DASHBOARD_URL})
  --project <name>      Project name override (default: package name or folder)
  --env <name>          Target environment override
  --prune               Allow deploy to delete undeclared remote resources
  --rotate-key          Mint a fresh runtime API key on deploy and write it to .env.local
  -f, --follow          Tail logs live (with \`logs\`)
  --all                 Include INFO/WARN/DEBUG logs (with \`logs\`)
  --limit <n>           Max log lines to fetch (with \`logs\`, default 50)
  --json                Print logs as raw JSON (with \`logs\`)
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
  await writeStarter(resolve(root, "index.ts"), starterAgent(), force);
  await writeStarter(resolve(root, ".gitignore"), "_generated\n.cache\n", force);
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
  printDiffEntries(diffManifests(manifest, remote?.manifest ?? null));
}

async function deploy(args: string[]): Promise<void> {
  const { manifest, config, resourceAliases, channels } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "deploy",
    useRuntimeEnvironment: false,
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const client = new FilthyPantySyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
  const result = await client.putManifest(manifest, hasFlag(args, "--prune"), hasFlag(args, "--rotate-key"));
  await writeGeneratedFiles(manifest, result.ids, process.cwd(), resourceAliases, result.deployment, channels);
  await ensureGitIgnore();
  console.log(`Synced ${result.manifest.resources.length} resources to ${manifest.project}/${manifest.environment}`);
  await applyDeploymentKey(result.deployment);
  printChannelEndpoints(channels, result);
  printSyncWarnings(result);
}

/**
 * Persist the environment's runtime API key after a deploy. The plaintext is
 * returned only when the key was just minted (or rotated), so we write it then;
 * otherwise we nudge the operator to rotate if no local key is present.
 */
async function applyDeploymentKey(
  deployment: RemoteManifestResponse["deployment"],
): Promise<void> {
  if (!deployment) return;
  if (deployment.apiKey) {
    await writeEnvValue("FILTHY_PANTY_API_KEY", deployment.apiKey);
    console.log(`Wrote FILTHY_PANTY_API_KEY (${deployment.keyHint}) to .env.local`);
    return;
  }

  const path = resolve(process.cwd(), ".env.local");
  const existing = parseEnv(await readTextIfExists(path));
  if (!existing.FILTHY_PANTY_API_KEY) {
    printWarning(
      `⚠ Runtime key already exists (${deployment.keyHint}) but its secret is only shown once. ` +
      "Run `filthy-panty deploy --rotate-key` to mint a fresh one and write it to .env.local.",
    );
  }
}

/** Surface non-fatal deploy advisories (e.g. env vars referenced but not set). */
function printSyncWarnings(result: RemoteManifestResponse): void {
  const missing = result.warnings?.missingEnv ?? [];
  if (missing.length === 0) return;
  printWarning(
    `⚠ ${missing.length} env var(s) referenced in agent config but not set: ${missing.join(", ")}`,
  );
  for (const name of missing) console.log(`    filthy-panty env set ${name}`);
}

async function dev(args: string[]): Promise<void> {
  await ensureDevOnboarding(args);

  if (hasFlag(args, "--once")) {
    if (!process.env.FILTHY_PANTY_SUPPRESS_DEV_TARGET) {
      await printDevTarget(args);
    }
    const start = performance.now();
    await syncDev(args);
    printReadyLine(performance.now() - start);
    return;
  }

  // Each sync runs in a FRESH child process (`dev --once`). Bun does not bust the
  // dynamic-import cache via query strings, so an in-process watch would keep
  // recompiling the file content captured at startup and never see edits. The
  // child shares a declined-deletes file so a removed resource is not re-prompted
  // on every later save.
  const declinedFile = join(tmpdir(), `filthy-panty-declined-${process.pid}.txt`);
  const childEnv = {
    ...process.env,
    FILTHY_PANTY_DECLINED_FILE: declinedFile,
    FILTHY_PANTY_SUPPRESS_DEV_TARGET: "1",
  };

  await printDevTarget(args);
  await runSyncChild(args, childEnv);

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

async function ensureDevOnboarding(args: string[]): Promise<void> {
  await ensureProjectShell();
  await ensureLocalDevDefaults(args);
}

async function ensureProjectShell(): Promise<void> {
  const root = resolve(process.cwd(), PROJECT_DIR);
  await mkdir(resolve(root, GENERATED_DIR), { recursive: true });

  const files: string[] = [];
  await collectSourceFiles(root, files);
  if (files.length > 0) return;

  await writeStarter(resolve(root, "index.ts"), starterAgent(), false);
  await writeStarter(resolve(root, ".gitignore"), "_generated\n.cache\n", false);
  console.log(`Created starter ${PROJECT_DIR}/`);
}

async function ensureLocalDevDefaults(args: string[]): Promise<void> {
  const path = resolve(process.cwd(), ".env.local");
  const current = await readTextIfExists(path);
  const values = parseEnv(current);
  const missing = [
    "FILTHY_PANTY_DASHBOARD_URL",
    "FILTHY_PANTY_PROJECT",
    "FILTHY_PANTY_ENVIRONMENT",
  ].filter((key) => values[key] === undefined);
  if (missing.length === 0) return;
  const needsProject = values.FILTHY_PANTY_PROJECT === undefined;
  const needsEnvironment = values.FILTHY_PANTY_ENVIRONMENT === undefined;

  const runtime = loadFilthyPantyRuntimeConfig();
  const dashboardUrl = optionValue(args, "--dashboard-url") ??
    runtime.dashboardUrl ??
    DEFAULT_DASHBOARD_URL;
  let project = optionValue(args, "--project") ??
    process.env.FILTHY_PANTY_PROJECT ??
    inferProjectName(process.cwd());
  let environment = optionValue(args, "--env") ??
    process.env.FILTHY_PANTY_ENVIRONMENT ??
    "development";

  if (process.stdin.isTTY && needsProject) {
    const auth = await requireAuthOrLogin(dashboardUrl);
    const client = new FilthyPantySyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
    const context = await getOnboardingContextOrFallback(client, auth);
    const selectableOrgs = context.orgs.filter((org) => org.accountStatus === "active");
    if (selectableOrgs.length === 0) {
      throw new Error("No selectable org has an active API account. Open Settings -> API Access in the dashboard first.");
    }
    const selectedOrg = await promptSelect(
      "Select organization",
      selectableOrgs,
      formatOrgChoice,
    );
    const selectedContext = selectedOrg.id === context.currentOrgId
      ? context
      : await client.selectOnboardingOrg(selectedOrg.id);
    project = await promptText("Project name", defaultProjectName(selectedContext, project));
    if (!project.trim()) throw new Error("Project name is required.");
  }

  if (process.stdin.isTTY && needsEnvironment) {
    environment = await promptText("Environment", environment);
    if (!environment.trim()) throw new Error("Environment is required.");
  }

  await writeLocalEnvDefaults({
    dashboardUrl: dashboardUrl,
    project: project,
    environment: environment,
    force: false,
  });
}

async function requireAuthOrLogin(dashboardUrl: string) {
  try {
    return await requireAuth(dashboardUrl);
  } catch (error) {
    if (!process.stdin.isTTY) throw error;
    printWarning("No CLI login found. Starting browser login.");

    return await loginWithBrowser(dashboardUrl);
  }
}

async function getOnboardingContextOrFallback(
  client: FilthyPantySyncClient,
  auth: Awaited<ReturnType<typeof requireAuthOrLogin>>,
): Promise<CliOnboardingContext> {
  try {
    return await client.getOnboarding();
  } catch (error) {
    if (!auth.org) throw error;
    printWarning(
      "CLI onboarding endpoint is not available yet; using the org from the current login.",
    );

    return {
      currentOrgId: auth.org.id,
      orgs: [{
        id: auth.org.id,
        name: auth.org.name,
        slug: auth.org.slug,
        role: "admin",
        accountStatus: "active",
      }],
      projects: [],
    };
  }
}

function formatOrgChoice(org: CliOnboardingOrg): string {
  const suffix = org.role === "owner" || org.role === "admin" ? org.role : "member";

  return `${org.name} (${org.slug}, ${suffix})`;
}

function defaultProjectName(context: CliOnboardingContext, inferred: string): string {
  const exact = context.projects.find((project) => project.name === inferred || project.slug === inferred);

  return exact?.name ?? inferred;
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
  const { manifest, config, resourceAliases, channels } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "dev",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const client = new FilthyPantySyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
  const remote = await client.getManifest(manifest.project, manifest.environment);
  const diff = diffManifests(manifest, remote?.manifest ?? null);
  printDiffEntries(diff.filter((entry) => entry.operation !== "delete"));

  // Push any `env.NAME` values from .env.local up first, so this sync's configs
  // resolve them and the missing-env warning only fires for genuinely-absent vars.
  await syncLocalEnvVars(client, manifest);

  // Push creates/updates (and canvas wiring) immediately, undeleted.
  let result = await client.putManifest(manifest, false);
  await writeGeneratedFiles(manifest, result.ids, process.cwd(), resourceAliases, result.deployment, channels);
  await ensureGitIgnore();

  const declined = await loadDeclinedDeletes();
  const deletes = diff.filter((entry) => entry.operation === "delete");
  const undecided = deletes.filter((entry) => !declined.has(`${entry.kind}:${entry.name}`));
  let pruned = false;
  if (undecided.length > 0) {
    printWarning("⚠ These remote resources are no longer declared locally:");
    printDiffEntries(undecided);
    if (await promptConfirm(`Delete ${undecided.length} resource(s) from ${manifest.project}/${manifest.environment}?`)) {
      result = await client.putManifest(manifest, true);
      await writeGeneratedFiles(manifest, result.ids, process.cwd(), resourceAliases, result.deployment, channels);
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
    printWarning(`⚠ ${deletes.length} undeclared resource(s) kept remotely: ${names} — re-declare in code or run \`deploy --prune\` to remove.`);
  }

  await applyDeploymentKey(result.deployment);
  printChannelEndpoints(channels, result);
  printSyncWarnings(result);
  return result;
}

function printChannelEndpoints(
  channels: Awaited<ReturnType<typeof compileProject>>["channels"],
  result: RemoteManifestResponse,
): void {
  const deployment = result.deployment;
  if (!deployment || channels.length === 0) return;
  const client = new FilthyPantyClient();
  for (const channel of channels) {
    const agentId = result.ids.agents[channel.agentName];
    if (!agentId) continue;
    const webhookPath = `/webhooks/${encodeURIComponent(deployment.accountId)}/${encodeURIComponent(agentId)}/${encodeURIComponent(channel.type)}`;
    const url = client.channelWebhookUrl({
      kind: "channel",
      type: channel.type,
      agentName: channel.agentName,
      agentId,
      accountId: deployment.accountId,
      webhookPath,
    });
    console.log(`Channel ${channel.alias} (${channel.type}): ${url}${channel.type === "pancake" ? "?secret=<PANCAKE_WEBHOOK_SECRET>" : ""}`);
  }
}

/**
 * Auto-syncs the env vars an agent config references via `env.NAME` from the
 * local environment (`.env.local`, already loaded into `process.env`) up to the
 * cloud environment during `dev`. This fulfills the Convex-style `env set` flow
 * automatically so the dashboard never needs a manual step for local secrets.
 *
 * Deliberately one-way and set-only: only manifest-referenced names are pushed
 * (never `FILTHY_PANTY_*` control vars or unrelated `.env.local` keys), values
 * are never read back (the backend stores them encrypted/write-only), and
 * removing a var locally never deletes it remotely. `deploy` is left untouched
 * so production secrets stay an explicit `filthy-panty env set`.
 */
async function syncLocalEnvVars(client: FilthyPantySyncClient, manifest: CliManifest): Promise<void> {
  const present = collectEnvRefNames(manifest).filter((name) => {
    const value = process.env[name];
    return !name.startsWith("FILTHY_PANTY_") && value !== undefined && value !== "";
  });
  if (present.length === 0) return;

  // Churn guard: only push a var whose value changed since we last synced it,
  // tracked by a user-local hash cache outside the project tree. Without this
  // every watch save would re-encrypt and re-bake every agent config that
  // references the var. The cache stores hashes (never the values), survives
  // across watch child processes, and a cleared cache just re-pushes once —
  // safe because the set is idempotent.
  const cache = await loadEnvSyncCache();
  const known = cache[envCacheKey(manifest.project, manifest.environment)] ?? {};
  const changed = present.filter((name) => known[name] !== hashEnvValue(process.env[name]!));
  if (changed.length === 0) return;

  await Promise.all(
    changed.map((name) => client.setEnv(manifest.project, manifest.environment, name, process.env[name]!)),
  );
  for (const name of changed) known[name] = hashEnvValue(process.env[name]!);
  cache[envCacheKey(manifest.project, manifest.environment)] = known;
  await saveEnvSyncCache(cache);
  printEnvSync(changed);
}

type EnvSyncCache = Record<string, Record<string, string>>;

function envCacheKey(project: string, environment: string): string {
  return `${project}:${environment}`;
}

function envSyncCachePath(): string {
  return resolve(dirname(USER_CONFIG_PATH), "env-sync.json");
}

function hashEnvValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Reads the local env-sync hash cache, returning an empty map when absent or corrupt. */
async function loadEnvSyncCache(): Promise<EnvSyncCache> {
  const text = await readTextIfExists(envSyncCachePath());
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as EnvSyncCache) : {};
  } catch {
    return {};
  }
}

async function saveEnvSyncCache(cache: EnvSyncCache): Promise<void> {
  const path = envSyncCachePath();
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

/** Records the synced hash for a var set via `env set`, so `dev` won't re-push an unchanged value. */
async function rememberEnvSyncValue(project: string, environment: string, name: string, value: string): Promise<void> {
  const cache = await loadEnvSyncCache();
  const key = envCacheKey(project, environment);
  cache[key] = { ...(cache[key] ?? {}), [name]: hashEnvValue(value) };
  await saveEnvSyncCache(cache);
}

/** Drops a var's cached hash after `env rm`, so a later re-add with the same value re-pushes. */
async function forgetEnvSyncValue(project: string, environment: string, name: string): Promise<void> {
  const cache = await loadEnvSyncCache();
  const key = envCacheKey(project, environment);
  if (!cache[key] || !(name in cache[key])) return;
  delete cache[key][name];
  await saveEnvSyncCache(cache);
}

async function printDevTarget(args: string[]): Promise<void> {
  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "dev",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  printDeploymentTarget({
    project: manifest.project,
    environment: manifest.environment,
    dashboardUrl: auth.dashboardUrl,
  });
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
  const subcommand = args[0];
  const name = args[1];
  const isList = subcommand === "list" || subcommand === "ls";
  const isRemove = subcommand === "rm" || subcommand === "remove";
  const isGet = subcommand === "get";
  const needsName = subcommand === "set" || isRemove || isGet;
  if ((needsName && !name) || (!isList && !needsName)) {
    throw new Error("Usage: filthy-panty env <set|get|list|rm> [name]");
  }

  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "dev",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const client = new FilthyPantySyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
  const target = `${manifest.project}/${manifest.environment}`;

  if (isList) {
    const variables = await client.listEnv(manifest.project, manifest.environment);
    if (variables.length === 0) {
      console.log(`No environment variables set for ${target}.`);
      return;
    }
    console.log(`Environment variables for ${target} (values hidden):`);
    for (const variable of variables) console.log(`  ${variable.name}`);
    return;
  }

  if (isGet) {
    const value = await client.getEnv(manifest.project, manifest.environment, name!);
    if (value === null) {
      console.error(`${name} is not set for ${target}`);
      process.exitCode = 1;
      return;
    }
    // Print the raw value to stdout so it can be piped/captured.
    console.log(value);
    return;
  }

  if (isRemove) {
    await client.removeEnv(manifest.project, manifest.environment, name!);
    await forgetEnvSyncValue(manifest.project, manifest.environment, name!);
    console.log(`Removed ${name} from ${target}`);
    return;
  }

  const value = await promptSecret(name!);
  await client.setEnv(manifest.project, manifest.environment, name!, value);
  await rememberEnvSyncValue(manifest.project, manifest.environment, name!, value);
  console.log(`Stored ${name} for ${target}`);
}

async function logs(args: string[]): Promise<void> {
  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "dev",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const client = new FilthyPantySyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
  const errorOnly = !hasFlag(args, "--all");

  if (hasFlag(args, "--follow") || hasFlag(args, "-f")) {
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    console.log(`Tailing logs for ${manifest.project}/${manifest.environment} — Ctrl+C to stop`);
    await tailLogs(client, manifest.project, manifest.environment, { errorOnly: errorOnly, signal: controller.signal });
    return;
  }

  const limit = Number(optionValue(args, "--limit") ?? 50);
  const payload = await client.logs(manifest.project, manifest.environment, { limit: limit, errorOnly: errorOnly });
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify(payload.logs, null, 2));
    return;
  }
  const ascending = [...payload.logs].sort((a, b) => a.timestamp - b.timestamp);
  for (const entry of ascending) console.log(formatLogEntry(entry));
  if (ascending.length === 0) console.log("No logs in the lookback window.");
}

/** Render a single log line as `HH:mm:ss.SSS LEVEL message`, mirroring `convex dev`. */
function formatLogEntry(entry: CliLogEntry): string {
  const time = new Date(entry.timestamp).toISOString().slice(11, 23);
  return `${time} ${entry.level.padEnd(5)} ${entry.message}`;
}

/** Resolve after `ms`, or immediately if `signal` aborts first. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    if (signal.aborted) return resolvePromise();
    const timer = setTimeout(resolvePromise, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolvePromise();
    }, { once: true });
  });
}

/**
 * Poll the logs endpoint and print new lines as they arrive, deduping by
 * timestamp+requestId+message, until `signal` aborts. CloudWatch has no push
 * channel, so this is a poll loop over a rolling lookback window — the CLI analog
 * of `convex dev`'s live log tail. The first poll prints the recent window for
 * context; later polls print only previously-unseen lines.
 */
async function tailLogs(
  client: FilthyPantySyncClient,
  project: string,
  environment: string,
  options: { errorOnly?: boolean; intervalMs?: number; signal: AbortSignal },
): Promise<void> {
  const intervalMs = options.intervalMs ?? 3000;
  const lookbackMs = Math.max(intervalMs * 4, 30_000);
  const printed = new Set<string>();

  while (!options.signal.aborted) {
    try {
      const { logs } = await client.logs(project, environment, {
        errorOnly: options.errorOnly,
        lookbackMs: lookbackMs,
        limit: 200,
      });
      const ascending = [...logs].sort((a, b) => a.timestamp - b.timestamp);
      for (const entry of ascending) {
        const key = `${entry.timestamp}|${entry.requestId ?? ""}|${entry.message}`;
        if (printed.has(key)) continue;
        printed.add(key);
        console.log(formatLogEntry(entry));
      }
      if (printed.size > 2000) {
        const cutoff = Date.now() - lookbackMs;
        for (const key of printed) {
          const ts = Number(key.slice(0, key.indexOf("|")));
          if (Number.isFinite(ts) && ts < cutoff) printed.delete(key);
        }
      }
    } catch (error) {
      if (!options.signal.aborted) {
        console.error(`log tail: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await delay(intervalMs, options.signal);
  }
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

  const client = new FilthyPantyClient();
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

/** Ensure the project directory has a .gitignore that ignores generated files. */
async function ensureGitIgnore(): Promise<void> {
  const path = resolve(process.cwd(), PROJECT_DIR, ".gitignore");
  const existing = await readTextIfExists(path);
  const needed = ["_generated", ".cache"];
  const missing = needed.filter((line) => !existing.split(/\r?\n/).some((l) => l.trim() === line));
  if (missing.length === 0) return;
  const body = existing ? existing.trimEnd() + "\n" + missing.join("\n") + "\n" : missing.join("\n") + "\n";
  await writeFile(path, body, "utf8");
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
    if (process.env[key] === undefined) process.env[key] = value;
    changed = true;
  }

  if (!changed && current) return;
  const body = `${lines.filter((line, index, all) => !(line === "" && index === all.length - 1)).join("\n")}\n`;
  await writeFile(path, body, "utf8");
}

/** Upsert a single KEY=value into `.env.local`, preserving other lines. */
async function writeEnvValue(key: string, value: string): Promise<void> {
  const path = resolve(process.cwd(), ".env.local");
  const current = await readTextIfExists(path);
  const lines = current
    ? current.replace(/\n?$/, "\n").split(/\n/)
    : ["# Local filthy-panty CLI settings. Tokens are stored outside the repo."];
  const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
  if (index >= 0) lines[index] = `${key}=${quoteEnv(value)}`;
  else lines.push(`${key}=${quoteEnv(value)}`);
  process.env[key] = value;
  const body = `${lines.filter((line, i, all) => !(line === "" && i === all.length - 1)).join("\n")}\n`;
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
  return `import { defineAgent, defineSandbox, env } from "filthy-panty";\n\n` +
    `// A Lambda sandbox: a fresh, ephemeral bash environment created per run.\n` +
    `export const lambdaSandbox = defineSandbox({\n` +
    `  name: "lambda-sandbox",\n` +
    `  config: {\n` +
    `    provider: "lambda",\n` +
    `    network: { mode: "deny-all" },\n` +
    `    permissionMode: "bypass",\n` +
    `    timeout: 60,\n` +
    `  },\n` +
    `});\n\n` +
    `export const myAgent = defineAgent({\n` +
    `  name: "my-agent",\n` +
    `  config: {\n` +
    `    provider: {\n` +
    `      openai: { apiKey: env.OPENAI_API_KEY },\n` +
    `    },\n` +
    `    model: {\n` +
    `      provider: "openai",\n` +
    `      modelId: "gpt-5.5",\n` +
    `    },\n` +
    `    agent: {\n` +
    `      system: "You are a helpful assistant.",\n` +
    `    },\n` +
    `    sandbox: lambdaSandbox,\n` +
    `  },\n` +
    `});\n`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
