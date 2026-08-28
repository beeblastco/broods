/**
 * Local stack orchestrator. Spins up the whole Broods runtime on this machine:
 * a self-hosted Convex backend in docker, core and gateway as watched bun
 * processes, and a smoke verification that exercises the chain end to end.
 *
 * Instances are keyed by the repo checkout (worktree) that runs the command, so
 * parallel worktrees get isolated stacks on disjoint port blocks. State lives
 * under ~/.broods-local/<instance>/ — secrets, ports, pids, logs. A warm re-run
 * of `up` is idempotent and fast: the container restarts instead of recreating,
 * and `convex deploy` is skipped while packages/convex is unchanged.
 *
 * Usage:
 *   bun scripts/local-stack.ts up [--fresh]
 *   bun scripts/local-stack.ts down [--purge]
 *   bun scripts/local-stack.ts status
 *   bun scripts/local-stack.ts verify
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

const CONVEX_IMAGE =
  process.env.BROODS_LOCAL_CONVEX_IMAGE ??
  "ghcr.io/get-convex/convex-backend:latest";
const HEALTH_TIMEOUT_MS = 60_000;
const PORT_BLOCK_BASE = 4300;
const PORT_BLOCK_SIZE = 10;
const RUN_POLL_TIMEOUT_MS = 120_000;
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
  serviceAuth: string;
}

interface PerfRecord {
  at: string;
  command: string;
  steps: PerfStep[];
  totalMs: number;
}

interface PerfStep {
  ms: number;
  step: string;
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
  worktreeRoot: string;
}

const repoRoot = resolve(import.meta.dir, "..");
const command = process.argv[2];
const flags = new Set(process.argv.slice(3));

switch (command) {
  case "up":
    await up({ fresh: flags.has("--fresh") });
    break;
  case "down":
    await down({ purge: flags.has("--purge") });
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

async function up(options: { fresh: boolean }): Promise<void> {
  const startedAt = Date.now();
  const perf: PerfStep[] = [];
  if (options.fresh) {
    await down({ purge: true });
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
    await measureStep(perf, "admin key", async () => {
      state.adminKey = generateConvexAdminKey(state);
      saveState(state);
    });
  }

  if (!state.deploymentEnvConfigured) {
    await measureStep(perf, "deployment env", async () => {
      configureDeploymentEnv(state);
      state.deploymentEnvConfigured = true;
      saveState(state);
    });
  }

  const sourceHash = await measureStep(perf, "convex source hash", async () =>
    convexSourceHash(),
  );
  if (state.convexSourceHash !== sourceHash) {
    console.log("deploying convex functions (packages/convex changed)...");
    await measureStep(perf, "convex deploy", async () => {
      runConvexCli(state, ["deploy", "-y"]);
      state.convexSourceHash = sourceHash;
      saveState(state);
    });
  } else {
    console.log("convex functions unchanged, skipping deploy");
  }

  await measureStep(perf, "start core + gateway", async () => {
    startCore(state);
    startGateway(state);
    saveState(state);
  });

  const gatewayUrl = `http://127.0.0.1:${state.ports.gateway}`;
  await measureStep(perf, "health checks", async () => {
    await waitForHttp(`${gatewayUrl}/healthz`, "gateway");
    await waitForHttp(`http://127.0.0.1:${state.ports.core}/healthz`, "core");
    // The gateway answers /healthz itself, so prove the proxied chain too: any
    // HTTP status from /v1/agents means gateway -> convex round-tripped (401 is
    // the expected unauthenticated answer); only a network error is a failure.
    await waitForHttp(`${gatewayUrl}/v1/agents`, "config plane via gateway", {
      acceptAnyStatus: true,
    });
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

async function down(options: { purge: boolean }): Promise<void> {
  const instanceId = currentInstanceId();
  const state = loadState(instanceId);
  if (!state) {
    console.log(`no state for ${instanceId}, nothing to stop`);

    return;
  }

  await stopProcess(state.pids.gateway, "gateway");
  await stopProcess(state.pids.core, "core");
  state.pids = {};
  saveState(state);

  const container = containerName(instanceId);
  if (options.purge) {
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

  const coreRss = processRssMb(state.pids.core);
  const gatewayRss = processRssMb(state.pids.gateway);
  if (coreRss || gatewayRss) {
    console.log(
      `memory    core ${coreRss ?? "?"} MB, gateway ${gatewayRss ?? "?"} MB, convex ${containerMemory(containerName(instanceId)) ?? "?"}`,
    );
  }

  for (const line of lastPerfSummaries(instanceId)) {
    console.log(`perf      ${line}`);
  }
}

/**
 * End-to-end smoke: mint an account with the admin secret, create an agent,
 * fire an async run through the gateway, poll its status. Without a model key
 * the run is expected to fail at the provider call — reaching that failure
 * still proves routing, auth, config encrypt/decrypt, and Convex round-trips.
 */
