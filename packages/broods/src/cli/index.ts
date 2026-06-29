#!/usr/bin/env bun
/**
 * CLI entry point for code-first broods resources.
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
import { type CliOnboardingContext, type CliOnboardingOrg, type CliOnboardingProject, diffManifests, BroodsSyncClient, type RemoteManifestResponse } from "../sync.ts";
import { BroodsClient, DEFAULT_CORE_BASE_URL } from "../client.ts";
import { loadBroodsRuntimeConfig } from "../runtime-config.ts";
import { subscribeObservabilityLogs } from "../observability-client.ts";
import type { LogLevel, ObservabilityLogEntry } from "../observability-contracts.ts";
import { hasFlag, isPlainObject, loginWithBrowser, optionValue, promptConfirm, promptSecret, promptSelect, promptText, requireAuth } from "./utils.ts";
import { printDeploymentTarget, printDiffEntries, printEnvSync, printReadyLine, printWarning } from "./output.ts";
import { createRenderState, renderStreamPart } from "./render.ts";
import packageJson from "../../package.json" with { type: "json" };

const VERSION = packageJson.version;
const DEFAULT_DASHBOARD_URL = "https://dashboard.broods.app";
const DEFAULT_SERVICE_REGION = "eu-west-1";
const SERVICE_REGIONS = [
  { region: "eu-west-1", label: "eu-west-1 (Ireland)" },
  { region: "us-east-1", label: "us-east-1 (US East)" },
  { region: "ap-southeast-1", label: "ap-southeast-1 (Singapore)" },
] as const;

const HELP = `broods v${VERSION}

Usage: broods <command>

Commands:
  init                 Create a broods/ project shell
  login                Authenticate with WorkOS through the dashboard
  dev                  Watch + sync Development AND live-tail agent logs (like \`convex dev\`);
                       confirms before deleting; auto-pushes env.NAME values from .env.local
  dev --once           Sync Development a single time and exit (no watch, no log stream)
  diff                 Show local desired state vs remote state
  deploy               Sync Production once; writes BROODS_API_KEY to .env.local
                       (--prune deletes undeclared remote resources; --rotate-key mints a fresh key)
  env set <name>       Store an encrypted environment variable
  env get <name>       Reveal a variable's value (audited)
  env list             List environment variable names (values stay hidden)
  env rm <name>        Remove an environment variable
  stream               Stream live logs for the whole project/environment (Ctrl+C to stop)
  logs                 Backfill recent logs then live-tail; default 100 lines
                       (--errors / --level warn filter to WARN+; -n/--limit <n> changes backfill size)
  agent list           List the agents in the current project/environment scope
  agent get <name>     Show an agent's resources (model, sandbox, workspaces, tools, channels)
  run <agent> <prompt> Run an agent once and pretty-stream the result (thinking, tool calls, text)

Options:
  --dashboard-url <url> Dashboard base URL (default: ${DEFAULT_DASHBOARD_URL})
  --project <name>      Project name override (default: package name or folder)
  --env <name>          Target environment override
  --region <region>     Broods service region preference (default: ${DEFAULT_SERVICE_REGION})
  --prune               Allow deploy to delete undeclared remote resources
  --rotate-key          Mint a fresh runtime API key on deploy and write it to .env.local
  --errors              Show WARN/ERROR only (default for \`dev\`, \`stream\`, and \`logs\`)
  --level <lvl>         Minimum log level INFO|WARN|ERROR (default WARN)
  -n, --limit <n>       Backfill line count (with \`logs\`, default 100)
  --json                Print logs as raw JSON (with \`logs\`, applies to backfill output)
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
    case "stream":
      await streamLogs(args);
      return;
    case "logs":
      await logs(args);
      return;
    case "agent":
      await agentCommand(args);
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
    region: optionValue(args, "--region") ?? DEFAULT_SERVICE_REGION,
    force: force,
  });
  console.log(`Created ${PROJECT_DIR}/`);
}

async function login(args: string[]): Promise<void> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log("Usage: broods login [--dashboard-url <url>]");
    return;
  }
  const runtime = loadBroodsRuntimeConfig();
  const dashboardUrl = optionValue(args, "--dashboard-url") ??
    runtime.dashboardUrl ??
    DEFAULT_DASHBOARD_URL;
  const auth = await loginWithBrowser(dashboardUrl);
  const project = optionValue(args, "--project") ?? process.env.BROODS_PROJECT ?? inferProjectName(process.cwd());
  const environment = optionValue(args, "--env") ?? process.env.BROODS_ENVIRONMENT ?? "development";
  await writeLocalEnvDefaults({
    dashboardUrl: auth.dashboardUrl,
    project: project,
    environment: environment,
    region: optionValue(args, "--region") ?? process.env.BROODS_REGION ?? DEFAULT_SERVICE_REGION,
    force: false,
  });
  const user = auth.user?.email || auth.user?.name || auth.user?.authId;
  const org = auth.org ? `${auth.org.name} (${auth.org.slug})` : undefined;
  const account = auth.account?.username;
  console.log(`Logged in to ${auth.dashboardUrl}`);
  if (user) console.log(`User: ${user}`);
  if (org) console.log(`Org: ${org}`);
  if (account) console.log(`Account: ${account}`);
  await writeRuntimeKeyForLogin(auth.dashboardUrl, auth.token, project, environment);
}

/**
 * Best-effort: recover the environment's runtime key after login and write it to
 * .env.local so `dev` can stream right away. Silent when the project/environment
 * is not deployed yet, because login itself should still succeed.
 */
