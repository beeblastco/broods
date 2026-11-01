// Local Broods stack: Convex and Traefik in docker, core and gateway as watched bun processes.
// One stack per worktree, on its own port block, with state under ~/.broods-local/<instance>/.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Doc } from "../packages/convex/_generated/dataModel.ts";

import { renderFileConfig } from "../apps/edge/src/traefik.ts";
import { createAccountSecret } from "../packages/convex/model/accountSecrets.ts";
import {
  SELF_HOST_ALGORITHM,
  SELF_HOST_KEY_ID,
  publicJwk,
} from "../packages/convex/model/selfHostAuth.ts";
import { BroodsAccountClient } from "../packages/broods/src/account.ts";
import { BroodsClient } from "../packages/broods/src/client.ts";
import { verifyCases } from "./local-verify/cases/index.ts";
import { runPerf } from "./local-verify/perf.ts";
import {
  VerifyFailure,
  assertStep,
  lastJsonLine,
  pollUntil,
  probeHttp,
  smokeModel,
  type VerifyContext,
} from "./local-verify/harness.ts";

// To bump: pull ghcr.io/convex/convex-backend:latest and copy its RepoDigests entry.
const CONVEX_IMAGE =
  process.env.BROODS_LOCAL_CONVEX_IMAGE ??
  "ghcr.io/convex/convex-backend@sha256:b756b06641d15a55b5ec0692897ce5ad3715ddccfd02e1e213621e9e764255c8";
// Keep equal to the cluster's Traefik.
const TRAEFIK_IMAGE = "traefik:v3.7.12";
const HEALTH_TIMEOUT_MS = 60_000;
const PORT_BLOCK_BASE = 4300;
const PORT_BLOCK_SIZE = 10;
const STATE_ROOT = join(homedir(), ".broods-local");
interface InstancePorts {
  convexApi: number;
  convexSite: number;
  core: number;
  dashboard: number;
  edge: number;
  gateway: number;
}

interface InstanceSecrets {
  accountConfigEncryption: string;
  adminAccount: string;
  mediaTicket: string;
  serviceAuth: string;
  sessionSigningKey: string;
  stageTicket: string;
  terminalTicket: string;
}

interface InstanceState {
  adminKey?: string;
  convexSourceHash?: string;
  deploymentEnvHash?: string;
  instanceId: string;
  instanceSecret: string;
  perf?: boolean;
  pids: { core?: number; dashboard?: number; gateway?: number };
  portBase: number;
  secrets: InstanceSecrets;
}

interface PerfRecord {
  at: string;
  command: string;
  failed?: string;
  steps: PerfStep[];
  totalMs: number;
}

interface PerfStep {
  ms: number;
  step: string;
}

const repoRoot = resolve(import.meta.dir, "..");
const dashboardDir = join(repoRoot, "apps", "dashboard");
const command = process.argv[2];
const flags = new Set(process.argv.slice(3));

switch (command) {
  case "up":
    await up(
      flags.has("--fresh"),
      flags.has("--perf"),
      flags.has("--dashboard"),
    );
    break;
  case "down":
    await down(flags.has("--purge"));
    break;
  case "status":
    await status(flags.has("--key"));
    break;
  case "verify":
    await verify();
    break;
  case "perf":
    await perf(flags.has("--record"));
    break;
  case "convex":
    convex(process.argv.slice(3));
    break;
  default:
    console.error(
      "Usage: bun scripts/local-stack.ts <up|down|status|verify|perf|convex> [--fresh|--purge|--perf|--dashboard|--key|--record]",
    );
    process.exit(2);
}

async function down(purge: boolean): Promise<void> {
  const instanceId = currentInstanceId();
  const state = loadState(instanceId);
  if (!state) {
    console.log(`no state for ${instanceId}, nothing to stop`);

    return;
  }

  await Promise.all([
    stopProcess(state.pids.dashboard, "dashboard"),
    stopProcess(state.pids.gateway, "gateway"),
    stopProcess(state.pids.core, "core"),
  ]);
  state.pids = {};
  saveState(state);

  const container = containerName(instanceId);
  if (purge) {
    docker(["rm", "-f", "-v", container], { allowFailure: true });
    docker(["rm", "-f", traefikContainerName(instanceId)], {
      allowFailure: true,
    });
    docker(["volume", "rm", dataVolumeName(instanceId)], {
      allowFailure: true,
    });
    rmSync(instanceDir(instanceId), { recursive: true, force: true });
    console.log(`purged ${instanceId} (container, volume, state)`);

    return;
  }

  docker(["stop", container, traefikContainerName(instanceId)], {
    allowFailure: true,
  });
  console.log(`stopped ${instanceId} (state kept for fast restart)`);
}