async function verify(): Promise<void> {
  const state = loadState(currentInstanceId());
  if (!state) {
    console.error("no local stack for this worktree — run `up` first");
    process.exit(1);
  }

  const startedAt = Date.now();
  const perf: PerfStep[] = [];
  const gatewayUrl = `http://127.0.0.1:${state.ports.gateway}`;
  const runId = Date.now().toString(36);
  const modelKey = process.env.ANTHROPIC_API_KEY;

  await measureStep(perf, "gateway healthz", async () => {
    const health = await probeHttp(`${gatewayUrl}/healthz`);
    assertStep("gateway healthz", health === 200, `status ${health}`);
  });

  const accountSecret = await measureStep(perf, "create account", async () => {
    const response = await httpJson(`${gatewayUrl}/accounts`, {
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

    return secret as string;
  });

  const agentId = await measureStep(perf, "create agent", async () => {
    const response = await httpJson(`${gatewayUrl}/v1/agents`, {
      method: "POST",
      token: accountSecret,
      body: {
        name: `smoke-${runId}`,
        config: {
          model: {
            provider: "anthropic",
            modelId: "claude-haiku-4-5-20251001",
          },
          provider: {
            anthropic: { apiKey: modelKey ?? "sk-ant-local-smoke-no-key" },
          },
          instructions: "Reply with the single word OK.",
        },
      },
    });
    const created = (response.body as { agentId?: string }).agentId;
    assertStep(
      "create agent (config plane via gateway)",
      response.status === 201 && typeof created === "string",
      `status ${response.status}: ${JSON.stringify(response.body)}`,
    );

    return created as string;
  });

  const eventId = `smoke-${runId}`;
  await measureStep(perf, "start async run", async () => {
    const response = await httpJson(`${gatewayUrl}/async`, {
      method: "POST",
      token: accountSecret,
      body: {
        agentId: agentId,
        eventId: eventId,
        conversationKey: `smoke-${runId}`,
        events: [
          { role: "user", content: [{ type: "text", text: "Say OK." }] },
        ],
      },
    });
    assertStep(
      "start async run (core via gateway)",
      response.status === 202,
      `status ${response.status}: ${JSON.stringify(response.body)}`,
    );
  });

  await measureStep(perf, "run to terminal state", async () => {
    const statusUrl = `${gatewayUrl}/status/${encodeURIComponent(eventId)}?agentId=${encodeURIComponent(agentId)}`;
    const finalStatus = await pollRunStatus(statusUrl, accountSecret);
    if (modelKey) {
      assertStep(
        "run completed with a real model key",
        finalStatus.status === "completed",
        JSON.stringify(finalStatus),
      );

      return;
    }
    assertStep(
      "run reached a terminal state without a model key (chain proven; set ANTHROPIC_API_KEY for a full green run)",
      finalStatus.status === "completed" || finalStatus.status === "failed",
      JSON.stringify(finalStatus),
    );
  });

  const totalMs = Date.now() - startedAt;
  recordPerf(state.instanceId, "verify", perf, totalMs);
  printPerfBreakdown(perf, totalMs);
  console.log(`\nverify passed in ${(totalMs / 1000).toFixed(1)}s`);
}

// --- convex backend -----------------------------------------------------

function configureDeploymentEnv(state: InstanceState): void {
  // The config plane reads these from the deployment env; AuthKit validates
  // the WORKOS_* values at import time, so dummies must exist before the first
  // deploy. BROODS_ACCOUNT_MANAGE_URL points back at core on the host — the
  // backend runs inside docker, hence host.docker.internal.
  const entries: Record<string, string> = {
    ACCOUNT_CONFIG_ENCRYPTION_SECRET: state.secrets.accountConfigEncryption,
    ADMIN_ACCOUNT_SECRET: state.secrets.adminAccount,
    BROODS_ACCOUNT_MANAGE_URL: `http://host.docker.internal:${state.ports.core}`,
    BROODS_SERVICE_AUTH_SECRET: state.secrets.serviceAuth,
    SERVICE_AUTH_SECRET: state.secrets.serviceAuth,
    WORKOS_API_KEY: "sk_local_dummy",
    WORKOS_CLIENT_ID: "client_local_dummy",
    WORKOS_WEBHOOK_SECRET: "whsec_local_dummy",
  };
  console.log("configuring convex deployment env...");
  for (const [name, value] of Object.entries(entries)) {
    runConvexCli(state, ["env", "set", name, value]);
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
  const output = execFileSync(
    "docker",
    ["exec", containerName(state.instanceId), "./generate_admin_key.sh"],
    { encoding: "utf8" },
  );
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
      CONVEX_SELF_HOSTED_ADMIN_KEY: state.adminKey,
      CONVEX_SELF_HOSTED_URL: `http://127.0.0.1:${state.ports.convexApi}`,
    },
  });
}