async function writeRuntimeKeyForLogin(
  dashboardUrl: string,
  token: string,
  project: string,
  environment: string,
): Promise<void> {
  try {
    const client = new BroodsSyncClient({ dashboardUrl: dashboardUrl, token: token });
    const key = await client.getRuntimeKey(project, environment);
    if (key?.apiKey) {
      await writeEnvValue("BROODS_API_KEY", key.apiKey);
      console.log(`Wrote BROODS_API_KEY (${key.keyHint}) to .env.local`);
    }
  } catch {
    // Login must not fail because the key fetch did.
  }
}

async function diff(args: string[]): Promise<void> {
  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "dev",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const client = new BroodsSyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
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
  const client = new BroodsSyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
  const result = await client.putManifest(manifest, hasFlag(args, "--prune"), hasFlag(args, "--rotate-key"));
  await writeGeneratedFiles(manifest, result.ids, process.cwd(), resourceAliases, result.deployment, channels);
  await ensureGitIgnore();
  console.log(`Synced ${result.manifest.resources.length} resources to ${manifest.project}/${manifest.environment}`);
  await applyDeploymentKey(result.deployment);
  printChannelEndpoints(channels, result);
  printSyncWarnings(result);
}

/**
 * Persist the environment's recoverable runtime API key after a deploy.
 */
async function applyDeploymentKey(
  deployment: RemoteManifestResponse["deployment"],
): Promise<void> {
  if (!deployment) return;
  if (deployment.apiKey) {
    await writeEnvValue("BROODS_API_KEY", deployment.apiKey);
    console.log(`Wrote BROODS_API_KEY (${deployment.keyHint}) to .env.local`);
    return;
  }

}

/** Surface non-fatal deploy advisories (e.g. env vars referenced but not set). */
function printSyncWarnings(result: RemoteManifestResponse): void {
  const missing = result.warnings?.missingEnv ?? [];
  if (missing.length === 0) return;
  printWarning(
    `⚠ ${missing.length} env var(s) referenced in agent config but not set: ${missing.join(", ")}`,
  );
  for (const name of missing) console.log(`    broods env set ${name}`);
}