function convex(args: readonly string[]): void {
  const state = loadState(currentInstanceId());
  if (!state) {
    console.error(`no local stack for this worktree (${currentInstanceId()})`);
    process.exit(1);
  }
  const result = tryConvexCli(state, args);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.ok ? 0 : 1;
}

// `--key` output feeds `E2E_ADMIN_KEY=$(...)`: print the key alone.
async function status(printKey: boolean): Promise<void> {
  const instanceId = currentInstanceId();
  const state = loadState(instanceId);
  if (!state) {
    console.error(`no local stack for this worktree (${instanceId})`);
    if (printKey) process.exit(1);

    return;
  }
  if (printKey) {
    console.log(state.secrets.adminAccount);

    return;
  }

  const container = dockerContainerState(containerName(instanceId));
  console.log(`instance  ${instanceId}`);
  console.log(`convex    ${container ?? "not created"}`);
  console.log(
    `traefik   ${dockerContainerState(traefikContainerName(instanceId)) ?? "not created"} (:${ports(state).edge})`,
  );
  console.log(
    `core      ${processState(state.pids.core)} (:${ports(state).core})`,
  );
  console.log(
    `gateway   ${processState(state.pids.gateway)} (:${ports(state).gateway})`,
  );
  console.log(
    `dashboard ${processState(state.pids.dashboard)} (:${ports(state).dashboard})`,
  );

  const health = await probeHttp(
    `http://127.0.0.1:${ports(state).edge}/healthz`,
  );
  console.log(`healthz   ${health ?? "unreachable"}`);

  const rss = processRssMb([state.pids.core, state.pids.gateway]);
  if (rss.size > 0) {
    const coreRss = state.pids.core ? rss.get(state.pids.core) : undefined;
    const gatewayRss = state.pids.gateway
      ? rss.get(state.pids.gateway)
      : undefined;
    console.log(
      `memory    core ${coreRss ?? "?"} MB, gateway ${gatewayRss ?? "?"} MB, convex ${containerMemory(containerName(instanceId)) ?? "?"}`,
    );
  }

  for (const line of lastPerfSummaries(instanceId)) {
    console.log(`perf      ${line}`);
  }
}

async function up(
  fresh: boolean,
  perfMode: boolean,
  withDashboard: boolean,
): Promise<void> {
  const startedAt = Date.now();
  const perf: PerfStep[] = [];
  if (fresh) {
    await down(true);
  }
  const state = loadOrCreateState();
  const dashboard = withDashboard ? dashboardUrl(state) : undefined;
  const traefikImage = pullImage(TRAEFIK_IMAGE);
  console.log(
    `[${state.instanceId}] edge :${ports(state).edge} gateway :${ports(state).gateway} core :${ports(state).core} convex :${ports(state).convexApi}/${ports(state).convexSite}`,
  );

  await measureStep(perf, "convex container", async () => {
    ensureConvexContainer(state);
    await waitForHttp(
      `http://127.0.0.1:${ports(state).convexApi}/version`,
      "convex backend",
    );
  });

  if (!state.adminKey) {
    await measureStep(perf, "admin key", () => {
      state.adminKey = generateConvexAdminKey(state);
      saveState(state);
    });
  }

  const deploymentEnv = deploymentEnvEntries(state);
  const deploymentEnvHash = createHash("sha256")
    .update(JSON.stringify(deploymentEnv))
    .digest("hex");
  if (state.deploymentEnvHash !== deploymentEnvHash) {
    await measureStep(perf, "deployment env", () => {
      configureDeploymentEnv(state, deploymentEnv);
      state.deploymentEnvHash = deploymentEnvHash;
      // auth.config.ts reads this env at deploy time.
      state.convexSourceHash = undefined;
      saveState(state);
    });
  }

  const sourceHash = await measureStep(
    perf,
    "convex source hash",
    convexSourceHash,
  );
  if (state.convexSourceHash !== sourceHash) {
    console.log("deploying convex functions (packages/convex changed)...");
    await measureStep(perf, "convex deploy", () => {
      runConvexCli(state, ["deploy", "-y"]);
      state.convexSourceHash = sourceHash;
      saveState(state);
    });
  } else {
    console.log("convex functions unchanged, skipping deploy");
  }

  if (state.perf !== perfMode && isProcessAlive(state.pids.core)) {
    await stopProcess(state.pids.core, "core");
    state.pids.core = undefined;
  }
  state.perf = perfMode;
  await measureStep(perf, "start core + gateway + edge", async () => {
    startCore(state);
    startGateway(state);
    await traefikImage;
    ensureTraefikContainer(state);
    saveState(state);
  });

  const edgeUrl = `http://127.0.0.1:${ports(state).edge}`;
  await measureStep(perf, "health checks", async () => {
    // Only the config plane answers 401; Traefik gives 404/502 until routes and upstreams are up.
    await Promise.all([
      waitForHttp(`${edgeUrl}/healthz`, "gateway via edge"),
      waitForHttp(`http://127.0.0.1:${ports(state).core}/healthz`, "core"),
      waitForHttp(`${edgeUrl}/v1/agents`, "config plane via edge", 401),
    ]);
  });

  if (dashboard) {
    await measureStep(perf, "dashboard", async () => {
      await startDashboard(state);
      saveState(state);
      await waitForHttp(`${dashboard}/healthz`, "dashboard");
    });
  }

  const totalMs = Date.now() - startedAt;
  recordPerf(state.instanceId, "up", perf, totalMs);
  printPerfBreakdown(perf, totalMs);
  console.log(`\nstack up in ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  edge      ${edgeUrl}`);
  if (dashboard) {
    console.log(`  dashboard ${dashboard}`);
    console.log(`  e2e       E2E_BASE_URL=${dashboard}`);
  }
  console.log("  admin key bun run local:status -- --key");
  console.log(`  logs      ${join(instanceDir(state.instanceId), "logs")}`);
  console.log(
    `  perf      ${join(instanceDir(state.instanceId), "perf.jsonl")}`,
  );
  console.log(
    `\nnext: bun scripts/local-stack.ts ${perfMode ? "perf" : "verify"}`,
  );
}

