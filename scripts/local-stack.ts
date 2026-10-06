/**
 * Local Broods stack: self-hosted Convex and Traefik in docker, core and the
 * gateway as watched bun processes. Traefik is the front door, as in the
 * cluster: it routes the public port to core, the Convex config plane or the
 * gateway's sockets from the apps/edge route table. Instances are keyed by
 * worktree, so parallel checkouts get isolated stacks on disjoint port blocks.
 * State (secrets, ports, pids, logs, perf) lives under ~/.broods-local/<instance>/.
 *
 * A warm `up` is idempotent: the containers restart in place and the script
 * skips `convex deploy` while packages/convex is unchanged.
 *
 * `verify` drives the cases in scripts/local-verify/cases through the edge.
 * `up --perf` answers the model in process and traces core's Convex calls, and
 * `perf` then grades scripts/local-verify/perf.ts against its baseline.
 * Under GitHub Actions each command also writes its timings to the job summary.
 *
 * Usage: bun scripts/local-stack.ts <up|down|status|verify|perf> [--fresh|--purge|--perf|--record]
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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

// Pinned so CI and every laptop run the same backend. To bump, pull
// convex-backend:latest and copy its RepoDigests entry here.
const CONVEX_IMAGE =
  process.env.BROODS_LOCAL_CONVEX_IMAGE ??
  "ghcr.io/get-convex/convex-backend@sha256:b756b06641d15a55b5ec0692897ce5ad3715ddccfd02e1e213621e9e764255c8";
// The version the cluster runs.
const TRAEFIK_IMAGE = "traefik:v3.7.12";
const HEALTH_TIMEOUT_MS = 60_000;
const PORT_BLOCK_BASE = 4300;
const PORT_BLOCK_SIZE = 10;
const STATE_ROOT = join(homedir(), ".broods-local");
/** Every port of an instance, at a fixed offset from its block base. */
interface InstancePorts {
  convexApi: number;
  convexSite: number;
  core: number;
  /** The public port: Traefik, in front of everything else. */
  edge: number;
  /** The WebSocket gateway process, behind Traefik. */
  gateway: number;
}

interface InstanceSecrets {
  accountConfigEncryption: string;
  adminAccount: string;
  mediaTicket: string;
  serviceAuth: string;
  stageTicket: string;
  terminalTicket: string;
}

