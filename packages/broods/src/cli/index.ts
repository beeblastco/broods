#!/usr/bin/env node
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
import {
  GENERATED_DIR,
  PROJECT_DIR,
  USER_CONFIG_PATH,
  gatewayUrlForDashboard,
  stageFromEnv,
  writeStoredAuth,
  type StoredAuthConfig,
} from "../config.ts";
import { writeGeneratedFiles } from "../codegen.ts";
import {
  type CliOnboardingContext,
  type CliOnboardingOrg,
  type CliOnboardingProject,
  type CliStage,
  diffManifests,
  BroodsSyncClient,
  type RemoteManifestResponse,
} from "../sync.ts";
import {
  BroodsClient,
  DEFAULT_CORE_BASE_URL,
  type AgentReference,
} from "../client.ts";
import { isShellOwnedEnv, loadBroodsRuntimeConfig } from "../runtime-config.ts";
import {
  fetchObservabilityScope,
  subscribeObservabilityLogs,
} from "../observability-client.ts";
import type {
  LogLevel,
  ObservabilityLogEntry,
} from "../observability-contracts.ts";
import {
  hasFlag,
  isPlainObject,
  loginWithBrowser,
  optionValue,
  positionalArgs,
  promptConfirm,
  promptSecret,
  promptSelect,
  promptText,
  requireAuth,
} from "./utils.ts";
import {
  printDeploymentTarget,
  printDiffEntries,
  printEnvSync,
  printReadyLine,
  printWarning,
} from "./output.ts";
import { runAgentTui, streamAgentText } from "./tui.ts";
import packageJson from "../../package.json" with { type: "json" };

const VERSION = packageJson.version;
const DEFAULT_DASHBOARD_URL = "https://dashboard.broods.app";
const DEFAULT_SERVICE_REGION = "eu-west-1";
const SERVICE_REGIONS = [
  { region: "eu-west-1", label: "eu-west-1 (Ireland)" },
  { region: "us-east-1", label: "us-east-1 (US East)" },
  { region: "ap-southeast-1", label: "ap-southeast-1 (Singapore)" },
] as const;

// Options every command accepts, appended to each command's own help so a
// reader never has to jump back to the top-level page for them.
const GLOBAL_OPTIONS = `Global options:
  --project <name>      Project name override (default: package name or folder)
  --stage <name>        Target stage override (BROODS_STAGE otherwise)
  --base-url <url>      broods API base URL for sync/env calls (default: discovered at login)
  --dashboard-url <url> Dashboard base URL for login and deep links (default: ${DEFAULT_DASHBOARD_URL})
  -h, --help            Show this help`;

const HELP = `broods v${VERSION}

Usage: broods <command> [subcommand] [options]

Project:
  init                 Create a broods/ project shell
  dev                  Watch + sync the current stage and live-tail agent logs
  diff                 Show local desired state vs remote state
  deploy               Sync Production once and write BROODS_API_KEY to .env.local

Account:
  login                Authenticate through the dashboard
  status               Show the login, server, org, plan, project and stage in use
  org                  List, switch or create organizations
  stage                List, switch or create stages
  env                  Store, reveal, list or remove encrypted environment variables

Runtime:
  agent                Inspect the agents declared in the current scope
  run <agent> [prompt] Chat with an agent in a terminal UI
  logs                 Backfill recent logs then live-tail
  stream               Stream live logs for the whole project/stage (Ctrl+C to stop)

Options:
  -h, --help           Show help for a command (e.g. \`broods org --help\`)
  -v, --version        Print the CLI version

Run \`broods <command> --help\` to see a command's subcommands and flags.`;

