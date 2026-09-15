/**
 * Local Broods stack: self-hosted Convex in docker plus core and gateway as
 * watched bun processes. Instances are keyed by worktree, so parallel
 * checkouts get isolated stacks on disjoint port blocks. State (secrets,
 * ports, pids, logs, perf) lives under ~/.broods-local/<instance>/.
 *
 * A warm `up` is idempotent: the container restarts in place and the script
 * skips `convex deploy` while packages/convex is unchanged.
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
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

const CONVEX_IMAGE =
  process.env.BROODS_LOCAL_CONVEX_IMAGE ??
  "ghcr.io/get-convex/convex-backend:latest";
const HEALTH_TIMEOUT_MS = 60_000;
const PORT_BLOCK_BASE = 4300;
const PORT_BLOCK_SIZE = 10;
// A warm turn's context prepare. Convex is on localhost here, so this catches
// prepare work that grows or goes serial, not network latency.
const PREPARE_BUDGET_MS = 100;
const RUN_POLL_TIMEOUT_MS = 120_000;
const MACHINE_CONNECT_TIMEOUT_MS = 15_000;
const STATE_ROOT = join(homedir(), ".broods-local");
const MODEL_KEY_HINT =
  "set ANTHROPIC_API_KEY or OPENAI_API_KEY for the full run";
// Without a key the smoke agent still exercises the run path; the model call fails.
const NO_KEY_MODEL: SmokeModel = {
  model: { provider: "anthropic", modelId: "claude-haiku-4-5-20251001" },
  provider: { anthropic: { apiKey: "sk-ant-local-smoke-no-key" } },
};

// The "Context prepared" line core logs once per run (apps/core harness.ts).
interface ContextPreparedLog {
  durationMs: number;
  eventId: string;
  eventType: string;
  historyMs: number;
  historyRows: number;
  mediaMs: number;
  memoryMs: number;
  runtimeMs: number;
  skillsMs: number;
  subagentsMs: number;
}

interface InstancePorts {
  convexApi: number;
  convexSite: number;
  core: number;
  gateway: number;
}

/** The `model` + `provider` block of the smoke agents. */
interface SmokeModel {
  model: {
    provider: string;
    modelId: string;
    providerOptions?: Record<string, Record<string, unknown>>;
  };
  provider: Record<string, { apiKey: string }>;
}

interface InstanceSecrets {
  accountConfigEncryption: string;
  adminAccount: string;
  serviceAuth: string;
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
 * End-to-end smoke: mint an account with the admin secret, create an agent,
 * fire an async run through the gateway, poll its status. Without a model key
 * the run fails at the provider call. Reaching that failure still proves
 * routing, auth, config encrypt/decrypt, and Convex round-trips.
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
  const runId = Date.now().toString(36);
  const smoke = smokeModel();

  await measureStep(perf, "gateway healthz", async () => {
    const health = await probeHttp(`${gatewayUrl}/healthz`);
    assertStep("gateway healthz", health === 200, `status ${health}`);
  });