// --- host processes -----------------------------------------------------

function startCore(state: InstanceState): void {
  if (isProcessAlive(state.pids.core)) {
    console.log("core already running");

    return;
  }

  const coreDir = join(repoRoot, "apps", "core");
  // The serve script runs this before the server; watch mode restarts only
  // server.ts, so generate the compaction prompt once here.
  execFileSync("bun", ["run", "scripts/compaction-prompt.ts"], {
    cwd: coreDir,
    stdio: "inherit",
  });
  state.pids.core = spawnDetached({
    args: ["--watch", "src/server.ts"],
    cwd: coreDir,
    logName: "core",
    instanceId: state.instanceId,
    env: {
      ACCOUNT_CONFIG_ENCRYPTION_SECRET: state.secrets.accountConfigEncryption,
      ADMIN_ACCOUNT_SECRET: state.secrets.adminAccount,
      CONVEX_DEPLOY_KEY: state.adminKey ?? "",
      CONVEX_URL: `http://127.0.0.1:${state.ports.convexApi}`,
      PORT: String(state.ports.core),
      PUBLIC_BASE_URL: `http://127.0.0.1:${state.ports.gateway}`,
      SERVICE_AUTH_SECRET: state.secrets.serviceAuth,
      SERVICE_NAME: `local-${state.instanceId}-core`,
    },
  });
}

function startGateway(state: InstanceState): void {
  if (isProcessAlive(state.pids.gateway)) {
    console.log("gateway already running");

    return;
  }

  state.pids.gateway = spawnDetached({
    args: ["--watch", "src/main.ts"],
    cwd: join(repoRoot, "apps", "gateway"),
    logName: "gateway",
    instanceId: state.instanceId,
    env: {
      BROODS_CONFIG_URL: `http://127.0.0.1:${state.ports.convexSite}`,
      BROODS_CORE_URLS: `http://127.0.0.1:${state.ports.core}`,
      PORT: String(state.ports.gateway),
    },
  });
}

function isProcessAlive(pid: number | undefined): boolean {
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

/**
 * SIGTERM, then wait for the process to actually exit so a follow-up `up`
 * never races a dying process for its port. SIGKILL after the grace period.
 */
async function stopProcess(
  pid: number | undefined,
  name: string,
): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid as number, "SIGTERM");
  } catch {
    // Already gone between the liveness check and the signal.

    return;
  }
  const graceDeadline = Date.now() + 5_000;
  while (Date.now() < graceDeadline) {
    if (!isProcessAlive(pid)) {
      console.log(`stopped ${name} (pid ${pid})`);

      return;
    }
    await sleep(100);
  }
  try {
    process.kill(pid as number, "SIGKILL");
  } catch {
    // Exited between the last check and the kill.
  }
  await sleep(200);
  if (isProcessAlive(pid)) {
    throw new Error(`${name} (pid ${pid}) survived SIGKILL`);
  }
  console.log(`stopped ${name} (pid ${pid}, forced)`);
}

// --- docker helpers -----------------------------------------------------

function containerName(instanceId: string): string {
  return `broods-convex-${instanceId}`;
}