async function perf(record: boolean): Promise<void> {
  const state = loadState(currentInstanceId());
  if (!state?.perf || !isProcessAlive(state.pids.core)) {
    console.error("core is not running in perf mode. Run `up --perf` first");
    process.exit(1);
  }

  const edgeUrl = `http://127.0.0.1:${ports(state).edge}`;
  const runId = Date.now().toString(36);
  const accountSecret = await createAccount(
    edgeUrl,
    state.secrets.adminAccount,
    `perf-${runId}`,
  );
  const passed = await runPerf(
    verifyContext(
      state,
      accountSecret,
      runId,
      <T>(_step: string, fn: () => Promise<T>): Promise<T> => fn(),
    ),
    { record: record, tracePath: convexTracePath(state.instanceId) },
  );
  if (!passed) process.exit(1);
}

async function verify(): Promise<void> {
  const state = loadState(currentInstanceId());
  if (!state) {
    console.error("no local stack for this worktree. Run `up` first");
    process.exit(1);
  }

  const startedAt = Date.now();
  const perf: PerfStep[] = [];
  const edgeUrl = `http://127.0.0.1:${ports(state).edge}`;
  let currentCase = "";
  let currentStep = "";
  const measure = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
    currentStep = step;
    const result = await measureStep(perf, step, fn);
    currentStep = currentCase;

    return result;
  };
  let failedStep: string | undefined;
  try {
    await measure("gateway healthz", async (): Promise<void> => {
      const health = await probeHttp(`${edgeUrl}/healthz`);
      assertStep("gateway healthz", health === 200, `status ${health}`);
    });
    const runId = `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
    await measure("create account", (): Promise<string> =>
      createAccount(edgeUrl, state.secrets.adminAccount, `smoke-${runId}`),
    );
    const accountSecret = await measure(
      "create manifest account",
      async (): Promise<string> => createManifestAccount(state, runId),
    );
    const context = verifyContext(state, accountSecret, runId, measure);
    for (const verifyCase of verifyCases) {
      currentCase = verifyCase.name;
      currentStep = currentCase;
      console.log(`\n${verifyCase.name}`);
      await verifyCase(context);
    }
  } catch (error) {
    failedStep = error instanceof VerifyFailure ? error.step : currentStep;
    console.error(`  FAIL ${failedStep}`);
    console.error(
      error instanceof VerifyFailure ? `       ${error.detail}` : error,
    );
  }

  const totalMs = Date.now() - startedAt;
  recordPerf(state.instanceId, "verify", perf, totalMs, failedStep);
  printPerfBreakdown(perf, totalMs);
  if (failedStep !== undefined) process.exit(1);
  console.log(`\nverify passed in ${(totalMs / 1000).toFixed(1)}s`);
}

function configureDeploymentEnv(
  state: InstanceState,
  entries: Record<string, string>,
): void {
  console.log("configuring convex deployment env...");
  const envFile = join(instanceDir(state.instanceId), "deployment.env");
  writeFileSync(
    envFile,
    Object.entries(entries)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n"),
    { mode: 0o600 },
  );
  try {
    runConvexCli(state, ["env", "set", "--from-file", envFile, "--force"]);
  } finally {
    rmSync(envFile, { force: true });
  }
}

function convexSourceHash(): string {
  const listed = execFileSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "--", "packages/convex"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const hash = createHash("sha256");
  for (const file of listed.split("\n").filter(Boolean).sort()) {
    const path = join(repoRoot, file);
    if (!existsSync(path)) continue;
    hash.update(file);
    hash.update(readFileSync(path));
  }

  return hash.digest("hex");
}

// Admin API accounts have synthetic org bindings; the verify cases need a real org row.
function createManifestAccount(state: InstanceState, runId: string): string {
  const slug = `smoke-${runId}`;
  const path = join(instanceDir(state.instanceId), `verify-org-${runId}.jsonl`);
  writeFileSync(
    path,
    JSON.stringify({
      name: slug,
      slug: slug,
      ownerAuthId: `local-${runId}`,
      plan: "free",
      createdAt: Date.now(),
    }) + "\n",
  );
  runConvexCli(state, ["import", "--append", "--table", "orgs", path]);
  const orgs: Doc<"orgs">[] = JSON.parse(
    runConvexCli(state, ["data", "orgs", "--format", "json"], true),
  );
  const org = orgs.find((entry): boolean => entry.slug === slug);
  if (!org) throw new Error("Verify org was not found in the local backend");
  const secret = createAccountSecret();
  const secretHash = createHash("sha256").update(secret).digest("hex");
  runConvexCli(
    state,
    [
      "run",
      "account/accounts:create",
      JSON.stringify({
        orgId: org._id,
        username: slug,
        secretHash: secretHash,
      }),
    ],
    true,
  );

  return secret;
}

// self-host auth trusts the dashboard's session JWKS instead of WorkOS, so no WORKOS_*.
function deploymentEnvEntries(state: InstanceState): Record<string, string> {
  const signingKey: { d?: string } = JSON.parse(
    state.secrets.sessionSigningKey,
  );

  return {
    ACCOUNT_CONFIG_ENCRYPTION_SECRET: state.secrets.accountConfigEncryption,
    ADMIN_ACCOUNT_SECRET: state.secrets.adminAccount,
    BROODS_ACCOUNT_MANAGE_URL: `http://host.docker.internal:${ports(state).core}`,
    BROODS_AUTH_PROVIDER: "self-host",
    BROODS_SESSION_JWKS: JSON.stringify({ keys: [publicJwk(signingKey)] }),
    SERVICE_AUTH_SECRET: state.secrets.serviceAuth,
    STAGE_TICKET_SECRET: state.secrets.stageTicket,
  };
}