// One page per command, printed by `broods <command> --help` and by the
// grouped commands when they are invoked with no subcommand at all.
const COMMAND_HELP: Record<string, string> = {
  agent: `Usage: broods agent <list|get> [name]

Subcommands:
  list                 List the agents in the current project/stage scope
  get <name>           Show an agent's model, sandbox, workspaces, tools and channels

${GLOBAL_OPTIONS}`,
  deploy: `Usage: broods deploy [options]

Syncs Production once and writes BROODS_API_KEY to .env.local. Ignores
BROODS_STAGE by design — pass --stage to deploy anywhere else.

Options:
  --prune               Allow deploy to delete undeclared remote resources
  --rotate-key          Mint a fresh runtime API key and write it to .env.local
  --region <region>     Broods service region preference (default: ${DEFAULT_SERVICE_REGION})

${GLOBAL_OPTIONS}`,
  dev: `Usage: broods dev [--once] [options]

Watches broods/, syncs the current stage (BROODS_STAGE, default Development)
and live-tails agent logs. Confirms before deleting, and auto-pushes
env("NAME") values from .env.local.

Options:
  --once                Sync a single time and exit (no watch, no log stream)
  --level <lvl>         Minimum level for the log tail INFO|WARN|ERROR (default: no filter)
  --errors              Tail WARN/ERROR only (same as --level warn)

${GLOBAL_OPTIONS}`,
  diff: `Usage: broods diff [options]

Shows local desired state against the remote state of the current stage.

${GLOBAL_OPTIONS}`,
  env: `Usage: broods env <set|get|list|rm> [name]

Subcommands:
  set <name>           Store an encrypted environment variable (value read from the prompt)
  get <name>           Reveal a variable's value (audited)
  list                 List environment variable names (values stay hidden)
  rm <name>            Remove an environment variable

${GLOBAL_OPTIONS}`,
  init: `Usage: broods init [options]

Creates the broods/ project shell and .env.local defaults.

Options:
  --region <region>     Broods service region preference (default: ${DEFAULT_SERVICE_REGION})
  --force               Overwrite existing starter files

${GLOBAL_OPTIONS}`,
  login: `Usage: broods login [options]

Authenticates through the dashboard and stores the token in
~/.broods/config.json.

Options:
  --region <region>     Broods service region preference (default: ${DEFAULT_SERVICE_REGION})

${GLOBAL_OPTIONS}`,
  logs: `Usage: broods logs [options]

Backfills recent logs then live-tails. All levels, 100 lines by default.

Options:
  -n, --limit <n>       Backfill line count (default 100)
  --level <lvl>         Minimum log level INFO|WARN|ERROR (default: no filter)
  --errors              Show WARN/ERROR only (same as --level warn)
  --json                Print the backfill as raw JSON

${GLOBAL_OPTIONS}`,
  org: `Usage: broods org <list|use|create> [name]

Subcommands:
  list                 List the organizations this login can act on
  use <name>           Switch the CLI to another organization (slug, name or id)
  create <name>        Create an organization and switch to it

Only orgs where you are owner or admin can be selected from the CLI.

${GLOBAL_OPTIONS}`,
  run: `Usage: broods run <agent> [prompt]

Chats with an agent in a terminal UI (reasoning, tool cards, y/n approvals).
A prompt is sent as the first turn; redirected output streams plain text and
therefore requires a prompt.

${GLOBAL_OPTIONS}`,
  stage: `Usage: broods stage <list|use|create> [name]

Subcommands:
  list                 List the project's stages
  use <name>           Point .env.local at another stage and refresh BROODS_API_KEY
  create <name>        Create a stage in the current project

Options:
  --from <stage>        Clone the source stage's architecture and env vars
  --use                 Switch to the stage \`stage create\` just made

${GLOBAL_OPTIONS}`,
  status: `Usage: broods status [options]

Shows the login, server, org, plan, project and stage the next command uses.

${GLOBAL_OPTIONS}`,
  stream: `Usage: broods stream [options]

Streams live logs for the whole project/stage until Ctrl+C. No backfill.

Options:
  --level <lvl>         Minimum log level INFO|WARN|ERROR (default: no filter)
  --errors              Show WARN/ERROR only (same as --level warn)

${GLOBAL_OPTIONS}`,
};

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
  }

  assertNoPreRenameConfig(args);

  const help = COMMAND_HELP[command];
  if (help && (hasFlag(args, "--help") || hasFlag(args, "-h"))) {
    console.log(help);

    return;
  }

  switch (command) {
    case "init":
      await init(args);

      return;
    case "login":
      await login(args);

      return;
    case "status":
      await status(args);

      return;
    case "org":
      await orgCommand(args);

      return;
    case "stage":
      await stageCommand(args);

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

// Falls back to the top-level page so a mistyped key still prints something
// useful instead of "undefined" inside an error message.
function commandHelp(command: string): string {
  return COMMAND_HELP[command] ?? HELP;
}

async function init(args: string[]): Promise<void> {
  const force = hasFlag(args, "--force");
  const root = resolve(process.cwd(), PROJECT_DIR);
  await mkdir(resolve(root, GENERATED_DIR), { recursive: true });
  await writeStarter(resolve(root, "index.ts"), starterAgent(), force);
  await writeStarter(
    resolve(root, ".gitignore"),
    "_generated\n.cache\n",
    force,
  );
  const dashboardUrl =
    optionValue(args, "--dashboard-url") ?? DEFAULT_DASHBOARD_URL;
  await writeLocalEnvDefaults({
    dashboardUrl: dashboardUrl,
    baseUrl: gatewayUrlForDashboard(dashboardUrl),
    project: optionValue(args, "--project") ?? inferProjectName(process.cwd()),
    stage: optionValue(args, "--stage") ?? "development",
    region: optionValue(args, "--region") ?? DEFAULT_SERVICE_REGION,
    force: force,
  });
  await ensureModuleType();
  console.log(`Created ${PROJECT_DIR}/`);
}

async function login(args: string[]): Promise<void> {
  const runtime = loadBroodsRuntimeConfig();
  const dashboardUrl =
    optionValue(args, "--dashboard-url") ??
    runtime.dashboardUrl ??
    DEFAULT_DASHBOARD_URL;
  const auth = await loginWithBrowser(dashboardUrl);
  const project =
    optionValue(args, "--project") ??
    process.env.BROODS_PROJECT ??
    inferProjectName(process.cwd());
  const stage = optionValue(args, "--stage") ?? stageFromEnv() ?? "development";
  await writeLocalEnvDefaults({
    dashboardUrl: auth.dashboardUrl ?? dashboardUrl,
    baseUrl: auth.baseUrl,
    project: project,
    stage: stage,
    region:
      optionValue(args, "--region") ??
      process.env.BROODS_REGION ??
      DEFAULT_SERVICE_REGION,
    force: false,
  });
  const user = auth.user?.email || auth.user?.name || auth.user?.authId;
  const org = auth.org ? `${auth.org.name} (${auth.org.slug})` : undefined;
  const account = auth.account?.username;
  console.log(`Logged in to ${auth.dashboardUrl}`);
  if (user) console.log(`User: ${user}`);
  if (org) console.log(`Org: ${org}`);
  if (account) console.log(`Account: ${account}`);
  await writeRuntimeKeyForLogin(auth.baseUrl, auth.token, project, stage);
}

/**
 * Best-effort: recover the stage's runtime key after login and write it to
 * .env.local so `dev` can stream right away. Silent when the project/stage
 * is not deployed yet, because login itself should still succeed.
 */
async function writeRuntimeKeyForLogin(
  baseUrl: string,
  token: string,
  project: string,
  stage: string,
): Promise<void> {
  try {
    const client = new BroodsSyncClient({ baseUrl: baseUrl, token: token });
    const key = await client.getRuntimeKey(project, stage);
    if (key?.apiKey) {
      await writeEnvValue("BROODS_API_KEY", key.apiKey);
      console.log(`Wrote BROODS_API_KEY (${key.keyHint}) to .env.local`);
    }
  } catch {
    // Login must not fail because the key fetch did.
  }
}

async function status(args: string[]): Promise<void> {
  const runtime = loadBroodsRuntimeConfig();
  const scope = targetScope(args);
  const dashboardUrl =
    optionValue(args, "--dashboard-url") ??
    runtime.dashboardUrl ??
    DEFAULT_DASHBOARD_URL;
  console.log(`broods v${VERSION}`);
  console.log(`Dashboard:   ${dashboardUrl}`);
  console.log(`Project:     ${scope.project}`);
  console.log(`Stage:       ${scope.stage}`);

  let auth: StoredAuthConfig;
  try {
    auth = await requireAuth(optionValue(args, "--base-url"));
  } catch {
    printWarning("Not logged in. Run `broods login`.");

    return;
  }
  console.log(`Server:      ${auth.baseUrl}`);

  const client = new BroodsSyncClient({
    baseUrl: auth.baseUrl,
    token: auth.token,
  });
  const context = await client.getOnboarding();
  const org = context.orgs.find((entry) => entry.id === context.currentOrgId);
  if (context.user) console.log(`User:        ${context.user.email}`);
  console.log(
    `Org:         ${org ? formatOrgChoice(org) : context.currentOrgId}`,
  );
  if (context.account) {
    console.log(
      `Account:     ${context.account.username} (${context.account.status})`,
    );
  }

  // The runtime key is per stage, so a key that does not match the one this
  // org/stage serves means `run`, `logs` and `stream` are talking to a
  // different tenant than `dev` would sync to.
  const localKey = process.env.BROODS_API_KEY;
  const keySource = isShellOwnedEnv("BROODS_API_KEY")
    ? "your shell"
    : ".env.local";
  let remoteKey: Awaited<ReturnType<BroodsSyncClient["getRuntimeKey"]>> = null;
  let keyError: string | null = null;
  try {
    remoteKey = await client.getRuntimeKey(scope.project, scope.stage);
  } catch (error) {
    keyError = error instanceof Error ? error.message : String(error);
  }
  if (keyError) {
    console.log("Runtime key: unavailable");
    printWarning(`⚠ Could not read the runtime key: ${keyError}`);
  } else if (!remoteKey?.apiKey) {
    console.log("Runtime key: none for this scope");
    printWarning(
      `${scope.project}/${scope.stage} does not exist in ${org?.name ?? "this org"} yet. \`broods dev\` will create it.`,
    );
  } else if (!localKey) {
    console.log(`Runtime key: ${remoteKey.keyHint} (not in .env.local)`);
    printWarning("BROODS_API_KEY is not set locally. Run `broods dev`.");
  } else if (localKey === remoteKey.apiKey) {
    console.log(
      `Runtime key: ${remoteKey.keyHint} (matches this org and stage)`,
    );
  } else {
    console.log(`Runtime key: ${remoteKey.keyHint} expected`);
    printWarning(
      `⚠ BROODS_API_KEY from ${keySource} belongs to a different org or stage. Run \`broods stage use ` +
        `${scope.stage}\` to repoint it.`,
    );
  }

  const projects = context.projects.map((entry) => entry.name);
  if (!projects.includes(scope.project)) {
    printWarning(
      `This org has no project named ${scope.project}. It has: ${projects.length > 0 ? projects.join(", ") : "none"}.`,
    );
  }
}

async function orgCommand(args: string[]): Promise<void> {
  const [subcommand, needle] = positionalArgs(args);
  if (!subcommand) {
    console.log(commandHelp("org"));

    return;
  }
  const isList = subcommand === "list" || subcommand === "ls";
  const isUse = subcommand === "use" || subcommand === "select";
  const isCreate = subcommand === "create" || subcommand === "new";
  // Reject a typo before the login round trip, or it surfaces as a network
  // error instead of the usage the caller actually needs.
  if (!isList && !isUse && !isCreate) {
    throw new Error(
      `Unknown org subcommand: ${subcommand}\n\n${commandHelp("org")}`,
    );
  }

  const runtime = loadBroodsRuntimeConfig();
  const dashboardUrl =
    optionValue(args, "--dashboard-url") ??
    runtime.dashboardUrl ??
    DEFAULT_DASHBOARD_URL;
  const auth = await requireAuthOrLogin(dashboardUrl);
  const client = new BroodsSyncClient({
    baseUrl: auth.baseUrl,
    token: auth.token,
  });
  const context = await client.getOnboarding();

  if (isList) {
    for (const org of context.orgs) {
      const marker = org.id === context.currentOrgId ? "*" : " ";
      const disabled =
        org.accountStatus === "active" ? "" : ` [${org.accountStatus} account]`;
      console.log(`${marker} ${formatOrgChoice(org)}${disabled}`);
    }
    console.log(
      "\nOnly orgs where you are owner or admin can be selected from the CLI.",
    );

    return;
  }

  if (isUse) {
    const selectable = context.orgs.filter(
      (org) => org.accountStatus === "active",
    );
    const selected = needle
      ? selectable.find(
          (org) =>
            org.slug === needle || org.name === needle || org.id === needle,
        )
      : await promptSelect("Select organization", selectable, formatOrgChoice);
    if (!selected) {
      throw new Error(
        `No selectable organization matches "${needle}". Run \`broods org list\`.`,
      );
    }
    await applyOrgSelection(
      client,
      auth,
      await client.selectOnboardingOrg(selected.id),
      args,
    );

    return;
  }

  const name =
    needle ??
    (await promptText("Organization name", inferProjectName(process.cwd())));
  if (!name.trim()) throw new Error("Organization name is required.");
  await applyOrgSelection(
    client,
    auth,
    await client.createOnboardingOrg(name),
    args,
  );
}

async function stageCommand(args: string[]): Promise<void> {
  const [subcommand, needle] = positionalArgs(args);
  if (!subcommand) {
    console.log(commandHelp("stage"));

    return;
  }
  const isList = subcommand === "list" || subcommand === "ls";
  const isUse = subcommand === "use" || subcommand === "select";
  const isCreate = subcommand === "create" || subcommand === "new";
  // Reject a typo before the login round trip, or it surfaces as a network
  // error instead of the usage the caller actually needs.
  if (!isList && !isUse && !isCreate) {
    throw new Error(
      `Unknown stage subcommand: ${subcommand}\n\n${commandHelp("stage")}`,
    );
  }

  const runtime = loadBroodsRuntimeConfig();
  const dashboardUrl =
    optionValue(args, "--dashboard-url") ??
    runtime.dashboardUrl ??
    DEFAULT_DASHBOARD_URL;
  const scope = targetScope(args);
  const auth = await requireAuthOrLogin(dashboardUrl);
  const client = new BroodsSyncClient({
    baseUrl: auth.baseUrl,
    token: auth.token,
  });

  if (isList) {
    const stages = await client.listStages(scope.project);
    if (stages.length === 0) {
      console.log(
        `${scope.project} has no stages yet. \`broods dev\` creates Development.`,
      );

      return;
    }
    console.log(`Stages for ${scope.project}:`);
    for (const stage of stages) console.log(formatStage(stage, scope.stage));

    return;
  }

  if (isUse) {
    const stages = await client.listStages(scope.project);
    const selected = needle
      ? stages.find((stage) => stageNameEquals(stage.name, needle))
      : await promptSelect("Select stage", stages, (stage) =>
          formatStage(stage, scope.stage).trim(),
        );
    if (!selected) {
      throw new Error(
        `${scope.project} has no stage "${needle}". Existing: ${stages.map((stage) => stage.name).join(", ")}. Create it with \`broods stage create ${needle} --from ${scope.stage}\`.`,
      );
    }
    const stageShadowed = isShellOwnedEnv("BROODS_STAGE");
    await writeEnvValue("BROODS_STAGE", selected.name);
    console.log(`Stage: ${selected.name} (wrote BROODS_STAGE)`);
    warnShellShadowedEnv("BROODS_STAGE", stageShadowed);
    await syncRuntimeKeyForScope(client, {
      project: scope.project,
      stage: selected.name,
    });

    return;
  }

  const name = needle ?? (await promptText("Stage name", "staging"));
  if (!name.trim()) throw new Error("Stage name is required.");
  const from = optionValue(args, "--from");
  const created = await client.createStage(scope.project, name, from);
  console.log(
    `Created stage ${created.stage.name} in ${scope.project}${created.clonedFrom ? ` from ${created.clonedFrom}` : ""}`,
  );
  if (created.clonedFrom) {
    console.log(
      `  ${created.stage.agentCount} agent(s), ${created.stage.variableCount} env var(s) copied`,
    );
  }
  if (!hasFlag(args, "--use")) {
    console.log(
      `Switch to it with \`broods stage use ${created.stage.name}\`.`,
    );

    return;
  }
  const stageShadowed = isShellOwnedEnv("BROODS_STAGE");
  await writeEnvValue("BROODS_STAGE", created.stage.name);
  console.log(`Stage: ${created.stage.name} (wrote BROODS_STAGE)`);
  warnShellShadowedEnv("BROODS_STAGE", stageShadowed);
  await syncRuntimeKeyForScope(client, {
    project: scope.project,
    stage: created.stage.name,
  });
}

async function diff(args: string[]): Promise<void> {
  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    stage: optionValue(args, "--stage"),
    command: "dev",
  });
  const auth = await requireAuth(
    optionValue(args, "--base-url") ?? config.baseUrl,
  );
  const client = new BroodsSyncClient({
    baseUrl: auth.baseUrl,
    token: auth.token,
  });
  const remote = await client.getManifest(manifest.project, manifest.stage);
  printDiffEntries(diffManifests(manifest, remote?.manifest ?? null));
}