function dataVolumeName(instanceId: string): string {
  return `broods-convex-${instanceId}-data`;
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

// --- http helpers -------------------------------------------------------

function assertStep(step: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`  ok  ${step}`);

    return;
  }
  console.error(`  FAIL ${step}\n       ${detail}`);
  process.exit(1);
}

async function httpJson(
  url: string,
  options: { body?: unknown; method: string; token: string },
): Promise<{ body: unknown; status: number }> {
  const response = await fetch(url, {
    method: options.method,
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json",
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep the raw text when the answer is not JSON.
  }

  return { body: body, status: response.status };
}

async function pollRunStatus(
  statusUrl: string,
  token: string,
): Promise<{ status?: string }> {
  const deadline = Date.now() + RUN_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await httpJson(statusUrl, {
        method: "GET",
        token: token,
      });
      const doc = response.body as { status?: string };
      if (doc.status === "completed" || doc.status === "failed") return doc;
    } catch {
      // Transient poll failure (timeout, refused): retry until the deadline.
    }
    await sleep(1500);
  }

  return { status: "poll-timeout" };
}

async function probeHttp(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3_000),
    });

    return response.status;
  } catch {
    return null;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForHttp(
  url: string,
  what: string,
  options: { acceptAnyStatus?: boolean } = {},
): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const statusCode = await probeHttp(url);
    if (
      statusCode !== null &&
      (options.acceptAnyStatus === true || statusCode < 400)
    ) {
      console.log(`${what} ready`);

      return;
    }
    await sleep(500);
  }
  throw new Error(
    `${what} did not become ready within ${HEALTH_TIMEOUT_MS}ms (${url})`,
  );
}

// --- perf recording -----------------------------------------------------

function containerMemory(name: string): string | null {
  const output = docker(
    ["stats", "--no-stream", "--format", "{{.MemUsage}}", name],
    { allowFailure: true },
  ).trim();

  return output || null;
}

function lastPerfSummaries(instanceId: string): string[] {
  const path = perfLogPath(instanceId);
  if (!existsSync(path)) return [];

  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PerfRecord);
  const summaries: string[] = [];
  for (const command of ["up", "verify"]) {
    const last = records.findLast((record) => record.command === command);
    if (last) {
      summaries.push(
        `last ${command} ${(last.totalMs / 1000).toFixed(1)}s (${last.at})`,
      );
    }
  }

  return summaries;
}

async function measureStep<T>(
  perf: PerfStep[],
  step: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const result = await fn();
  perf.push({ ms: Date.now() - start, step: step });

  return result;
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

function processRssMb(pid: number | undefined): number | null {
  if (!isProcessAlive(pid)) return null;
  try {
    const output = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();

    return Math.round(Number(output) / 1024);
  } catch {
    return null;
  }
}

function recordPerf(
  instanceId: string,
  command: string,
  steps: PerfStep[],
  totalMs: number,
): void {
  const record: PerfRecord = {
    at: new Date().toISOString(),
    command: command,
    steps: steps,
    totalMs: totalMs,
  };
  mkdirSync(instanceDir(instanceId), { recursive: true });
  writeFileSync(perfLogPath(instanceId), `${JSON.stringify(record)}\n`, {
    flag: "a",
  });
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
  if (existing) return existing;

  const state: InstanceState = {
    instanceId: instanceId,
    instanceSecret: randomBytes(32).toString("hex"),
    pids: {},
    ports: allocatePortBlock(),
    secrets: {
      accountConfigEncryption: randomBytes(24).toString("hex"),
      adminAccount: `local_admin_${randomBytes(18).toString("hex")}`,
      serviceAuth: randomBytes(24).toString("hex"),
    },
    worktreeRoot: repoRoot,
  };
  saveState(state);

  return state;
}

function loadState(instanceId: string): InstanceState | null {
  const path = join(instanceDir(instanceId), "state.json");
  if (!existsSync(path)) return null;

  return JSON.parse(readFileSync(path, "utf8")) as InstanceState;
}

/**
 * state.json carries the admin and encryption secrets, so the instance dir is
 * owner-only. chmod repairs paths created before the modes were enforced —
 * mkdir/write modes only apply on creation.
 */
function saveState(state: InstanceState): void {
  const dir = instanceDir(state.instanceId);
  const path = join(dir, "state.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}