// The backend binds the host's port numbers, not the image's 3210/3211: Node actions call
// back at CONVEX_CLOUD_ORIGIN from inside the container.
function ensureConvexContainer(state: InstanceState): void {
  const name = containerName(state.instanceId);
  const { convexApi, convexSite } = ports(state);
  const containerState = dockerContainerState(name);
  // HostConfig, not `docker port`, which lists only a running container's bindings.
  if (
    containerState &&
    !docker(
      ["inspect", "--format", "{{json .HostConfig.PortBindings}}", name],
      { allowFailure: true },
    ).includes(`"${convexApi}/tcp"`)
  ) {
    throw new Error(
      "this stack predates Node action callbacks; run `bun run local:up -- --fresh` to recreate it",
    );
  }
  if (containerState === "running") return;
  if (containerState) {
    docker(["start", name]);

    return;
  }

  console.log(`creating convex container ${name}...`);
  docker([
    "run",
    "-d",
    "--name",
    name,
    "-p",
    `${convexApi}:${convexApi}`,
    "-p",
    `${convexSite}:${convexSite}`,
    "-v",
    `${dataVolumeName(state.instanceId)}:/convex/data`,
    "--add-host",
    "host.docker.internal:host-gateway",
    "-e",
    `INSTANCE_NAME=${state.instanceId}`,
    "-e",
    `INSTANCE_SECRET=${state.instanceSecret}`,
    "-e",
    `CONVEX_CLOUD_ORIGIN=http://127.0.0.1:${ports(state).convexApi}`,
    "-e",
    `CONVEX_SITE_ORIGIN=http://127.0.0.1:${ports(state).convexSite}`,
    "-e",
    "DISABLE_BEACON=true",
    "-e",
    "DO_NOT_REQUIRE_SSL=true",
    "--entrypoint",
    "bash",
    CONVEX_IMAGE,
    "-c",
    `sed -e 's/--port 3210/--port ${convexApi}/' -e 's/--site-proxy-port 3211/--site-proxy-port ${convexSite}/' run_backend.sh > /tmp/run_backend.sh && grep -q -- '--port ${convexApi} ' /tmp/run_backend.sh && grep -q -- '--site-proxy-port ${convexSite} ' /tmp/run_backend.sh && exec bash /tmp/run_backend.sh || { echo 'run_backend.sh no longer binds --port 3210; update the rewrite in scripts/local-stack.ts' >&2; exit 1; }`,
  ]);
}