interface InstanceState {
  adminKey?: string;
  convexSourceHash?: string;
  deploymentEnvConfigured?: boolean;
  instanceId: string;
  instanceSecret: string;
  perf?: boolean;
  pids: { core?: number; gateway?: number };
  /** First port of the instance's block; `ports()` derives the rest. */
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
const command = process.argv[2];
const flags = new Set(process.argv.slice(3));

switch (command) {
  case "up":
    await up(flags.has("--fresh"), flags.has("--perf"));
    break;
  case "down":
    await down(flags.has("--purge"));
    break;
  case "status":
    await status();
    break;
  case "verify":
    await verify();
    break;
  case "perf":
    await perf(flags.has("--record"));
    break;
  default:
    console.error(
      "Usage: bun scripts/local-stack.ts <up|down|status|verify|perf> [--fresh|--purge|--perf|--record]",
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

async function status(): Promise<void> {
  const instanceId = currentInstanceId();
  const state = loadState(instanceId);
  if (!state) {
    console.log(`no local stack for this worktree (${instanceId})`);

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

async function up(fresh: boolean, perfMode: boolean): Promise<void> {
  const startedAt = Date.now();
  const perf: PerfStep[] = [];
  if (fresh) {
    await down(true);
  }
  const state = loadOrCreateState();
  // Traefik needs nothing from the other steps, so a first pull of its image
  // runs alongside them.
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

  if (!state.deploymentEnvConfigured) {
    await measureStep(perf, "deployment env", () => {
      configureDeploymentEnv(state);
      state.deploymentEnvConfigured = true;
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
    // A 401 can only come from the config plane: Traefik answers 404 until it
    // loads the routes and 502 while an upstream is down.
    await Promise.all([
      waitForHttp(`${edgeUrl}/healthz`, "gateway via edge"),
      waitForHttp(`http://127.0.0.1:${ports(state).core}/healthz`, "core"),
      waitForHttp(`${edgeUrl}/v1/agents`, "config plane via edge", 401),
    ]);
  });

  const totalMs = Date.now() - startedAt;
  recordPerf(state.instanceId, "up", perf, totalMs);
  printPerfBreakdown(perf, totalMs);
  console.log(`\nstack up in ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  edge      ${edgeUrl}`);
  console.log(
    `  admin     read secrets.adminAccount in ${join(instanceDir(state.instanceId), "state.json")}`,
  );
  console.log(`  logs      ${join(instanceDir(state.instanceId), "logs")}`);
  console.log(
    `  perf      ${join(instanceDir(state.instanceId), "perf.jsonl")}`,
  );
  console.log(
    `\nnext: bun scripts/local-stack.ts ${perfMode ? "perf" : "verify"}`,
  );
}

/**
 * Perf report: needs core started by `up --perf`. Exits 1 when a scenario
 * makes more Convex calls than perf-baseline.json allows; `--record` rewrites
 * that file from this run instead.
 */
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

/**
 * End-to-end check: verify admin account creation, then run every case
 * through the gateway using an org-backed local fixture. Without
 * DEEPSEEK_API_KEY runs fail at the provider call; reaching that failure still
 * proves routing, auth, config encrypt/decrypt, and Convex round-trips.
 */
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

// --- convex backend -----------------------------------------------------

// AuthKit validates WORKOS_* at import time, so dummies must exist before the
// first deploy. BROODS_ACCOUNT_MANAGE_URL points at core on the host (the
// backend runs inside docker). One batched `env set` beats a CLI boot per var.
function configureDeploymentEnv(state: InstanceState): void {
  const entries: Record<string, string> = {
    ACCOUNT_CONFIG_ENCRYPTION_SECRET: state.secrets.accountConfigEncryption,
    ADMIN_ACCOUNT_SECRET: state.secrets.adminAccount,
    BROODS_ACCOUNT_MANAGE_URL: `http://host.docker.internal:${ports(state).core}`,
    SERVICE_AUTH_SECRET: state.secrets.serviceAuth,
    STAGE_TICKET_SECRET: state.secrets.stageTicket,
    WORKOS_API_KEY: "sk_local_dummy",
    WORKOS_CLIENT_ID: "client_local_dummy",
    WORKOS_WEBHOOK_SECRET: "whsec_local_dummy",
  };
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

/** Creates a local org-backed fixture; admin API accounts have synthetic org bindings. */
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
  const secret = `fp_${randomBytes(32).toString("base64url")}`;
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

// Maps host.docker.internal so Convex reaches core on Linux; Docker Desktop
// resolves it on its own.
function ensureConvexContainer(state: InstanceState): void {
  const name = containerName(state.instanceId);
  const containerState = dockerContainerState(name);
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
    `${ports(state).convexApi}:3210`,
    "-p",
    `${ports(state).convexSite}:3211`,
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
    CONVEX_IMAGE,
  ]);
}

/**
 * Traefik on the public port, routing from the apps/edge table as the cluster
 * does. The routes file is rewritten on every `up` and watched, so a route
 * table change reaches a running container. Logs land next to core's.
 */
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

// CONVEX_DEPLOYMENT is empty, not unset, so a cloud deployment a `convex dev`
// login left in packages/convex/.env.local cannot win over the self-hosted one.
function runConvexCli(
  state: InstanceState,
  args: string[],
  capture = false,
): string {
  const output = execFileSync("bunx", ["convex", ...args], {
    cwd: join(repoRoot, "packages", "convex"),
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: {
      ...process.env,
      CONVEX_DEPLOY_KEY: undefined,
      CONVEX_DEPLOYMENT: "",
      CONVEX_SELF_HOSTED_ADMIN_KEY: state.adminKey,
      CONVEX_SELF_HOSTED_URL: `http://127.0.0.1:${ports(state).convexApi}`,
    },
  });

  return output ?? "";
}

// --- host processes -----------------------------------------------------

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
  cwd: string;
  env: Record<string, string>;
  instanceId: string;
  logName: string;
}): number {
  const logDir = join(instanceDir(options.instanceId), "logs");
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, `${options.logName}.log`), "a");
  const child = spawn("bun", options.args, {
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

// Mirrors apps/core "serve" with --watch added; keep in sync with that package
// script. The compaction prompt runs once here because watch mode restarts
// only server.ts.
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

// Mirrors apps/gateway "dev"; keep in sync with that package script. Spawned
// directly (not via `bun run`) so the recorded pid is the server itself.
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

// SIGTERM then wait for the exit so a follow-up `up` never races a dying
// process for its port; SIGKILL after the grace period.
async function stopProcess(
  pid: number | undefined,
  name: string,
): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
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
  } catch {
    // already exited
  }
  const reaped = await pollUntil(
    { initialIntervalMs: 20, maxIntervalMs: 50, timeoutMs: 300 },
    async () => (isProcessAlive(pid) ? null : true),
  );
  if (!reaped) {
    throw new Error(`${name} (pid ${pid}) survived SIGKILL`);
  }
  console.log(`stopped ${name} (pid ${pid}, forced)`);
}

// --- docker -------------------------------------------------------------

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
    // An allowed failure, like inspecting a container not yet created, stays quiet.
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

/** Pulls an image in the background unless it is already local; resolves once present. */
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

// --- http ---------------------------------------------------------------

// Mints a verify account with the admin secret and returns its secret.
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

// The clients and paths a verify case or perf run gets for one account.
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
    coreLogPath: join(instanceDir(state.instanceId), "logs", "core.log"),
    edgeUrl: edgeUrl,
    measure: measure,
    runId: runId,
    serviceSecret: state.secrets.serviceAuth,
  };
}

// Ready on any status below 400, or on exactly `expectedStatus` when given.
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

// --- perf recording -----------------------------------------------------

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

// Times fn into perf, failed steps included.
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
  } catch {
    // a pid that died mid-call just drops out of the map
  }

  return rss;
}

// Appends to perf.jsonl, and under GitHub Actions adds a timing table to the
// job summary so a pull request shows what each step cost.
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

// --- instance state -----------------------------------------------------

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
  const basename = repoRoot.split("/").filter(Boolean).pop() ?? "broods";

  return `${basename}-${digest}`;
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

function ports(state: InstanceState): InstancePorts {
  const base = state.portBase;

  return {
    convexApi: base + 2,
    convexSite: base + 3,
    core: base + 1,
    edge: base,
    gateway: base + 4,
  };
}

// state.json carries the admin and encryption secrets, so the instance dir is
// owner-only. chmod repairs paths created before the modes were enforced.
function saveState(state: InstanceState): void {
  const dir = instanceDir(state.instanceId);
  const path = join(dir, "state.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}
