/**
 * Local Broods stack: self-hosted Convex in docker plus core and gateway as
 * watched bun processes. Instances are keyed by worktree, so parallel
 * checkouts get isolated stacks on disjoint port blocks. State (secrets,
 * ports, pids, logs, perf) lives under ~/.broods-local/<instance>/.
 *
 * A warm `up` is idempotent: the container restarts in place and the script
 * skips `convex deploy` while packages/convex is unchanged.
 *
 * `verify` drives the cases in scripts/local-verify/cases through the gateway.
 * Under GitHub Actions each command also writes its timings to the job summary.
 *
 * Usage: bun scripts/local-stack.ts <up|down|status|verify> [--fresh|--purge]
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

import { verifyCases } from "./local-verify/cases/index.ts";
import {
  VerifyFailure,
  assertStep,
  httpJson,
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
const HEALTH_TIMEOUT_MS = 60_000;
const PORT_BLOCK_BASE = 4300;
const PORT_BLOCK_SIZE = 10;
const STATE_ROOT = join(homedir(), ".broods-local");
interface InstancePorts {
  convexApi: number;
  convexSite: number;
  core: number;
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
  pids: { core?: number; gateway?: number };
  ports: InstancePorts;
  secrets: InstanceSecrets;
}

interface PerfRecord {
  at: string;
  command: string;
  /** The step that failed; absent on a pass. */
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
    await up(flags.has("--fresh"));
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
  default:
    console.error(
      "Usage: bun scripts/local-stack.ts <up|down|status|verify> [--fresh|--purge]",
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
    docker(["volume", "rm", dataVolumeName(instanceId)], {
      allowFailure: true,
    });
    rmSync(instanceDir(instanceId), { recursive: true, force: true });
    console.log(`purged ${instanceId} (container, volume, state)`);

    return;
  }

  docker(["stop", container], { allowFailure: true });
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
    `core      ${processState(state.pids.core)} (:${state.ports.core})`,
  );
  console.log(
    `gateway   ${processState(state.pids.gateway)} (:${state.ports.gateway})`,
  );

  const health = await probeHttp(
    `http://127.0.0.1:${state.ports.gateway}/healthz`,
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

async function up(fresh: boolean): Promise<void> {
  const startedAt = Date.now();
  const perf: PerfStep[] = [];
  if (fresh) {
    await down(true);
  }
  const state = loadOrCreateState();
  console.log(
    `[${state.instanceId}] gateway :${state.ports.gateway} core :${state.ports.core} convex :${state.ports.convexApi}/${state.ports.convexSite}`,
  );

  await measureStep(perf, "convex container", async () => {
    ensureConvexContainer(state);
    await waitForHttp(
      `http://127.0.0.1:${state.ports.convexApi}/version`,
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

  await measureStep(perf, "start core + gateway", () => {
    startCore(state);
    startGateway(state);
    saveState(state);
  });

  const gatewayUrl = `http://127.0.0.1:${state.ports.gateway}`;
  await measureStep(perf, "health checks", async () => {
    await Promise.all([
      waitForHttp(`${gatewayUrl}/healthz`, "gateway"),
      waitForHttp(`http://127.0.0.1:${state.ports.core}/healthz`, "core"),
    ]);
    // The gateway answers /healthz itself; any status from /v1/agents (401
    // expected) proves the proxied gateway -> convex chain.
    await waitForHttp(
      `${gatewayUrl}/v1/agents`,
      "config plane via gateway",
      true,
    );
  });

  const totalMs = Date.now() - startedAt;
  recordPerf(state.instanceId, "up", perf, totalMs);
  printPerfBreakdown(perf, totalMs);
  console.log(`\nstack up in ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  gateway   ${gatewayUrl}`);
  console.log(`  admin     Bearer ${state.secrets.adminAccount}`);
  console.log(`  logs      ${join(instanceDir(state.instanceId), "logs")}`);
  console.log(
    `  perf      ${join(instanceDir(state.instanceId), "perf.jsonl")}`,
  );
  console.log(`\nnext: bun scripts/local-stack.ts verify`);
}

/**
 * End-to-end check: mint an account with the admin secret, then run every
 * case in scripts/local-verify/cases against it through the gateway. Without
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
  const gatewayUrl = `http://127.0.0.1:${state.ports.gateway}`;
  const measure = <T>(step: string, fn: () => Promise<T>): Promise<T> =>
    measureStep(perf, step, fn);
  let failed: VerifyFailure | undefined;
  try {
    await measure("gateway healthz", async () => {
      const health = await probeHttp(`${gatewayUrl}/healthz`);
      assertStep("gateway healthz", health === 200, `status ${health}`);
    });
    const runId = Date.now().toString(36);
    const accountSecret = await measure("create account", async () => {
      const response = await httpJson(`${gatewayUrl}/v1/accounts`, {
        method: "POST",
        token: state.secrets.adminAccount,
        body: { username: `smoke-${runId}` },
      });
      const secret = (response.body as { secret?: string }).secret;
      assertStep(
        "create account (core, admin bearer)",
        response.status === 201 && typeof secret === "string",
        `status ${response.status}: ${JSON.stringify(response.body)}`,
      );

      return secret;
    });
    const context: VerifyContext = {
      ...smokeModel(),
      accountSecret: accountSecret,
      coreLogPath: join(instanceDir(state.instanceId), "logs", "core.log"),
      gatewayUrl: gatewayUrl,
      measure: measure,
      runId: runId,
    };
    for (const verifyCase of verifyCases) {
      console.log(`\n${verifyCase.name}`);
      await verifyCase.run(context);
    }
  } catch (error) {
    // A thrown SDK or fetch error fails the run the same way a check does.
    failed =
      error instanceof VerifyFailure
        ? error
        : new VerifyFailure(
            "unexpected error",
            error instanceof Error ? error.message : String(error),
          );
    console.error(`  FAIL ${failed.step}\n       ${failed.detail}`);
  }

  const totalMs = Date.now() - startedAt;
  recordPerf(state.instanceId, "verify", perf, totalMs, failed?.step);
  printPerfBreakdown(perf, totalMs);
  if (failed) process.exit(1);
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
    BROODS_ACCOUNT_MANAGE_URL: `http://host.docker.internal:${state.ports.core}`,
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
    `${state.ports.convexApi}:3210`,
    "-p",
    `${state.ports.convexSite}:3211`,
    "-v",
    `${dataVolumeName(state.instanceId)}:/convex/data`,
    // Convex calls core on the host. Docker Desktop resolves this name on its
    // own, Linux (CI) only with this mapping.
    "--add-host",
    "host.docker.internal:host-gateway",
    "-e",
    `INSTANCE_NAME=${state.instanceId}`,
    "-e",
    `INSTANCE_SECRET=${state.instanceSecret}`,
    "-e",
    `CONVEX_CLOUD_ORIGIN=http://127.0.0.1:${state.ports.convexApi}`,
    "-e",
    `CONVEX_SITE_ORIGIN=http://127.0.0.1:${state.ports.convexSite}`,
    "-e",
    "DISABLE_BEACON=true",
    "-e",
    "DO_NOT_REQUIRE_SSL=true",
    CONVEX_IMAGE,
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

function runConvexCli(state: InstanceState, args: string[]): void {
  execFileSync("bunx", ["convex", ...args], {
    cwd: join(repoRoot, "packages", "convex"),
    encoding: "utf8",
    stdio: "inherit",
    env: {
      ...process.env,
      CONVEX_DEPLOY_KEY: undefined,
      // Empty, not unset: the CLI loads packages/convex/.env.local, and a
      // `convex dev` login leaves a cloud CONVEX_DEPLOYMENT there.
      CONVEX_DEPLOYMENT: "",
      CONVEX_SELF_HOSTED_ADMIN_KEY: state.adminKey,
      CONVEX_SELF_HOSTED_URL: `http://127.0.0.1:${state.ports.convexApi}`,
    },
  });
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
    args: ["--watch", "src/server.ts"],
    cwd: coreDir,
    env: {
      ACCOUNT_CONFIG_ENCRYPTION_SECRET: state.secrets.accountConfigEncryption,
      ADMIN_ACCOUNT_SECRET: state.secrets.adminAccount,
      CONVEX_DEPLOY_KEY: state.adminKey ?? "",
      CONVEX_URL: `http://127.0.0.1:${state.ports.convexApi}`,
      MEDIA_TICKET_SECRET: state.secrets.mediaTicket,
      PORT: String(state.ports.core),
      PUBLIC_BASE_URL: `http://127.0.0.1:${state.ports.gateway}`,
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
      BROODS_CONFIG_URL: `http://127.0.0.1:${state.ports.convexSite}`,
      BROODS_CORE_URLS: `http://127.0.0.1:${state.ports.core}`,
      PORT: String(state.ports.gateway),
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

function dataVolumeName(instanceId: string): string {
  return `${containerName(instanceId)}-data`;
}

function docker(
  args: string[],
  options: { allowFailure?: boolean } = {},
): string {
  try {
    return execFileSync("docker", args, { encoding: "utf8" });
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

// --- http ---------------------------------------------------------------

async function waitForHttp(
  url: string,
  what: string,
  acceptAnyStatus = false,
): Promise<void> {
  const ready = await pollUntil(
    {
      initialIntervalMs: 100,
      maxIntervalMs: 500,
      timeoutMs: HEALTH_TIMEOUT_MS,
    },
    async () => {
      const statusCode = await probeHttp(url);

      return statusCode !== null && (acceptAnyStatus || statusCode < 400)
        ? statusCode
        : null;
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

async function measureStep<T>(
  perf: PerfStep[],
  step: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const start = Date.now();
  // finally, so a failed step still shows what it cost.
  try {
    return await fn();
  } finally {
    perf.push({ ms: Date.now() - start, step: step });
  }
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

function allocatePortBlock(): InstancePorts {
  const used = new Set<number>();
  if (existsSync(STATE_ROOT)) {
    for (const entry of readdirSync(STATE_ROOT)) {
      const other = loadState(entry);
      if (other) used.add(other.ports.gateway);
    }
  }
  for (let index = 0; index < 50; index += 1) {
    const base = PORT_BLOCK_BASE + index * PORT_BLOCK_SIZE;
    if (used.has(base)) continue;

    return {
      convexApi: base + 2,
      convexSite: base + 3,
      core: base + 1,
      gateway: base,
    };
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
  if (existing) return existing;

  const state: InstanceState = {
    instanceId: instanceId,
    instanceSecret: randomBytes(32).toString("hex"),
    pids: {},
    ports: allocatePortBlock(),
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