// routes.yaml is rewritten on every `up` and watched, so a running Traefik picks up changes.
function ensureTraefikContainer(state: InstanceState): void {
  const dir = instanceDir(state.instanceId);
  const edgeDir = join(dir, "edge");
  const logDir = join(dir, "logs");
  mkdirSync(edgeDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const upstream = (port: number): string =>
    `http://host.docker.internal:${port}`;
  writeFileSync(
    join(edgeDir, "routes.yaml"),
    Bun.YAML.stringify(
      renderFileConfig({
        config: upstream(ports(state).convexSite),
        core: upstream(ports(state).core),
        gateway: upstream(ports(state).gateway),
      }),
      null,
      2,
    ),
  );

  const name = traefikContainerName(state.instanceId);
  const containerState = dockerContainerState(name);
  if (containerState === "running") return;
  if (containerState) {
    docker(["start", name]);

    return;
  }

  console.log(`creating traefik container ${name}...`);
  docker([
    "run",
    "-d",
    "--name",
    name,
    "-p",
    `${ports(state).edge}:80`,
    "-v",
    `${edgeDir}:/etc/broods-edge:ro`,
    "-v",
    `${logDir}:/logs`,
    "--add-host",
    "host.docker.internal:host-gateway",
    TRAEFIK_IMAGE,
    "--entrypoints.web.address=:80",
    "--providers.file.directory=/etc/broods-edge",
    "--providers.file.watch=true",
    "--accesslog=true",
    "--accesslog.format=json",
    "--accesslog.filepath=/logs/traefik-access.log",
    "--log.filepath=/logs/traefik.log",
  ]);
}

function generateConvexAdminKey(state: InstanceState): string {
  const output = docker([
    "exec",
    containerName(state.instanceId),
    "./generate_admin_key.sh",
  ]);
  const key = output
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.includes("|"));
  if (!key) throw new Error(`could not parse admin key from:\n${output}`);

  return key;
}

function runConvexCli(
  state: InstanceState,
  args: string[],
  capture = false,
): string {
  const output = execFileSync("bunx", ["convex", ...args], {
    cwd: join(repoRoot, "packages", "convex"),
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: convexCliEnv(state),
  });

  return output ?? "";
}

function tryConvexCli(
  state: InstanceState,
  args: readonly string[],
): { ok: boolean; output: string; stdout: string; stderr: string } {
  const result = spawnSync("bunx", ["convex", ...args], {
    cwd: join(repoRoot, "packages", "convex"),
    encoding: "utf8",
    env: convexCliEnv(state),
  });

  return {
    ok: result.status === 0,
    output: result.stdout + result.stderr,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function convexCliEnv(state: InstanceState): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CONVEX_DEPLOY_KEY: undefined,
    // Empty, not unset: a cloud deployment in packages/convex/.env.local must not win.
    CONVEX_DEPLOYMENT: "",
    CONVEX_SELF_HOSTED_ADMIN_KEY: state.adminKey,
    CONVEX_SELF_HOSTED_URL: `http://127.0.0.1:${ports(state).convexApi}`,
  };
}

function isProcessAlive(pid: number | undefined): pid is number {
  if (!pid) return false;
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function processState(pid: number | undefined): string {
  return isProcessAlive(pid) ? `running (pid ${pid})` : "stopped";
}

function spawnDetached(options: {
  args: string[];
  command?: string;
  cwd: string;
  env: Record<string, string>;
  instanceId: string;
  logName: string;
}): number {
  const logDir = join(instanceDir(options.instanceId), "logs");
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, `${options.logName}.log`), "a");
  const child = spawn(options.command ?? "bun", options.args, {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, ...options.env },
  });
  child.unref();
  if (!child.pid) throw new Error(`failed to spawn ${options.logName}`);
  console.log(`${options.logName} started (pid ${child.pid})`);

  return child.pid;
}