async function deploy(args: string[]): Promise<void> {
  const { manifest, config, resourceAliases, channels } = await compileProject({
    project: optionValue(args, "--project"),
    stage: optionValue(args, "--stage"),
    command: "deploy",
    useRuntimeStage: false,
  });
  const auth = await requireAuth(
    optionValue(args, "--base-url") ?? config.baseUrl,
  );
  const client = new BroodsSyncClient({
    baseUrl: auth.baseUrl,
    token: auth.token,
  });
  const result = await client.putManifest(
    manifest,
    hasFlag(args, "--prune"),
    hasFlag(args, "--rotate-key"),
  );
  await writeGeneratedFiles(
    manifest,
    result.ids,
    process.cwd(),
    resourceAliases,
    result.deployment,
    channels,
  );
  await ensureGitIgnore();
  await ensureModuleType();
  console.log(
    `Synced ${result.manifest.resources.length} resources to ${manifest.project}/${manifest.stage}`,
  );
  await applyDeploymentKey(result.deployment);
  printChannelEndpoints(channels, result);
  printSyncWarnings(result);
}

/**
 * Persist the stage's recoverable runtime API key after a deploy.
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
  if (missing.length > 0) {
    printWarning(
      `⚠ ${missing.length} env var(s) referenced in agent config but not set: ${missing.join(", ")}`,
    );
    for (const name of missing) console.log(`    broods env set ${name}`);
  }
  const missingPolicies = result.warnings?.missingPolicies ?? [];
  if (missingPolicies.length > 0) {
    printWarning(
      `⚠ ${missingPolicies.length} policy ref(s) in agent config match no policy resource ` +
        `in this deploy and will be ignored at runtime: ${missingPolicies.join(", ")}`,
    );
  }
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
    BROODS_RELOAD_ENV: "1",
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
      .catch((error) =>
        console.error(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        syncing = false;
        if (pending) {
          pending = false;
          runSync();
        }
      });
  };

  const watcher = watch(
    resolve(process.cwd(), PROJECT_DIR),
    { recursive: true },
    (_event, filename) => {
      if (!filename || isGeneratedPath(filename)) return;
      clearTimeout(timer);
      timer = setTimeout(runSync, 150);
    },
  );

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
async function streamDevLogs(
  args: string[],
  signal: AbortSignal,
): Promise<void> {
  let creds: { apiKey: string; baseUrl: string };
  try {
    creds = resolveObservabilityCredentials();
  } catch {
    console.log(
      "· live logs off — no runtime key found for this stage yet. Run `broods dev --once` after login to create or reconnect it.",
    );

    return;
  }

  let project: string;
  let stage: string;
  try {
    ({ project, stage } = await resolveObservabilityTarget(args, creds));
  } catch {
    return;
  }

  const minLevel = resolveMinLevel(args);
  try {
    for await (const entry of subscribeObservabilityLogs(
      {
        baseUrl: creds.baseUrl,
        apiKey: creds.apiKey,
        project: project,
        stage: stage,
      },
      { backfill: 0, minLevel: minLevel, signal: signal },
    )) {
      console.log(formatObservabilityEntry(entry));
    }
  } catch (error) {
    if (!signal.aborted) {
      console.error(
        `live logs: ${error instanceof Error ? error.message : String(error)}`,
      );
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
  await writeStarter(
    resolve(root, ".gitignore"),
    "_generated\n.cache\n",
    false,
  );
  console.log(`Created starter ${PROJECT_DIR}/`);
}

async function ensureLocalDevDefaults(args: string[]): Promise<void> {
  const path = resolve(process.cwd(), ".env.local");
  const current = await readTextIfExists(path);
  const values = parseEnv(current);
  const stageValue = values.BROODS_STAGE;
  const missing = [
    "BROODS_DASHBOARD_URL",
    "BROODS_BASE_URL",
    "BROODS_PROJECT",
    "BROODS_REGION",
  ].filter((key) => values[key] === undefined);
  if (missing.length === 0 && stageValue !== undefined) return;
  const needsProject = values.BROODS_PROJECT === undefined;
  const needsStage = stageValue === undefined;
  const needsRegion = values.BROODS_REGION === undefined;

  const runtime = loadBroodsRuntimeConfig();
  const dashboardUrl =
    optionValue(args, "--dashboard-url") ??
    runtime.dashboardUrl ??
    DEFAULT_DASHBOARD_URL;
  let project =
    optionValue(args, "--project") ??
    process.env.BROODS_PROJECT ??
    inferProjectName(process.cwd());
  let stage = optionValue(args, "--stage") ?? stageFromEnv() ?? "development";
  let region =
    optionValue(args, "--region") ??
    process.env.BROODS_REGION ??
    DEFAULT_SERVICE_REGION;

  if (process.stdin.isTTY && needsProject) {
    const auth = await requireAuthOrLogin(dashboardUrl);
    const client = new BroodsSyncClient({
      baseUrl: auth.baseUrl,
      token: auth.token,
    });
    const context = await getOnboardingContextOrFallback(client, auth);
    const selectedContext = await selectOnboardingOrg(client, context);
    project = await selectOnboardingProject(selectedContext, project);
    if (!project.trim()) throw new Error("Project name is required.");
  }

  if (process.stdin.isTTY && needsStage) {
    stage = await promptText("Stage", stage);
    if (!stage.trim()) throw new Error("Stage is required.");
  }

  if (process.stdin.isTTY && needsRegion) {
    region = await promptSelect(
      "Select service region",
      [...SERVICE_REGIONS],
      (entry) => entry.label,
    ).then((entry) => entry.region);
  }

  await writeLocalEnvDefaults({
    dashboardUrl: dashboardUrl,
    baseUrl: runtime.baseUrl ?? gatewayUrlForDashboard(dashboardUrl),
    project: project,
    stage: stage,
    region: region,
    force: false,
  });
}

async function requireAuthOrLogin(dashboardUrl: string) {
  try {
    return await requireAuth();
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
      orgs: [
        {
          id: auth.org.id,
          name: auth.org.name,
          slug: auth.org.slug,
          role: "admin",
          accountStatus: "active",
        },
      ],
      projects: [],
    };
  }
}

/**
 * Persist the switched-to org locally, then repoint BROODS_API_KEY at it so
 * `run`/`logs` cannot keep serving the org the CLI just left.
 */