  const accountSecret = await measureStep(perf, "create account", async () => {
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

  const agentId = await measureStep(perf, "create agent", async () => {
    const response = await httpJson(`${gatewayUrl}/v1/agents`, {
      method: "POST",
      token: accountSecret,
      body: {
        name: `smoke-${runId}`,
        config: {
          ...(smoke ?? NO_KEY_MODEL),
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

    return created;
  });

  // The 202 names the run by a server-issued id; polling follows its statusUrl.
  const startRun = async (
    eventId: string,
    text: string,
    runAgentId: string = agentId,
  ): Promise<string> => {
    const response = await httpJson(`${gatewayUrl}/v1/runs`, {
      method: "POST",
      token: accountSecret,
      body: {
        agentId: runAgentId,
        eventId: eventId,
        conversationKey: `smoke-${runId}`,
        background: true,
        events: [{ role: "user", content: [{ type: "text", text: text }] }],
      },
    });
    const statusUrl = (response.body as { statusUrl?: string }).statusUrl;
    assertStep(
      `start run ${eventId} (core via gateway)`,
      response.status === 202 && typeof statusUrl === "string",
      `status ${response.status}: ${JSON.stringify(response.body)}`,
    );

    return statusUrl.startsWith("/") ? `${gatewayUrl}${statusUrl}` : statusUrl;
  };

  const eventId = `smoke-${runId}`;
  const statusUrl = await measureStep(perf, "start async run", () =>
    startRun(eventId, "Say OK."),
  );

  await measureStep(perf, "run to terminal state", async () => {
    const finalStatus = await pollRunStatus(statusUrl, accountSecret);
    const expected = smoke
      ? finalStatus.status === "completed"
      : finalStatus.status === "completed" || finalStatus.status === "failed";
    const label = smoke
      ? `run completed with a real model key (${smoke.model.modelId})`
      : `run reached a terminal state (no model key; ${MODEL_KEY_HINT})`;
    assertStep(label, expected, JSON.stringify(finalStatus));
  });

  // A second turn on the same conversation takes the path a live chat does:
  // core is warm and the history already has rows.
  const warmEventId = `${eventId}-warm`;
  await measureStep(perf, "warm run to terminal state", async () => {
    const warmStatusUrl = await startRun(warmEventId, "Say OK again.");
    const finalStatus = await pollRunStatus(warmStatusUrl, accountSecret);
    assertStep(
      "warm run reached a terminal state",
      finalStatus.status === "completed" || finalStatus.status === "failed",
      JSON.stringify(finalStatus),
    );
  });

  await measureStep(perf, "warm context prepare", async () => {
    const prepared = contextPreparedLog(state.instanceId, warmEventId);
    assertStep(
      `warm context prepare under ${PREPARE_BUDGET_MS}ms`,
      prepared !== null && prepared.durationMs < PREPARE_BUDGET_MS,
      prepared === null
        ? "no Context prepared line for the warm run in the core log"
        : JSON.stringify(prepared),
    );
    console.log(
      `prepare   ${prepared.durationMs}ms: history ${prepared.historyMs}ms over ${prepared.historyRows} rows, runtime ${prepared.runtimeMs}ms, memory ${prepared.memoryMs}ms, skills ${prepared.skillsMs}ms, subagents ${prepared.subagentsMs}ms, media ${prepared.mediaMs}ms`,
    );
  });

  // This computer as the sandbox: the CLI daemon dials the gateway and core
  // resolves the record it claims. With a model key the agent's bash then runs
  // here and the reply carries this host's name.
  await measureStep(perf, "machine sandbox", async () => {
    const sandboxName = `machine-${runId}`;
    const created = await httpJson(`${gatewayUrl}/v1/sandboxes`, {
      method: "POST",
      token: accountSecret,
      body: {
        name: sandboxName,
        config: {
          provider: "machine",
          permissionMode: "bypass",
          network: { mode: "allow-all" },
        },
      },
    });
    const sandboxId = (created.body as { sandboxId?: string }).sandboxId;
    assertStep(
      "create machine sandbox (config plane via gateway)",
      created.status === 201 && typeof sandboxId === "string",
      `status ${created.status}: ${JSON.stringify(created.body)}`,
    );

    let daemonOutput = "";
    const daemon = spawn(
      "bun",
      ["packages/broods/src/cli/index.ts", "machine", sandboxName],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          BROODS_API_KEY: accountSecret,
          BROODS_BASE_URL: gatewayUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    daemon.stdout.on("data", (chunk: Buffer) => (daemonOutput += chunk));
    daemon.stderr.on("data", (chunk: Buffer) => (daemonOutput += chunk));
    // assertStep exits the process, which skips `finally`; the daemon would
    // otherwise outlive a failed verify and keep serving execs.
    const stopDaemon = (): void => {
      daemon.kill("SIGINT");
    };
    process.once("exit", stopDaemon);
    try {
      const connected = await pollUntil(
        {
          initialIntervalMs: 100,
          maxIntervalMs: 500,
          timeoutMs: MACHINE_CONNECT_TIMEOUT_MS,
        },
        async () =>
          daemonOutput.includes(`connected as ${sandboxName}`) ? true : null,
      );
      assertStep(
        "broods machine connected through the gateway",
        connected === true,
        daemonOutput,
      );
      if (!smoke) {
        console.log(`  skip agent bash on this machine (${MODEL_KEY_HINT})`);

        return;
      }

      const agent = await httpJson(`${gatewayUrl}/v1/agents`, {
        method: "POST",
        token: accountSecret,
        body: {
          name: sandboxName,
          config: {
            ...smoke,
            instructions:
              "Use the bash tool to run `hostname`, then reply with exactly its output and nothing else.",
            sandbox: sandboxId,
          },
        },
      });
      const machineAgentId = (agent.body as { agentId?: string }).agentId;
      assertStep(
        "create agent on the machine sandbox",
        agent.status === 201 && typeof machineAgentId === "string",
        `status ${agent.status}: ${JSON.stringify(agent.body)}`,
      );
      const statusUrl = await startRun(
        `${eventId}-machine`,
        "Run hostname.",
        machineAgentId,
      );
      const finalStatus = (await pollRunStatus(statusUrl, accountSecret)) as {
        status?: string;
        response?: unknown;
      };
      assertStep(
        "agent bash ran on this machine and the reply names this host",
        finalStatus.status === "completed" &&
          JSON.stringify(finalStatus.response ?? "").includes(hostname()) &&
          daemonOutput.includes("$ "),
        `${JSON.stringify(finalStatus)}\n${daemonOutput}`,
      );
    } finally {
      process.off("exit", stopDaemon);
      stopDaemon();
    }
  });

  const totalMs = Date.now() - startedAt;
  recordPerf(state.instanceId, "verify", perf, totalMs);
  printPerfBreakdown(perf, totalMs);
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
    BROODS_SERVICE_AUTH_SECRET: state.secrets.serviceAuth,
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
      PORT: String(state.ports.core),
      PUBLIC_BASE_URL: `http://127.0.0.1:${state.ports.gateway}`,
      SERVICE_AUTH_SECRET: state.secrets.serviceAuth,
      SERVICE_NAME: `local-${state.instanceId}-core`,
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

// --- model --------------------------------------------------------------

/** The smoke agents' model from whichever key the shell carries; null for none. */
function smokeModel(): SmokeModel | null {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return {
      model: { provider: "anthropic", modelId: "claude-haiku-4-5-20251001" },
      provider: { anthropic: { apiKey: anthropicKey } },
    };
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      model: {
        provider: "openai",
        modelId: "gpt-5.6-luna",
        providerOptions: { openai: { reasoningEffort: "max" } },
      },
      provider: { openai: { apiKey: openaiKey } },
    };
  }

  return null;
}

// --- http ---------------------------------------------------------------

function assertStep(step: string, ok: boolean, detail: string): asserts ok {
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
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON, keep the raw text
  }

  return { body: body, status: response.status };
}

async function pollRunStatus(
  statusUrl: string,
  token: string,
): Promise<{ status?: string }> {
  const doc = await pollUntil(
    {
      initialIntervalMs: 200,
      maxIntervalMs: 1_500,
      timeoutMs: RUN_POLL_TIMEOUT_MS,
    },
    async () => {
      try {
        const response = await httpJson(statusUrl, {
          method: "GET",
          token: token,
        });
        const body = response.body as { status?: string };

        return body.status === "completed" || body.status === "failed"
          ? body
          : null;
      } catch {
        return null; // transient poll failure, retry until the deadline
      }
    },
  );

  return doc ?? { status: "poll-timeout" };
}

// Repeats attempt() with doubling backoff until it returns non-null or
// timeoutMs passes. Returns null on timeout.
async function pollUntil<T>(
  options: {
    initialIntervalMs: number;
    maxIntervalMs: number;
    timeoutMs: number;
  },
  attempt: () => Promise<T | null>,
): Promise<T | null> {
  const deadline = Date.now() + options.timeoutMs;
  let interval = options.initialIntervalMs;
  while (Date.now() < deadline) {
    const result = await attempt();
    if (result !== null) return result;
    await Bun.sleep(Math.min(interval, Math.max(deadline - Date.now(), 0)));
    interval = Math.min(interval * 2, options.maxIntervalMs);
  }

  return null;
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

// The prepare timings core logged for one run. Core scopes the event id under
// the account and agent, so the public id is matched as a suffix. The last
// match wins, since a retried run prepares again.
function contextPreparedLog(
  instanceId: string,
  eventId: string,
): ContextPreparedLog | null {
  return lastJsonLine<ContextPreparedLog>(
    join(instanceDir(instanceId), "logs", "core.log"),
    (record) =>
      record.eventType === "session.context.prepared" &&
      record.eventId.endsWith(`:${eventId}`),
  );
}

// The logs are append-only, one JSON object per line, so walk from the end and
// stop at the first match instead of parsing the whole file.
function lastJsonLine<T>(
  path: string,
  matches: (record: T) => boolean,
): T | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    if (!line) continue;
    try {
      const record = JSON.parse(line) as T;
      if (matches(record)) return record;
    } catch {
      // A partial line from a log that is still being written.
    }
  }

  return null;
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