// Mirrors apps/core `serve` plus --watch (keep in sync), which restarts only server.ts.
function startCore(state: InstanceState): void {
  if (isProcessAlive(state.pids.core)) {
    console.log("core already running");

    return;
  }

  const coreDir = join(repoRoot, "apps", "core");
  execFileSync("bun", ["run", "scripts/compaction-prompt.ts"], {
    cwd: coreDir,
    stdio: "inherit",
  });
  state.pids.core = spawnDetached({
    args: [
      ...(state.perf
        ? [
            "--preload",
            join(repoRoot, "scripts", "local-verify", "fake-model.ts"),
          ]
        : []),
      "--watch",
      "src/server.ts",
    ],
    cwd: coreDir,
    env: {
      ...(state.perf
        ? { BROODS_LOCAL_CONVEX_TRACE: convexTracePath(state.instanceId) }
        : {}),
      ACCOUNT_CONFIG_ENCRYPTION_SECRET: state.secrets.accountConfigEncryption,
      ADMIN_ACCOUNT_SECRET: state.secrets.adminAccount,
      // Pinned over the shell's: the perf fake answers only this host; a gateway would bill.
      ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1",
      CONVEX_DEPLOY_KEY: state.adminKey ?? "",
      CONVEX_URL: `http://127.0.0.1:${ports(state).convexApi}`,
      MEDIA_TICKET_SECRET: state.secrets.mediaTicket,
      PORT: String(ports(state).core),
      PUBLIC_BASE_URL: `http://127.0.0.1:${ports(state).edge}`,
      SERVICE_AUTH_SECRET: state.secrets.serviceAuth,
      SERVICE_NAME: `local-${state.instanceId}-core`,
      STAGE_TICKET_SECRET: state.secrets.stageTicket,
      TERMINAL_TICKET_SECRET: state.secrets.terminalTicket,
    },
    instanceId: state.instanceId,
    logName: "core",
  });
}

// Mirrors apps/dashboard `dev` (run by node); this env wins over .env.local.
async function startDashboard(state: InstanceState): Promise<void> {
  const url = dashboardUrl(state);
  if (isProcessAlive(state.pids.dashboard)) {
    console.log("dashboard already running");

    return;
  }
  if ((await probeHttp(`${url}/healthz`)) !== null) {
    throw new Error(
      `${url} is already serving another app; stop it and run up again`,
    );
  }

  const edgeUrl = `http://127.0.0.1:${ports(state).edge}`;
  state.pids.dashboard = spawnDetached({
    args: [
      join(dashboardDir, "node_modules", ".bin", "next"),
      "dev",
      "--port",
      String(ports(state).dashboard),
    ],
    command: "node",
    cwd: dashboardDir,
    // Empty WORKOS_* so the stack proves sign-in works without WorkOS.
    env: {
      ADMIN_ACCOUNT_SECRET: state.secrets.adminAccount,
      BROODS_BASE_URL: edgeUrl,
      BROODS_SESSION_SIGNING_KEY: state.secrets.sessionSigningKey,
      NEXT_PUBLIC_BROODS_BASE_URL: edgeUrl,
      NEXT_PUBLIC_CONVEX_URL: `http://127.0.0.1:${ports(state).convexApi}`,
      WORKOS_API_KEY: "",
      WORKOS_CLIENT_ID: "",
      WORKOS_COOKIE_PASSWORD: "",
    },
    instanceId: state.instanceId,
    logName: "dashboard",
  });
}

// Mirrors apps/gateway `dev` (keep in sync); no `bun run`, so the pid is the server's.
function startGateway(state: InstanceState): void {
  if (isProcessAlive(state.pids.gateway)) {
    console.log("gateway already running");

    return;
  }

  state.pids.gateway = spawnDetached({
    args: ["--watch", "src/main.ts"],
    cwd: join(repoRoot, "apps", "gateway"),
    env: {
      BROODS_CORE_URL: `http://127.0.0.1:${ports(state).core}`,
      PORT: String(ports(state).gateway),
      TERMINAL_TICKET_SECRET: state.secrets.terminalTicket,
    },
    instanceId: state.instanceId,
    logName: "gateway",
  });
}

// Waits for the exit so the next `up` never races a dying process for its port.
async function stopProcess(
  pid: number | undefined,
  name: string,
): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const exited = await pollUntil(
    { initialIntervalMs: 50, maxIntervalMs: 100, timeoutMs: 5_000 },
    async () => (isProcessAlive(pid) ? null : true),
  );
  if (exited) {
    console.log(`stopped ${name} (pid ${pid})`);

    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  const reaped = await pollUntil(
    { initialIntervalMs: 20, maxIntervalMs: 50, timeoutMs: 300 },
    async () => (isProcessAlive(pid) ? null : true),
  );
  if (!reaped) {
    throw new Error(`${name} (pid ${pid}) survived SIGKILL`);
  }
  console.log(`stopped ${name} (pid ${pid}, forced)`);
}

function containerMemory(name: string): string | null {
  const output = docker(
    ["stats", "--no-stream", "--format", "{{.MemUsage}}", name],
    { allowFailure: true },
  ).trim();

  return output || null;
}

function containerName(instanceId: string): string {
  return `broods-convex-${instanceId}`;
}