async function applyOrgSelection(
  client: BroodsSyncClient,
  auth: StoredAuthConfig,
  context: CliOnboardingContext,
  args: string[],
): Promise<void> {
  const org = context.orgs.find((entry) => entry.id === context.currentOrgId);
  if (!org) {
    throw new Error("Selected organization is not visible to this login");
  }

  if (process.env.BROODS_TOKEN) {
    printWarning(
      "BROODS_TOKEN is set, so the switch applies to this token only and was not stored.",
    );
  } else {
    await writeStoredAuth({
      ...auth,
      org: { id: org.id, name: org.name, slug: org.slug },
      ...(context.account
        ? {
            account: {
              id: context.account.id,
              username: context.account.username,
            },
          }
        : {}),
    });
  }

  console.log(`Org: ${formatOrgChoice(org)}`);
  console.log(
    `Projects: ${context.projects.length > 0 ? context.projects.map((entry) => entry.name).join(", ") : "none yet"}`,
  );
  await syncRuntimeKeyForScope(client, targetScope(args));
}

/**
 * Rewrite BROODS_API_KEY for the scope the CLI now points at. The switch is
 * already persisted by the time this runs, so a lookup failure warns and
 * returns rather than failing the whole command with a stored-but-unreported
 * org/stage change.
 */
async function syncRuntimeKeyForScope(
  client: BroodsSyncClient,
  scope: { project: string; stage: string },
): Promise<void> {
  let key: Awaited<ReturnType<BroodsSyncClient["getRuntimeKey"]>>;
  try {
    key = await client.getRuntimeKey(scope.project, scope.stage);
  } catch (error) {
    printWarning(
      `⚠ Could not read the runtime key for ${scope.project}/${scope.stage} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        "BROODS_API_KEY still points at the previous scope — run `broods status` to check it.",
    );

    return;
  }
  if (!key?.apiKey) {
    printWarning(
      `⚠ ${scope.project}/${scope.stage} is not synced here yet, so BROODS_API_KEY still points at the previous scope. Run \`broods dev\`.`,
    );

    return;
  }

  // A shell export shadows .env.local, so process.env is not proof the file is
  // current: write it anyway and tell the user their export still wins.
  const shadowed = isShellOwnedEnv("BROODS_API_KEY");
  if (!shadowed && process.env.BROODS_API_KEY === key.apiKey) return;

  await writeEnvValue("BROODS_API_KEY", key.apiKey);
  console.log(`Wrote BROODS_API_KEY (${key.keyHint}) to .env.local`);
  warnShellShadowedEnv("BROODS_API_KEY", shadowed);
}

/**
 * Warn when a shell export overrides the `.env.local` value just written.
 * `shadowed` has to be sampled before the write, which makes the file and
 * `process.env` agree again.
 */
function warnShellShadowedEnv(name: string, shadowed: boolean): void {
  if (!shadowed) return;
  printWarning(
    `⚠ ${name} is exported in your shell, which wins over .env.local. ` +
      `Run \`unset ${name}\` or the next broods command keeps the old value.`,
  );
}

function formatOrgChoice(org: CliOnboardingOrg): string {
  const suffix =
    org.role === "owner" || org.role === "admin" ? org.role : "member";
  const plan = org.plan ? `, ${org.plan} plan` : "";

  return `${org.name} (${org.slug}, ${suffix}${plan})`;
}