async function dev(args: string[]): Promise<void> {
  await ensureDevOnboarding(args);

  if (hasFlag(args, "--once")) {
    if (!process.env.BROODS_SUPPRESS_DEV_TARGET) {
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
  const declinedFile = join(tmpdir(), `broods-declined-${process.pid}.txt`);
  const childEnv = {
    ...process.env,
    BROODS_DECLINED_FILE: declinedFile,
    BROODS_SUPPRESS_DEV_TARGET: "1",
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

  // Like `convex dev`: stream live agent logs alongside the resource watcher so
  // the developer sees activity while editing. Best-effort — if no runtime API
  // key is configured yet, it prints a hint and skips without breaking the sync.
  const logController = new AbortController();
  void streamDevLogs(args, logController.signal);

  process.on("SIGINT", () => {
    logController.abort();
    watcher.close();
    process.exit(0);
  });
}

// Live-tail logs during `dev`, mirroring `convex dev`. Best-effort: if the API
// key or project/env can't be resolved yet, print a hint and return rather than
// breaking the watch loop.
async function streamDevLogs(args: string[], signal: AbortSignal): Promise<void> {
  let creds: { apiKey: string; baseUrl: string };
  try {
    creds = resolveObservabilityCredentials();
  } catch {
    console.log("· live logs off — no runtime key found for this environment yet. Run `broods dev --once` after login to create or reconnect it.");

    return;
  }

  let project: string;
  let environment: string;
  try {
    ({ project, environment } = await resolveProjectEnv(args));
  } catch {
    return;
  }

  const minLevel = resolveMinLevel(args);
  try {
    for await (const entry of subscribeObservabilityLogs(
      { baseUrl: creds.baseUrl, apiKey: creds.apiKey, project: project, environment: environment },
      { backfill: 0, minLevel: minLevel, signal: signal },
    )) {
      console.log(formatObservabilityEntry(entry));
    }
  } catch (error) {
    if (!signal.aborted) {
      console.error(`live logs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
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
    "BROODS_DASHBOARD_URL",
    "BROODS_PROJECT",
    "BROODS_ENVIRONMENT",
    "BROODS_REGION",
  ].filter((key) => values[key] === undefined);
  if (missing.length === 0) return;
  const needsProject = values.BROODS_PROJECT === undefined;
  const needsEnvironment = values.BROODS_ENVIRONMENT === undefined;
  const needsRegion = values.BROODS_REGION === undefined;

  const runtime = loadBroodsRuntimeConfig();
  const dashboardUrl = optionValue(args, "--dashboard-url") ??
    runtime.dashboardUrl ??
    DEFAULT_DASHBOARD_URL;
  let project = optionValue(args, "--project") ??
    process.env.BROODS_PROJECT ??
    inferProjectName(process.cwd());
  let environment = optionValue(args, "--env") ??
    process.env.BROODS_ENVIRONMENT ??
    "development";
  let region = optionValue(args, "--region") ??
    process.env.BROODS_REGION ??
    DEFAULT_SERVICE_REGION;

  if (process.stdin.isTTY && needsProject) {
    const auth = await requireAuthOrLogin(dashboardUrl);
    const client = new BroodsSyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
    const context = await getOnboardingContextOrFallback(client, auth);
    const selectedContext = await selectOnboardingOrg(client, context);
    project = await selectOnboardingProject(selectedContext, project);
    if (!project.trim()) throw new Error("Project name is required.");
  }

  if (process.stdin.isTTY && needsEnvironment) {
    environment = await promptText("Environment", environment);
    if (!environment.trim()) throw new Error("Environment is required.");
  }

  if (process.stdin.isTTY && needsRegion) {
    region = await promptSelect("Select service region", [...SERVICE_REGIONS], (entry) => entry.label)
      .then((entry) => entry.region);
  }

  await writeLocalEnvDefaults({
    dashboardUrl: dashboardUrl,
    project: project,
    environment: environment,
    region: region,
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
  client: BroodsSyncClient,
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

async function selectOnboardingOrg(
  client: BroodsSyncClient,
  context: CliOnboardingContext,
): Promise<CliOnboardingContext> {
  const activeOrgs = context.orgs.filter((org) => org.accountStatus === "active");
  const createNew = { kind: "create" as const, name: "New organization" };
  const selected = await promptSelect(
    "Select organization",
    [...activeOrgs, createNew],
    (entry) => "kind" in entry ? "Create new organization" : formatOrgChoice(entry),
  );

  if ("kind" in selected) {
    const name = await promptText("Organization name", inferProjectName(process.cwd()));
    if (!name.trim()) throw new Error("Organization name is required.");

    return await client.createOnboardingOrg(name);
  }

  return selected.id === context.currentOrgId
    ? context
    : await client.selectOnboardingOrg(selected.id);
}

function defaultProjectName(context: CliOnboardingContext, inferred: string): string {
  const exact = context.projects.find((project) => project.name === inferred || project.slug === inferred);

  return exact?.name ?? inferred;
}

async function selectOnboardingProject(context: CliOnboardingContext, inferred: string): Promise<string> {
  if (context.projects.length === 0) {
    return promptText("Project name", inferred);
  }

  const createNew = { kind: "create" as const, name: defaultProjectName(context, inferred), slug: "" };
  const choices: Array<CliOnboardingProject | typeof createNew> = [
    ...context.projects,
    createNew,
  ];
  const selected = await promptSelect("Select project", choices, (entry) =>
    "kind" in entry && entry.kind === "create" ? `Create new project (${entry.name})` : `${entry.name} (${entry.slug})`
  );
  if ("kind" in selected && selected.kind === "create") {
    return promptText("New project name", selected.name);
  }

  return selected.name;
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
 * processes via `BROODS_DECLINED_FILE`) so they are not re-prompted.
 */
async function syncDev(args: string[]): Promise<RemoteManifestResponse> {
  const { manifest, config, resourceAliases, channels } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "dev",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const client = new BroodsSyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
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
  const client = new BroodsClient();
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
 * (never `BROODS_*` control vars or unrelated `.env.local` keys), values
 * are never read back (the backend stores them encrypted/write-only), and
 * removing a var locally never deletes it remotely. `deploy` is left untouched
 * so production secrets stay an explicit `broods env set`.
 */
async function syncLocalEnvVars(client: BroodsSyncClient, manifest: CliManifest): Promise<void> {
  const present = collectEnvRefNames(manifest).filter((name) => {
    const value = process.env[name];
    return !name.startsWith("BROODS_") && value !== undefined && value !== "";
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
  const path = process.env.BROODS_DECLINED_FILE;
  if (!path) return new Set();
  const text = await readTextIfExists(path);

  return new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

/** Appends declined delete keys so later watch syncs do not re-prompt for them. */
async function rememberDeclinedDeletes(keys: string[]): Promise<void> {
  const path = process.env.BROODS_DECLINED_FILE;
  if (!path || keys.length === 0) return;
  await writeFile(path, `${keys.join("\n")}\n`, { flag: "a" });
}

/** Resets declined deletes after a prune so re-added-then-removed resources prompt again. */
async function clearDeclinedDeletes(): Promise<void> {
  const path = process.env.BROODS_DECLINED_FILE;
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
    throw new Error("Usage: broods env <set|get|list|rm> [name]");
  }

  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "dev",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const client = new BroodsSyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token });
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

// Runtime API key (BROODS_API_KEY, written by `deploy`/`init`) + base URL
// for the observability gateway. No dashboard login required.
function resolveObservabilityCredentials(): { apiKey: string; baseUrl: string } {
  loadBroodsRuntimeConfig();
  const apiKey = process.env.BROODS_API_KEY ?? "";
  if (!apiKey) {
    throw new Error(
      "BROODS_API_KEY is not set. Run `broods deploy` first, or set the key in .env.local.",
    );
  }
  const baseUrl =
    process.env.BROODS_BASE_URL ??
    process.env.BROODS_HOST ??
    DEFAULT_CORE_BASE_URL;
  return { apiKey, baseUrl };
}

/** Parse --errors / --level <lvl> into a LogLevel (defaults to WARN). */
function resolveMinLevel(args: string[]): LogLevel | undefined {
  if (hasFlag(args, "--errors")) return "WARN";
  const raw = optionValue(args, "--level");
  if (!raw) return "WARN";
  const upper = raw.toUpperCase();
  if (upper === "WARN" || upper === "WARNING") return "WARN";
  if (upper === "ERROR") return "ERROR";
  if (upper === "INFO") return "INFO";
  throw new Error(`Unknown log level: ${raw}. Use INFO, WARN, or ERROR.`);
}

/** Resolve project + environment for observability commands (same as other commands). */
async function resolveProjectEnv(args: string[]): Promise<{ project: string; environment: string }> {
  loadBroodsRuntimeConfig();
  const project =
    optionValue(args, "--project") ??
    process.env.BROODS_PROJECT;
  const environment =
    optionValue(args, "--env") ??
    process.env.BROODS_ENVIRONMENT;
  if (!project) {
    throw new Error(
      "Project name is required. Pass --project <name> or set BROODS_PROJECT in .env.local.",
    );
  }
  if (!environment) {
    throw new Error(
      "Environment name is required. Pass --env <name> or set BROODS_ENVIRONMENT in .env.local.",
    );
  }
  return { project, environment };
}

/** Render one ObservabilityLogEntry as `HH:mm:ss.SSS LEVEL eventType message`. */
function formatObservabilityEntry(entry: ObservabilityLogEntry): string {
  const time = new Date(entry.ts).toISOString().slice(11, 23);
  const level = entry.level.padEnd(5);
  return `${time} ${level} ${entry.eventType} ${entry.message}`;
}

// `broods stream` — live tail of the whole project/environment log stream
// until Ctrl-C, no backfill. Flags are documented in HELP.
async function streamLogs(args: string[]): Promise<void> {
  const { apiKey, baseUrl } = resolveObservabilityCredentials();
  const { project, environment } = await resolveProjectEnv(args);
  const minLevel = resolveMinLevel(args);

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);

  console.log(
    `Streaming live logs for ${project}/${environment}` +
    (minLevel ? ` [${minLevel}+]` : "") +
    " — Ctrl+C to stop",
  );

  try {
    for await (const entry of subscribeObservabilityLogs(
      { baseUrl, apiKey, project, environment },
      { backfill: 0, minLevel, signal: controller.signal },
    )) {
      console.log(formatObservabilityEntry(entry));
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

// `broods logs` — backfill recent lines (Loki) then switch to a live tail
// until Ctrl-C. Flags are documented in HELP.
async function logs(args: string[]): Promise<void> {
  const { apiKey, baseUrl } = resolveObservabilityCredentials();
  const { project, environment } = await resolveProjectEnv(args);
  const minLevel = resolveMinLevel(args);
  const limit = Number(optionValue(args, "--limit") ?? optionValue(args, "-n") ?? 100);
  const jsonMode = hasFlag(args, "--json");

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);

  console.log(
    `Logs for ${project}/${environment}` +
    (minLevel ? ` [${minLevel}+]` : "") +
    ` (backfill ${limit}) — Ctrl+C to stop`,
  );

  try {
    for await (const entry of subscribeObservabilityLogs(
      { baseUrl, apiKey, project, environment },
      { backfill: limit, minLevel, signal: controller.signal },
    )) {
      if (jsonMode) {
        console.log(JSON.stringify(entry));
      } else {
        console.log(formatObservabilityEntry(entry));
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

/**
 * `agent` subcommands: `list` (overview of the scope's agents) and
 * `get <name>` (one agent's resolved resources). Both read the locally compiled
 * manifest — which already has the full nested config — and annotate it with the
 * remote deploy ids, so no extra backend endpoint is needed.
 */
async function agentCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "list" || subcommand === "ls") {
    await agentList(args);
    return;
  }
  if (subcommand === "get") {
    await agentGet(args[1], args);
    return;
  }
  throw new Error("Usage: broods agent <list|get> [name]");
}

/** Compile the local manifest and pair each agent with its remote deploy id. */
async function loadAgentsWithIds(args: string[]): Promise<{
  manifest: CliManifest;
  agents: Array<{ name: string; config: Record<string, unknown>; agentId?: string }>;
}> {
  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "dev",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const remote = await new BroodsSyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token })
    .getManifest(manifest.project, manifest.environment);
  const agents = manifest.resources
    .filter((resource) => resource.kind === "agent")
    .map((resource) => ({
      name: resource.name,
      config: (resource.config ?? {}) as Record<string, unknown>,
      agentId: remote?.ids.agents[resource.name],
    }));

  return { manifest, agents };
}

async function agentList(args: string[]): Promise<void> {
  const { manifest, agents } = await loadAgentsWithIds(args);
  if (agents.length === 0) {
    console.log(`No agents declared in ${manifest.project}/${manifest.environment}.`);
    return;
  }
  console.log(`Agents in ${manifest.project}/${manifest.environment}:`);
  for (const agent of agents) {
    const model = agentModelLabel(agent.config);
    const access = agent.config.publicAccess === true ? "public" : "private";
    const status = agent.agentId ? agent.agentId : "not deployed";
    console.log(`  ${agent.name}  [${access}]  ${model}  (${status})`);
  }
}

async function agentGet(name: string | undefined, args: string[]): Promise<void> {
  if (!name) throw new Error("Usage: broods agent get <name>");
  const { manifest, agents } = await loadAgentsWithIds(args);
  const agent = agents.find((entry) => entry.name === name);
  if (!agent) throw new Error(`Unknown local agent: ${name}`);

  const config = agent.config;
  const sandbox = typeof config.sandbox === "string" ? config.sandbox : undefined;
  const workspaces = Array.isArray(config.workspaces)
    ? config.workspaces.map((ref) => (typeof ref === "string" ? ref : (ref as { name?: string }).name)).filter(Boolean)
    : [];
  const tools = isPlainObject(config.tools) ? Object.keys(config.tools) : [];
  const channels = isPlainObject(config.channels) ? Object.keys(config.channels) : [];
  const subagents = isPlainObject(config.subagent) && Array.isArray((config.subagent as { allowed?: unknown }).allowed)
    ? ((config.subagent as { allowed: unknown[] }).allowed).map((entry) =>
        typeof entry === "string" ? entry : (entry as { name?: string }).name).filter(Boolean)
    : [];
  const webhooks = isPlainObject(config.hooks) && Array.isArray((config.hooks as { webhooks?: unknown }).webhooks)
    ? ((config.hooks as { webhooks: unknown[] }).webhooks).filter(isPlainObject)
    : [];

  console.log(`Agent: ${agent.name}`);
  console.log(`  Project/Env:  ${manifest.project}/${manifest.environment}`);
  console.log(`  Deployed id:  ${agent.agentId ?? "not deployed"}`);
  console.log(`  Public access: ${config.publicAccess === true ? "public (SSE/WebSocket enabled)" : "private (secured by default)"}`);
  console.log(`  Model:        ${agentModelLabel(config)}`);
  console.log(`  Sandbox:      ${sandbox ?? "—"}`);
  console.log(`  Workspaces:   ${workspaces.length > 0 ? workspaces.join(", ") : "—"}`);
  console.log(`  Tools:        ${tools.length > 0 ? tools.join(", ") : "—"}`);
  console.log(`  Subagents:    ${subagents.length > 0 ? subagents.join(", ") : "—"}`);
  console.log(`  Channels:     ${channels.length > 0 ? channels.join(", ") : "—"}`);
  if (webhooks.length > 0) {
    console.log(`  Webhooks:`);
    webhooks.forEach((webhook, index) => {
      const events = Array.isArray(webhook.events) && webhook.events.length > 0 ? webhook.events.join(", ") : "all events";
      const state = webhook.enabled === false ? "disabled" : "enabled";
      console.log(`    [${index}] ${state} → ${webhook.url ?? "—"} (${events})`);
    });
  }
}

/** A compact `provider/modelId` label from an agent's nested config. */
function agentModelLabel(config: Record<string, unknown>): string {
  const model = isPlainObject(config.model) ? config.model : {};
  const provider = typeof model.provider === "string" ? model.provider : undefined;
  const modelId = typeof model.modelId === "string" ? model.modelId : undefined;
  if (provider && modelId) return `${provider}/${modelId}`;

  return modelId ?? provider ?? "unconfigured model";
}

async function run(args: string[]): Promise<void> {
  const [agentName, ...promptParts] = args.filter((arg) => !arg.startsWith("--"));
  if (!agentName || promptParts.length === 0) {
    throw new Error("Usage: broods run <agent> <prompt>");
  }
  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    environment: optionValue(args, "--env"),
    command: "dev",
  });
  const auth = await requireAuth(optionValue(args, "--dashboard-url") ?? config.dashboardUrl);
  const agent = manifest.resources.find((resource) => resource.kind === "agent" && resource.name === agentName);
  if (!agent) throw new Error(`Unknown local agent: ${agentName}`);
  const remote = await new BroodsSyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token })
    .getManifest(manifest.project, manifest.environment);
  const agentId = remote?.ids.agents[agentName];
  if (!agentId) throw new Error(`Agent ${agentName} is not synced yet. Run broods dev --once or broods deploy first.`);
  const runtimeKey = await new BroodsSyncClient({ dashboardUrl: auth.dashboardUrl, token: auth.token })
    .getRuntimeKey(manifest.project, manifest.environment)
    .catch(() => null);
  if (runtimeKey?.apiKey) {
    await writeEnvValue("BROODS_API_KEY", runtimeKey.apiKey);
  }

  // `run` reaches the agent over the public SSE endpoint, which is off by
  // default (issue #65). Warn early if the local config has not opted in; the
  // server is still the source of truth, so we also surface its 403 below.
  if ((agent.config as Record<string, unknown>).publicAccess !== true) {
    printWarning(
      `⚠ Agent "${agentName}" does not set publicAccess: true. The public endpoint is secured by default; ` +
      "if the deployed agent has not enabled it, this run will be refused.",
    );
  }

  const client = new BroodsClient(runtimeKey?.apiKey ? { apiKey: runtimeKey.apiKey } : {});
  const state = createRenderState();
  try {
    for await (const part of client.stream({
      kind: "agent",
      name: agentName,
      id: agentId,
      project: manifest.project,
      environment: manifest.environment,
      ...(runtimeKey?.endpointId ? { endpointId: runtimeKey.endpointId } : {}),
      ...(runtimeKey?.projectSlug ? { projectSlug: runtimeKey.projectSlug } : {}),
      ...(runtimeKey?.environmentSlug ? { environmentSlug: runtimeKey.environmentSlug } : {}),
    }, { input: promptParts.join(" ") })) {
      renderStreamPart(part, state);
    }
    process.stdout.write("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("public_access_disabled")) {
      throw new Error(
        `Agent "${agentName}" is not publicly accessible (secured by default). ` +
        "Set publicAccess: true in its config and redeploy, or enable Public access in the dashboard.",
      );
    }
    throw error;
  }
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
  region: string;
  force: boolean;
}): Promise<void> {
  const path = resolve(process.cwd(), ".env.local");
  const current = await readTextIfExists(path);
  const values = parseEnv(current);
  const nextValues = {
    BROODS_DASHBOARD_URL: options.dashboardUrl,
    BROODS_PROJECT: options.project,
    BROODS_ENVIRONMENT: options.environment,
    BROODS_REGION: options.region,
  };
  const lines = current ? current.replace(/\n?$/, "\n").split(/\n/) : [
    "# Local broods CLI settings. Tokens are stored outside the repo.",
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
    : ["# Local broods CLI settings. Tokens are stored outside the repo."];
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
    .replace(/^-+|-+$/g, "") || "broods-app";
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
  return `import { defineAgent, defineSandbox, env } from "broods";\n\n` +
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
    `    // Expose the public runtime endpoint (SSE/WebSocket) so the API key and\n` +
    `    // \`broods run\` can reach this agent. Off by default — secured: a\n` +
    `    // private agent is only reachable via internal endpoints or channel webhooks.\n` +
    `    publicAccess: true,\n` +
    `  },\n` +
    `});\n`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