function traefikContainerName(instanceId: string): string {
  return `broods-traefik-${instanceId}`;
}

function dataVolumeName(instanceId: string): string {
  return `${containerName(instanceId)}-data`;
}

function docker(
  args: string[],
  options: { allowFailure?: boolean } = {},
): string {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", options.allowFailure ? "ignore" : "inherit"],
    });
  } catch (error) {
    if (options.allowFailure) return "";
    throw error;
  }
}

function dockerContainerState(name: string): string | null {
  const output = docker(["inspect", "--format", "{{.State.Status}}", name], {
    allowFailure: true,
  }).trim();

  return output || null;
}

function pullImage(image: string): Promise<void> {
  if (docker(["image", "inspect", image], { allowFailure: true })) {
    return Promise.resolve();
  }

  return new Promise((resolvePull, rejectPull): void => {
    const child = spawn("docker", ["pull", "--quiet", image], {
      stdio: "ignore",
    });
    child.on("error", rejectPull);
    child.on("exit", (code): void => {
      if (code === 0) resolvePull();
      else rejectPull(new Error(`docker pull ${image} exited with ${code}`));
    });
  });
}

async function createAccount(
  edgeUrl: string,
  adminSecret: string,
  username: string,
): Promise<string> {
  const response = await fetch(`${edgeUrl}/v1/accounts`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${adminSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username: username }),
  });
  const body = (await response.json()) as { error?: string; secret?: string };
  assertStep(
    "create account (core, admin bearer)",
    response.status === 201 && typeof body.secret === "string",
    `status ${response.status}: ${body.error ?? "no account key in response"}`,
  );

  return body.secret;
}

function verifyContext(
  state: InstanceState,
  accountSecret: string,
  runId: string,
  measure: VerifyContext["measure"],
): VerifyContext {
  const edgeUrl = `http://127.0.0.1:${ports(state).edge}`;

  return {
    ...smokeModel(),
    account: new BroodsAccountClient({
      accountSecret: accountSecret,
      baseUrl: edgeUrl,
    }),
    accountSecret: accountSecret,
    client: new BroodsClient({ apiKey: accountSecret, baseUrl: edgeUrl }),
    configPlaneUrl: `http://127.0.0.1:${ports(state).convexSite}`,
    convex: (args) => tryConvexCli(state, args),
    coreLogPath: join(instanceDir(state.instanceId), "logs", "core.log"),
    edgeUrl: edgeUrl,
    measure: measure,
    runId: runId,
    serviceSecret: state.secrets.serviceAuth,
    stageTicketSecret: state.secrets.stageTicket,
  };
}

async function waitForHttp(
  url: string,
  what: string,
  expectedStatus?: number,
): Promise<void> {
  const ready = await pollUntil(
    {
      initialIntervalMs: 100,
      maxIntervalMs: 500,
      timeoutMs: HEALTH_TIMEOUT_MS,
    },
    async () => {
      const statusCode = await probeHttp(url);
      const ok =
        expectedStatus === undefined
          ? statusCode !== null && statusCode < 400
          : statusCode === expectedStatus;

      return ok ? statusCode : null;
    },
  );
  if (ready === null) {
    throw new Error(
      `${what} did not become ready within ${HEALTH_TIMEOUT_MS}ms (${url})`,
    );
  }
  console.log(`${what} ready`);
}

function lastPerfSummaries(instanceId: string): string[] {
  const path = perfLogPath(instanceId);

  return ["up", "verify"].flatMap((command) => {
    const record = lastJsonLine<PerfRecord>(
      path,
      (candidate) => candidate.command === command,
    );

    return record
      ? [
          `last ${command} ${(record.totalMs / 1000).toFixed(1)}s (${record.at})`,
        ]
      : [];
  });
}

async function measureStep<T>(
  perf: PerfStep[],
  step: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    perf.push({ ms: Date.now() - start, step: step });
  }
}

function convexTracePath(instanceId: string): string {
  return join(instanceDir(instanceId), "convex-calls.jsonl");
}

function perfLogPath(instanceId: string): string {
  return join(instanceDir(instanceId), "perf.jsonl");
}

function printPerfBreakdown(perf: PerfStep[], totalMs: number): void {
  console.log("\ntiming:");
  for (const entry of perf) {
    console.log(
      `  ${(entry.ms / 1000).toFixed(2).padStart(7)}s  ${entry.step}`,
    );
  }
  console.log(`  ${(totalMs / 1000).toFixed(2).padStart(7)}s  total`);
}