function formatStage(stage: CliStage, current: string): string {
  const marker = stageNameEquals(stage.name, current) ? "*" : " ";
  const region = stage.deploymentRegion ? `, ${stage.deploymentRegion}` : "";

  return `${marker} ${stage.name} (${stage.kind}${region}) — ${stage.agentCount} agent(s), ${stage.variableCount} env var(s)`;
}

/** Stage names match the way the backend matches them: trimmed, case-insensitive. */
function stageNameEquals(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** The project/stage a command acts on, without compiling the project. */
function targetScope(args: string[]): { project: string; stage: string } {
  loadBroodsRuntimeConfig();

  return {
    project:
      optionValue(args, "--project") ??
      process.env.BROODS_PROJECT ??
      inferProjectName(process.cwd()),
    stage: optionValue(args, "--stage") ?? stageFromEnv() ?? "development",
  };
}

async function selectOnboardingOrg(
  client: BroodsSyncClient,
  context: CliOnboardingContext,
): Promise<CliOnboardingContext> {
  const activeOrgs = context.orgs.filter(
    (org) => org.accountStatus === "active",
  );
  const createNew = { kind: "create" as const, name: "New organization" };
  const selected = await promptSelect(
    "Select organization",
    [...activeOrgs, createNew],
    (entry) =>
      "kind" in entry ? "Create new organization" : formatOrgChoice(entry),
  );

  if ("kind" in selected) {
    const name = await promptText(
      "Organization name",
      inferProjectName(process.cwd()),
    );
    if (!name.trim()) throw new Error("Organization name is required.");

    return await client.createOnboardingOrg(name);
  }

  return selected.id === context.currentOrgId
    ? context
    : await client.selectOnboardingOrg(selected.id);
}

function defaultProjectName(
  context: CliOnboardingContext,
  inferred: string,
): string {
  const exact = context.projects.find(
    (project) => project.name === inferred || project.slug === inferred,
  );

  return exact?.name ?? inferred;
}

async function selectOnboardingProject(
  context: CliOnboardingContext,
  inferred: string,
): Promise<string> {
  if (context.projects.length === 0) {
    return promptText("Project name", inferred);
  }

  const createNew = {
    kind: "create" as const,
    name: defaultProjectName(context, inferred),
    slug: "",
  };
  const choices: Array<CliOnboardingProject | typeof createNew> = [
    ...context.projects,
    createNew,
  ];
  const selected = await promptSelect("Select project", choices, (entry) =>
    "kind" in entry && entry.kind === "create"
      ? `Create new project (${entry.name})`
      : `${entry.name} (${entry.slug})`,
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
    const child = spawn(
      process.execPath,
      [entryPoint, "dev", "--once", ...args],
      {
        stdio: "inherit",
        env: env,
      },
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();

        return;
      }
      reject(
        new Error(
          signal
            ? `Sync child exited from signal ${signal}`
            : `Sync child exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

/**
 * Syncs the dev stage once. Creates/updates are pushed first so they apply
 * immediately; deletions (resources removed from code) are then confirmed
 * interactively before pruning, so an edit-in-progress never silently destroys
 * an agent's history or a workspace's files — and a slow answer never blocks the
 * non-destructive sync. Declined deletes are remembered (across watch child
 * processes via `BROODS_DECLINED_FILE`) so they are not re-prompted.
 */
async function syncDev(args: string[]): Promise<RemoteManifestResponse> {
  const { manifest, config, resourceAliases, channels } = await compileProject({
    project: optionValue(args, "--project"),
    stage: optionValue(args, "--stage"),
    command: "dev",
  });
  const auth = await requireAuth(
    optionValue(args, "--base-url") ?? config.baseUrl,
  );
  const client = new BroodsSyncClient({
    baseUrl: auth.baseUrl,
    token: auth.token,
  });
  const remote = await client.getManifest(manifest.project, manifest.stage);
  const diff = diffManifests(manifest, remote?.manifest ?? null);
  printDiffEntries(diff.filter((entry) => entry.operation !== "delete"));

  // Push any `env("NAME")` values from .env.local up first, so this sync's configs
  // resolve them and the missing-env warning only fires for genuinely-absent vars.
  await syncLocalEnvVars(
    client,
    manifest,
    envSyncScopeKey(auth.baseUrl, auth.token),
  );

  // Push creates/updates (and canvas wiring) immediately, undeleted.
  let result = await client.putManifest(manifest, false);
  await writeGeneratedFiles(
    manifest,
    result.ids,
    process.cwd(),
    resourceAliases,
    result.deployment,
    channels,
  );
  await ensureGitIgnore();
  await ensureModuleType();

  const declined = await loadDeclinedDeletes();
  const deletes = diff.filter((entry) => entry.operation === "delete");
  const undecided = deletes.filter(
    (entry) => !declined.has(`${entry.kind}:${entry.name}`),
  );
  let pruned = false;
  if (undecided.length > 0) {
    printWarning("⚠ These remote resources are no longer declared locally:");
    printDiffEntries(undecided);
    if (
      await promptConfirm(
        `Delete ${undecided.length} resource(s) from ${manifest.project}/${manifest.stage}?`,
      )
    ) {
      result = await client.putManifest(manifest, true);
      await writeGeneratedFiles(
        manifest,
        result.ids,
        process.cwd(),
        resourceAliases,
        result.deployment,
        channels,
      );
      await clearDeclinedDeletes();
      pruned = true;
    } else {
      await rememberDeclinedDeletes(
        undecided.map((entry) => `${entry.kind}:${entry.name}`),
      );
    }
  }

  // Persistent reminder: kept-but-undeclared resources are easy to forget once
  // the prompt stops re-asking, so re-surface them (non-blocking) every sync
  // until they are re-declared in code or pruned.
  if (!pruned && deletes.length > 0) {
    const names = deletes
      .map((entry) => `${entry.kind}:${entry.name}`)
      .join(", ");
    printWarning(
      `⚠ ${deletes.length} undeclared resource(s) kept remotely: ${names} — re-declare in code or run \`deploy --prune\` to remove.`,
    );
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
  // The URL carries no agent, so every channel of one type shares it. Print it
  // once with the aliases behind it rather than the same line N times.
  const aliasesByType = new Map<(typeof channels)[number]["type"], string[]>();
  for (const channel of channels) {
    if (!result.ids.agents[channel.agentName]) continue;
    const aliases = aliasesByType.get(channel.type) ?? [];
    aliases.push(channel.alias);
    aliasesByType.set(channel.type, aliases);
  }

  // A stage that is not production gets its own URL, so pasting it into the
  // provider moves traffic to this stage instead of contending for the account.
  const isProduction =
    deployment.stageKind === undefined || deployment.stageKind === "production";
  for (const [type, aliases] of aliasesByType) {
    const url = isProduction
      ? client.accountWebhookUrl(deployment.accountId, type)
      : client.stageWebhookUrl(
          deployment.accountId,
          deployment.endpointId,
          type,
        );
    console.log(
      `Channel ${aliases.join(", ")} (${type}): ${url}${type === "pancake" ? "?secret=<PANCAKE_WEBHOOK_SECRET>" : ""}`,
    );
  }
}

/**
 * Auto-syncs the env vars an agent config references via `env("NAME")` from the
 * local environment (`.env.local`, already loaded into `process.env`) up to the
 * cloud stage during `dev`. This fulfills the Convex-style `env set` flow
 * automatically so the dashboard never needs a manual step for local secrets.
 *
 * Deliberately one-way and set-only: only manifest-referenced names are pushed
 * (never `BROODS_*` control vars or unrelated `.env.local` keys), values
 * are never read back (the backend stores them encrypted/write-only), and
 * removing a var locally never deletes it remotely. `deploy` is left untouched
 * so production secrets stay an explicit `broods env set`.
 */
async function syncLocalEnvVars(
  client: BroodsSyncClient,
  manifest: CliManifest,
  scopeKey: string,
): Promise<void> {
  const present = collectEnvRefNames(manifest).filter((name) => {
    const value = process.env[name];

    return !name.startsWith("BROODS_") && value !== undefined && value !== "";
  });
  if (present.length === 0) return;

  // Churn guard: only push a var whose value changed since we last synced it,
  // tracked by a user-local hash cache outside the project tree. Without this
  // every watch save would re-encrypt and re-bake every agent config that
  // references the var. The cache stores hashes (never the values), survives
  // across watch child processes, and is scoped to the authenticated target so
  // switching dashboard/account cannot suppress a needed push. A cleared cache
  // just re-pushes once — safe because the set is idempotent.
  const cache = await loadEnvSyncCache();
  const known =
    cache[envCacheKey(scopeKey, manifest.project, manifest.stage)] ?? {};
  const remoteNames = new Set(
    (await client.listEnv(manifest.project, manifest.stage)).map(
      (entry) => entry.name,
    ),
  );
  const changed = present.filter(
    (name) =>
      !remoteNames.has(name) ||
      known[name] !== hashEnvValue(process.env[name]!),
  );
  if (changed.length === 0) return;

  await Promise.all(
    changed.map((name) =>
      client.setEnv(manifest.project, manifest.stage, name, process.env[name]!),
    ),
  );
  for (const name of changed) known[name] = hashEnvValue(process.env[name]!);
  cache[envCacheKey(scopeKey, manifest.project, manifest.stage)] = known;
  await saveEnvSyncCache(cache);
  printEnvSync(changed);
}

type EnvSyncCache = Record<string, Record<string, string>>;

function envSyncScopeKey(baseUrl: string, token: string): string {
  return `${baseUrl}:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

function envCacheKey(scopeKey: string, project: string, stage: string): string {
  return `${scopeKey}:${project}:${stage}`;
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
async function rememberEnvSyncValue(
  scopeKey: string,
  project: string,
  stage: string,
  name: string,
  value: string,
): Promise<void> {
  const cache = await loadEnvSyncCache();
  const key = envCacheKey(scopeKey, project, stage);
  cache[key] = { ...(cache[key] ?? {}), [name]: hashEnvValue(value) };
  await saveEnvSyncCache(cache);
}

/** Drops a var's cached hash after `env rm`, so a later re-add with the same value re-pushes. */
async function forgetEnvSyncValue(
  scopeKey: string,
  project: string,
  stage: string,
  name: string,
): Promise<void> {
  const cache = await loadEnvSyncCache();
  const key = envCacheKey(scopeKey, project, stage);
  if (!cache[key] || !(name in cache[key])) return;
  delete cache[key][name];
  await saveEnvSyncCache(cache);
}

async function printDevTarget(args: string[]): Promise<void> {
  const runtime = loadBroodsRuntimeConfig();
  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    stage: optionValue(args, "--stage"),
    command: "dev",
  });
  const auth = await requireAuth(
    optionValue(args, "--base-url") ?? config.baseUrl,
  );
  printDeploymentTarget({
    project: manifest.project,
    stage: manifest.stage,
    dashboardUrl:
      optionValue(args, "--dashboard-url") ??
      runtime.dashboardUrl ??
      auth.dashboardUrl ??
      config.dashboardUrl ??
      DEFAULT_DASHBOARD_URL,
  });
}

/** Reads the delete keys already declined this watch session, if any. */
async function loadDeclinedDeletes(): Promise<Set<string>> {
  const path = process.env.BROODS_DECLINED_FILE;
  if (!path) return new Set();
  const text = await readTextIfExists(path);

  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
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
  const [subcommand, name] = positionalArgs(args);
  if (!subcommand) {
    console.log(commandHelp("env"));

    return;
  }
  const isList = subcommand === "list" || subcommand === "ls";
  const isRemove = subcommand === "rm" || subcommand === "remove";
  const isGet = subcommand === "get";
  const needsName = subcommand === "set" || isRemove || isGet;
  if (!isList && !needsName) {
    throw new Error(
      `Unknown env subcommand: ${subcommand}\n\n${commandHelp("env")}`,
    );
  }
  if (needsName && !name) {
    throw new Error(
      `broods env ${subcommand} needs a variable name.\n\n${commandHelp("env")}`,
    );
  }

  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    stage: optionValue(args, "--stage"),
    command: "dev",
  });
  const auth = await requireAuth(
    optionValue(args, "--base-url") ?? config.baseUrl,
  );
  const client = new BroodsSyncClient({
    baseUrl: auth.baseUrl,
    token: auth.token,
  });
  const scopeKey = envSyncScopeKey(auth.baseUrl, auth.token);
  const target = `${manifest.project}/${manifest.stage}`;

  if (isList) {
    const variables = await client.listEnv(manifest.project, manifest.stage);
    if (variables.length === 0) {
      console.log(`No environment variables set for ${target}.`);

      return;
    }
    console.log(`Environment variables for ${target} (values hidden):`);
    for (const variable of variables) console.log(`  ${variable.name}`);

    return;
  }

  if (isGet) {
    const value = await client.getEnv(manifest.project, manifest.stage, name!);
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
    await client.removeEnv(manifest.project, manifest.stage, name!);
    await forgetEnvSyncValue(scopeKey, manifest.project, manifest.stage, name!);
    console.log(`Removed ${name} from ${target}`);

    return;
  }

  const value = await promptSecret(name!);
  await client.setEnv(manifest.project, manifest.stage, name!, value);
  await rememberEnvSyncValue(
    scopeKey,
    manifest.project,
    manifest.stage,
    name!,
    value,
  );
  console.log(`Stored ${name} for ${target}`);
}

// Runtime API key (BROODS_API_KEY, written by `deploy`/`init`) + base URL
// for the observability gateway. No dashboard login required.
function resolveObservabilityCredentials(): {
  apiKey: string;
  baseUrl: string;
} {
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

  return { apiKey: apiKey, baseUrl: baseUrl };
}

/** Parse --errors / --level <lvl> into a LogLevel (defaults to WARN). */
function resolveMinLevel(args: string[]): LogLevel | undefined {
  if (hasFlag(args, "--errors")) return "WARN";
  const raw = optionValue(args, "--level");
  // No filter by default: agent-loop and tool-call events are INFO, so a WARN
  // default hides everything a healthy run emits and reads as "no logs".
  if (!raw) return undefined;
  const upper = raw.toUpperCase();
  if (upper === "WARN" || upper === "WARNING") return "WARN";
  if (upper === "ERROR") return "ERROR";
  if (upper === "INFO") return "INFO";
  throw new Error(`Unknown log level: ${raw}. Use INFO, WARN, or ERROR.`);
}

/** Resolve project + stage for observability commands (same as other commands). */
async function resolveProjectStage(
  args: string[],
): Promise<{ project: string; stage: string }> {
  loadBroodsRuntimeConfig();
  const project = optionValue(args, "--project") ?? process.env.BROODS_PROJECT;
  const stage = optionValue(args, "--stage") ?? stageFromEnv();
  if (!project) {
    throw new Error(
      "Project name is required. Pass --project <name> or set BROODS_PROJECT in .env.local.",
    );
  }
  if (!stage) {
    throw new Error(
      "Stage name is required. Pass --stage <name> or set BROODS_STAGE in .env.local.",
    );
  }

  return { project: project, stage: stage };
}

// The gateway matches the socket path on the key's slug, but BROODS_PROJECT
// holds a display name. Ask core so the two cannot disagree.
async function resolveObservabilityTarget(
  args: string[],
  credentials: { baseUrl: string; apiKey: string },
): Promise<{ project: string; stage: string }> {
  const configured = await resolveProjectStage(args);
  const scope = await fetchObservabilityScope(
    credentials.baseUrl,
    credentials.apiKey,
  );
  if (!scope) return configured;
  if (
    scope.projectSlug !== configured.project ||
    scope.stageSlug !== configured.stage
  ) {
    console.log(
      `· reading ${scope.projectSlug}/${scope.stageSlug} — the runtime key is scoped there, not to ${configured.project}/${configured.stage}.`,
    );
  }

  return { project: scope.projectSlug, stage: scope.stageSlug };
}

/** Render one ObservabilityLogEntry as `HH:mm:ss.SSS LEVEL eventType message`. */
function formatObservabilityEntry(entry: ObservabilityLogEntry): string {
  const time = new Date(entry.ts).toISOString().slice(11, 23);
  const level = entry.level.padEnd(5);

  return `${time} ${level} ${entry.eventType} ${entry.message}`;
}

// `broods stream` — live tail of the whole project/stage log stream
// until Ctrl-C, no backfill. Flags are documented in HELP.
async function streamLogs(args: string[]): Promise<void> {
  const { apiKey, baseUrl } = resolveObservabilityCredentials();
  const { project, stage } = await resolveObservabilityTarget(args, {
    baseUrl: baseUrl,
    apiKey: apiKey,
  });
  const minLevel = resolveMinLevel(args);

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);

  console.log(
    `Streaming live logs for ${project}/${stage}` +
      (minLevel ? ` [${minLevel}+]` : "") +
      " — Ctrl+C to stop",
  );

  try {
    for await (const entry of subscribeObservabilityLogs(
      { baseUrl: baseUrl, apiKey: apiKey, project: project, stage: stage },
      { backfill: 0, minLevel: minLevel, signal: controller.signal },
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
  const { project, stage } = await resolveObservabilityTarget(args, {
    baseUrl: baseUrl,
    apiKey: apiKey,
  });
  const minLevel = resolveMinLevel(args);
  const limit = Number(
    optionValue(args, "--limit") ?? optionValue(args, "-n") ?? 100,
  );
  const jsonMode = hasFlag(args, "--json");

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);

  console.log(
    `Logs for ${project}/${stage}` +
      (minLevel ? ` [${minLevel}+]` : "") +
      ` (backfill ${limit}) — Ctrl+C to stop`,
  );

  try {
    for await (const entry of subscribeObservabilityLogs(
      { baseUrl: baseUrl, apiKey: apiKey, project: project, stage: stage },
      { backfill: limit, minLevel: minLevel, signal: controller.signal },
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
  const [subcommand, name] = positionalArgs(args);
  if (!subcommand) {
    console.log(commandHelp("agent"));

    return;
  }
  if (subcommand === "list" || subcommand === "ls") {
    await agentList(args);

    return;
  }
  if (subcommand === "get") {
    await agentGet(name, args);

    return;
  }

  throw new Error(
    `Unknown agent subcommand: ${subcommand}\n\n${commandHelp("agent")}`,
  );
}

/** Compile the local manifest and pair each agent with its remote deploy id. */
async function loadAgentsWithIds(args: string[]): Promise<{
  manifest: CliManifest;
  agents: Array<{
    name: string;
    config: Record<string, unknown>;
    agentId?: string;
  }>;
}> {
  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    stage: optionValue(args, "--stage"),
    command: "dev",
  });
  const auth = await requireAuth(
    optionValue(args, "--base-url") ?? config.baseUrl,
  );
  const remote = await new BroodsSyncClient({
    baseUrl: auth.baseUrl,
    token: auth.token,
  }).getManifest(manifest.project, manifest.stage);
  const agents = manifest.resources
    .filter((resource) => resource.kind === "agent")
    .map((resource) => ({
      name: resource.name,
      config: (resource.config ?? {}) as Record<string, unknown>,
      agentId: remote?.ids.agents[resource.name],
    }));

  return { manifest: manifest, agents: agents };
}

async function agentList(args: string[]): Promise<void> {
  const { manifest, agents } = await loadAgentsWithIds(args);
  if (agents.length === 0) {
    console.log(`No agents declared in ${manifest.project}/${manifest.stage}.`);

    return;
  }
  console.log(`Agents in ${manifest.project}/${manifest.stage}:`);
  for (const agent of agents) {
    const model = agentModelLabel(agent.config);
    const access = agent.config.publicAccess === true ? "public" : "private";
    const status = agent.agentId ? agent.agentId : "not deployed";
    console.log(`  ${agent.name}  [${access}]  ${model}  (${status})`);
  }
}

async function agentGet(
  name: string | undefined,
  args: string[],
): Promise<void> {
  if (!name) throw new Error(`Missing agent name.\n\n${commandHelp("agent")}`);
  const { manifest, agents } = await loadAgentsWithIds(args);
  const agent = agents.find((entry) => entry.name === name);
  if (!agent) throw new Error(`Unknown local agent: ${name}`);

  const config = agent.config;
  const sandbox =
    typeof config.sandbox === "string" ? config.sandbox : undefined;
  const workspaces = Array.isArray(config.workspaces)
    ? config.workspaces
        .map((ref) =>
          typeof ref === "string" ? ref : (ref as { name?: string }).name,
        )
        .filter(Boolean)
    : [];
  const tools = isPlainObject(config.tools) ? Object.keys(config.tools) : [];
  const channels = isPlainObject(config.channels)
    ? Object.keys(config.channels)
    : [];
  const subagents =
    isPlainObject(config.subagent) &&
    Array.isArray((config.subagent as { allowed?: unknown }).allowed)
      ? (config.subagent as { allowed: unknown[] }).allowed
          .map((entry) =>
            typeof entry === "string"
              ? entry
              : (entry as { name?: string }).name,
          )
          .filter(Boolean)
      : [];
  const webhooks =
    isPlainObject(config.hooks) &&
    Array.isArray((config.hooks as { webhooks?: unknown }).webhooks)
      ? (config.hooks as { webhooks: unknown[] }).webhooks.filter(isPlainObject)
      : [];

  console.log(`Agent: ${agent.name}`);
  console.log(`  Project/Stage: ${manifest.project}/${manifest.stage}`);
  console.log(`  Deployed id:  ${agent.agentId ?? "not deployed"}`);
  console.log(
    `  Public access: ${config.publicAccess === true ? "public (SSE/WebSocket enabled)" : "private (secured by default)"}`,
  );
  console.log(`  Model:        ${agentModelLabel(config)}`);
  console.log(`  Sandbox:      ${sandbox ?? "—"}`);
  console.log(
    `  Workspaces:   ${workspaces.length > 0 ? workspaces.join(", ") : "—"}`,
  );
  console.log(`  Tools:        ${tools.length > 0 ? tools.join(", ") : "—"}`);
  console.log(
    `  Subagents:    ${subagents.length > 0 ? subagents.join(", ") : "—"}`,
  );
  console.log(
    `  Channels:     ${channels.length > 0 ? channels.join(", ") : "—"}`,
  );
  if (webhooks.length > 0) {
    console.log(`  Webhooks:`);
    webhooks.forEach((webhook, index) => {
      const events =
        Array.isArray(webhook.events) && webhook.events.length > 0
          ? webhook.events.join(", ")
          : "all events";
      const state = webhook.enabled === false ? "disabled" : "enabled";
      console.log(
        `    [${index}] ${state} → ${webhook.url ?? "—"} (${events})`,
      );
    });
  }
}

/** A compact `provider/modelId` label from an agent's nested config. */
function agentModelLabel(config: Record<string, unknown>): string {
  const model = isPlainObject(config.model) ? config.model : {};
  const provider =
    typeof model.provider === "string" ? model.provider : undefined;
  const modelId = typeof model.modelId === "string" ? model.modelId : undefined;
  if (provider && modelId) return `${provider}/${modelId}`;

  return modelId ?? provider ?? "unconfigured model";
}

async function run(args: string[]): Promise<void> {
  const [agentName, ...promptParts] = positionalArgs(args);
  if (!agentName) {
    throw new Error(`Missing agent name.\n\n${commandHelp("run")}`);
  }
  // The terminal UI needs a terminal to draw into. Redirected output falls back
  // to plain text, which in turn needs a prompt since nothing can be typed.
  const prompt = promptParts.join(" ");
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive && !prompt) {
    throw new Error(
      "Usage: broods run <agent> <prompt>. Omit the prompt for an interactive session, which requires a TTY.",
    );
  }
  const { manifest, config } = await compileProject({
    project: optionValue(args, "--project"),
    stage: optionValue(args, "--stage"),
    command: "dev",
  });
  const auth = await requireAuth(
    optionValue(args, "--base-url") ?? config.baseUrl,
  );
  const agent = manifest.resources.find(
    (resource) => resource.kind === "agent" && resource.name === agentName,
  );
  if (!agent) throw new Error(`Unknown local agent: ${agentName}`);
  const remote = await new BroodsSyncClient({
    baseUrl: auth.baseUrl,
    token: auth.token,
  }).getManifest(manifest.project, manifest.stage);
  const agentId = remote?.ids.agents[agentName];
  if (!agentId)
    throw new Error(
      `Agent ${agentName} is not synced yet. Run broods dev --once or broods deploy first.`,
    );
  const runtimeKey = await new BroodsSyncClient({
    baseUrl: auth.baseUrl,
    token: auth.token,
  })
    .getRuntimeKey(manifest.project, manifest.stage)
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

  // Runtime traffic has to reach the same deployment the control plane resolved.
  // Without an explicit base URL the SDK falls back to prod, which rejects a
  // dev-issued runtime key with a 401.
  const client = new BroodsClient({
    baseUrl:
      optionValue(args, "--base-url") ??
      process.env.BROODS_BASE_URL ??
      process.env.BROODS_HOST ??
      auth.baseUrl,
    ...(runtimeKey?.apiKey ? { apiKey: runtimeKey.apiKey } : {}),
  });
  const ref: AgentReference = {
    kind: "agent",
    name: agentName,
    id: agentId,
    project: manifest.project,
    stage: manifest.stage,
    ...(runtimeKey?.endpointId ? { endpointId: runtimeKey.endpointId } : {}),
    ...(runtimeKey?.projectSlug ? { projectSlug: runtimeKey.projectSlug } : {}),
    ...(runtimeKey?.stageSlug ? { stageSlug: runtimeKey.stageSlug } : {}),
  };
  try {
    if (interactive) {
      await runAgentTui({
        client: client,
        agent: ref,
        ...(prompt ? { prompt: prompt } : {}),
      });

      return;
    }
    await streamAgentText({ client: client, agent: ref, prompt: prompt });
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

async function writeStarter(
  path: string,
  contents: string,
  force: boolean,
): Promise<void> {
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
  const missing = needed.filter(
    (line) => !existing.split(/\r?\n/).some((l) => l.trim() === line),
  );
  if (missing.length === 0) return;
  const body = existing
    ? existing.trimEnd() + "\n" + missing.join("\n") + "\n"
    : missing.join("\n") + "\n";
  await writeFile(path, body, "utf8");
}

/**
 * Node warns (MODULE_TYPELESS_PACKAGE_JSON) and reparses every project file when
 * the host package.json declares no module type. Our project files are ESM.
 */
async function ensureModuleType(): Promise<void> {
  const path = resolve(process.cwd(), "package.json");
  const existing = await readTextIfExists(path);
  if (!existing) return;
  let manifest: { type?: string };
  try {
    manifest = JSON.parse(existing) as { type?: string };
  } catch {
    return;
  }
  if (manifest.type) return;
  manifest.type = "module";
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

async function writeLocalEnvDefaults(options: {
  dashboardUrl: string;
  baseUrl?: string;
  project: string;
  stage: string;
  region: string;
  force: boolean;
}): Promise<void> {
  const path = resolve(process.cwd(), ".env.local");
  const current = await readTextIfExists(path);
  const values = parseEnv(current);
  // Only pin the API base URL when it is known. Guessing one for a deployment
  // we do not host would write an address that never resolves.
  const nextValues: Record<string, string> = {
    BROODS_DASHBOARD_URL: options.dashboardUrl,
    ...(options.baseUrl ? { BROODS_BASE_URL: options.baseUrl } : {}),
    BROODS_PROJECT: options.project,
    BROODS_STAGE: options.stage,
    BROODS_REGION: options.region,
  };
  const lines = current
    ? current.replace(/\n?$/, "\n").split(/\n/)
    : ["# Local broods CLI settings. Tokens are stored outside the repo."];
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
  return (
    basename(resolve(cwd))
      .replace(/^@/, "")
      .replace(/\//g, "-")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "broods-app"
  );
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
      if (
        entry.name === GENERATED_DIR ||
        entry.name === "generated" ||
        entry.name === ".cache"
      )
        continue;
      await collectSourceFiles(full, files);
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".md"))
    )
      files.push(full);
  }
}

function isGeneratedPath(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some(
      (part) =>
        part === GENERATED_DIR || part === "generated" || part === ".cache",
    );
}

function starterAgent(): string {
  return (
    `import { defineAgent, defineSandbox, env } from "broods";\n\n` +
    `// A Lambda sandbox: a fresh, ephemeral bash environment created per run.\n` +
    `export const lambdaSandbox = defineSandbox({\n` +
    `  name: "lambda-sandbox",\n` +
    `  provider: "lambda",\n` +
    `  network: { mode: "deny-all" },\n` +
    `  permissionMode: "bypass",\n` +
    `  timeout: 60,\n` +
    `});\n\n` +
    `export const myAgent = defineAgent({\n` +
    `  name: "my-agent",\n` +
    `  provider: {\n` +
    `    openai: { apiKey: env("OPENAI_API_KEY") },\n` +
    `  },\n` +
    `  model: {\n` +
    `    provider: "openai",\n` +
    `    modelId: "gpt-5.5",\n` +
    `  },\n` +
    `  agent: {\n` +
    `    system: "You are a helpful assistant.",\n` +
    `  },\n` +
    `  sandbox: lambdaSandbox,\n` +
    `  // Expose the public runtime endpoint (SSE/WebSocket) so the API key and\n` +
    `  // \`broods run\` can reach this agent. Off by default — secured: a\n` +
    `  // private agent is only reachable via internal endpoints or channel webhooks.\n` +
    `  publicAccess: true,\n` +
    `});\n`
  );
}

// The rename ships no compatibility shim, so the pre-rename flag and key have
// to fail here. Left alone they resolve to Development, and the command acts
// on a stage the user never named.
function assertNoPreRenameConfig(args: string[]): void {
  if (args.includes("--env")) {
    throw new Error(
      "--env was renamed to --stage. Pass --stage <name> instead.",
    );
  }

  loadBroodsRuntimeConfig();
  const legacy = process.env.BROODS_ENVIRONMENT;
  if (legacy !== undefined && process.env.BROODS_STAGE === undefined) {
    throw new Error(
      `BROODS_ENVIRONMENT was renamed to BROODS_STAGE. Rename the key in .env.local (it is currently set to "${legacy}").`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