function processRssMb(pids: (number | undefined)[]): Map<number, number> {
  const alive = pids.filter((pid) => isProcessAlive(pid));
  const rss = new Map<number, number>();
  if (alive.length === 0) return rss;
  try {
    const output = execFileSync(
      "ps",
      ["-o", "pid=,rss=", "-p", alive.join(",")],
      { encoding: "utf8" },
    );
    for (const line of output.trim().split("\n")) {
      const [pid, kb] = line.trim().split(/\s+/);
      if (pid && kb) rss.set(Number(pid), Math.round(Number(kb) / 1024));
    }
  } catch {}

  return rss;
}

function recordPerf(
  instanceId: string,
  command: string,
  steps: PerfStep[],
  totalMs: number,
  failed?: string,
): void {
  const record: PerfRecord = {
    at: new Date().toISOString(),
    command: command,
    failed: failed,
    steps: steps,
    totalMs: totalMs,
  };
  mkdirSync(instanceDir(instanceId), { recursive: true });
  writeFileSync(perfLogPath(instanceId), `${JSON.stringify(record)}\n`, {
    flag: "a",
  });

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const rows = steps.map(
    (entry) => `| ${entry.step} | ${(entry.ms / 1000).toFixed(2)}s |`,
  );
  const verdict = failed ? `failed at ${failed}` : "passed";
  writeFileSync(
    summaryPath,
    [
      `### local-stack ${command}: ${verdict} in ${(totalMs / 1000).toFixed(1)}s`,
      "",
      "| step | time |",
      "| --- | --- |",
      ...rows,
      "",
    ].join("\n"),
    { flag: "a" },
  );
}

function allocatePortBase(): number {
  const used = new Set<number>();
  if (existsSync(STATE_ROOT)) {
    for (const entry of readdirSync(STATE_ROOT)) {
      const other = loadState(entry);
      if (other) used.add(other.portBase);
    }
  }
  for (let index = 0; index < 50; index += 1) {
    const base = PORT_BLOCK_BASE + index * PORT_BLOCK_SIZE;
    if (!used.has(base)) return base;
  }
  throw new Error("no free port block under ~/.broods-local");
}

function currentInstanceId(): string {
  const digest = createHash("sha1").update(repoRoot).digest("hex").slice(0, 8);
  const basename = repoRoot.split("/").findLast(Boolean) ?? "broods";

  return `${basename}-${digest}`;
}

function dashboardUrl(state: InstanceState): string {
  return `http://localhost:${ports(state).dashboard}`;
}

function instanceDir(instanceId: string): string {
  return join(STATE_ROOT, instanceId);
}

function loadOrCreateState(): InstanceState {
  const instanceId = currentInstanceId();
  const existing = loadState(instanceId);
  if (existing && !existing.secrets.stageTicket) {
    throw new Error(
      "this stack predates the per-purpose secrets; run `up --fresh` to recreate it",
    );
  }
  if (existing && existing.portBase === undefined) {
    throw new Error(
      "this stack predates the Traefik edge; run `bun run local:up -- --fresh` to recreate it",
    );
  }
  if (existing && !existing.secrets.sessionSigningKey) {
    throw new Error(
      "this stack predates the self-hosted sign-in; run `bun run local:up -- --fresh` to recreate it",
    );
  }
  if (existing) return existing;

  const state: InstanceState = {
    instanceId: instanceId,
    instanceSecret: randomBytes(32).toString("hex"),
    pids: {},
    portBase: allocatePortBase(),
    secrets: {
      accountConfigEncryption: randomBytes(24).toString("hex"),
      adminAccount: `local_admin_${randomBytes(18).toString("hex")}`,
      mediaTicket: randomBytes(24).toString("hex"),
      serviceAuth: randomBytes(24).toString("hex"),
      sessionSigningKey: newSessionSigningKey(),
      stageTicket: randomBytes(24).toString("hex"),
      terminalTicket: randomBytes(24).toString("hex"),
    },
  };
  saveState(state);

  return state;
}

function loadState(instanceId: string): InstanceState | null {
  const path = join(instanceDir(instanceId), "state.json");
  if (!existsSync(path)) return null;

  return JSON.parse(readFileSync(path, "utf8")) as InstanceState;
}

function newSessionSigningKey(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

  return JSON.stringify({
    ...privateKey.export({ format: "jwk" }),
    alg: SELF_HOST_ALGORITHM,
    kid: SELF_HOST_KEY_ID,
    use: "sig",
  });
}

function ports(state: InstanceState): InstancePorts {
  const base = state.portBase;

  return {
    convexApi: base + 2,
    convexSite: base + 3,
    core: base + 1,
    dashboard: base + 5,
    edge: base,
    gateway: base + 4,
  };
}

// Owner-only: state.json holds the admin and encryption secrets.
function saveState(state: InstanceState): void {
  const dir = instanceDir(state.instanceId);
  const path = join(dir, "state.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}
