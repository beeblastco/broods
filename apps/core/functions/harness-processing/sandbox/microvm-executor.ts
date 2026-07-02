/**
 * AWS Lambda MicroVM sandbox executor (provider string stays "lambda").
 *
 * A MicroVM is a Firecracker-isolated, snapshot-resumable VM that runs the
 * lambda-sandbox image as a long-lived HTTP server. We `RunMicrovm` to get an
 * `{endpoint, microvmId}`, mint a short-lived auth token, and POST the SAME
 * wire-compatible exec request the image already understands to
 * `https://<endpoint>/exec` with the `X-aws-proxy-auth` / `X-aws-proxy-port`
 * headers. Only the transport changes from the old Invoke path.
 *
 * The workspace S3 mount happens INSIDE the VM (mount-s3 in the image's `/run`
 * hook), fed short-lived, namespace-scoped assume-role creds via `runHookPayload`
 * — the same scoped-credential model daytona/workdir use, so the harness's broad
 * creds never reach the VM (any code the agent runs can read that env). Lifecycle
 * (suspend/resume/terminate/getInstanceInfo) maps onto the MicroVM control-plane
 * commands; persistent reservations reconnect by microvmId via the shared
 * instance-store, mirroring the daytona executor. A persistent reservation also runs
 * detached background jobs and onCreate/onResume hooks over the same /exec channel —
 * the VM is not terminated after the request, so the work (and its completion
 * callback) survives, riding suspend/resume with the snapshot.
 */

import {
  CreateMicrovmAuthTokenCommand,
  CreateMicrovmShellAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovms,
  type MicrovmState,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  type RunMicrovmRequest,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { optionalEnv } from "../../_shared/env.ts";
import { isPlainObject } from "../../_shared/object.ts";
import { DEFAULT_RELEASE_GRACE_SECONDS, MAX_CONCURRENT_BACKGROUND_JOBS, resolveSandboxLifecycle } from "../../_shared/sandbox.ts";
import { type S3MountContext, resolveS3Mount } from "./s3-mount.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxInstanceInfo,
  SandboxJobHandle,
  SandboxJobLogs,
  SandboxJobRequest,
  SandboxJobStatus,
  SandboxReservationRef,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";
import { configString, sandboxReservationKey, stringRecord, truncateText } from "./utils.ts";
import { generateJobId, launchScript, lifecycleScript, logsScript, parseJobStatus, statusScript, stopScript } from "./jobs.ts";
import { claimSandboxInstance, deleteSandboxInstance, getSandboxExternalId, saveSandboxInstance } from "./instance-store.ts";
import { upsertSandboxInstance } from "../../_shared/storage/convex/sandbox-instances.ts";

// The image serves the exec API on this port; the proxy maps external 443 -> 8080.
const MICROVM_PROXY_PORT = 8080;
// Per-call auth tokens are minted just-in-time; a short TTL (well under the 60-min
// cap) is plenty for one blocking exec and keeps the token's blast radius tiny.
const AUTH_TOKEN_TTL_MINUTES = 15;
// A freshly run MicroVM restores its snapshot in ~1–10s; the proxy returns 502/503
// while it warms. Retry the first exec within this budget before giving up.
const WARMUP_BUDGET_MS = 30_000;
const WARMUP_RETRY_DELAY_MS = 750;
// MicroVMs live at most 8h; we still bound each instance with a maximumDuration as
// a backstop (ephemeral VMs are terminated in `finally` long before this).
const MAX_MICROVM_DURATION_SECONDS = 28_800;
const DEFAULT_WORKSPACE_ROOT = "/mnt/workspaces";

const PROVIDER = "lambda" as const;

// The proxy authenticates shell WebSocket upgrades with this header; the value
// comes from CreateMicrovmShellAuthToken. 30 minutes bounds a terminal session's
// credential without cutting normal interactive use short.
export const MICROVM_SHELL_AUTH_HEADER = "X-aws-proxy-auth";
const SHELL_TOKEN_TTL_MINUTES = 30;

// The JSON contract the lambda-sandbox image returns (snake_case), unchanged from
// the Invoke era — only the transport (HTTP vs Invoke) differs.
interface SandboxResponse {
  ok: boolean;
  runtime?: string;
  exit_code?: number | null;
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
  truncated?: boolean;
  cpu_usec?: number;
}

export class MicrovmSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;
  readonly #client: LambdaMicrovms;

  constructor(
    config: SandboxExecutorConfig,
    client = new LambdaMicrovms({ region: process.env.AWS_REGION }),
  ) {
    this.#config = config;
    this.#client = client;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const persistent = this.#persistent(request);
    const { microvmId, endpoint } = await this.#acquire(request);

    try {
      if (persistent) await this.#runLifecycle(microvmId, endpoint, this.#workDir(this.#workspaceKey(request)));
      const response = await this.#exec(microvmId, endpoint, this.#execPayload(request));
      const stdout = truncateText(response.stdout, request.outputLimitBytes);
      const stderr = truncateText(response.stderr, request.outputLimitBytes);
      return {
        ok: response.ok,
        runtime: request.runtime ?? "bash",
        exitCode: response.exit_code ?? null,
        stdout: stdout.value,
        stderr: stderr.value,
        durationMs: response.duration_ms || Date.now() - startedAt,
        timedOut: response.timed_out,
        truncated: response.truncated === true || stdout.truncated || stderr.truncated,
        provider: PROVIDER,
        ...(typeof response.cpu_usec === "number" && response.cpu_usec > 0 ? { cpuUsec: response.cpu_usec } : {}),
      };
    } finally {
      if (!persistent) await this.#terminate(microvmId);
    }
  }

  // Detached background work survives the harness request because a persistent
  // MicroVM is not terminated after the call. The job is launched as a setsid
  // session that POSTs its result to the completion callback when it exits; it is
  // snapshotted/restored with the VM across suspend/resume (same boot id).
  async runBackground(request: SandboxRunRequest): Promise<SandboxJobHandle> {
    const key = this.#requirePersistent(request);
    const { microvmId, endpoint } = await this.#acquire(request);
    const workDir = this.#workDir(this.#workspaceKey(request));
    await this.#runLifecycle(microvmId, endpoint, workDir);
    const jobId = request.jobId ?? generateJobId();
    const script = launchScript(this.#jobsDir(key), jobId, workDir, request.code, {
      maxConcurrentJobs: MAX_CONCURRENT_BACKGROUND_JOBS,
      ...(request.callback ? { callback: request.callback } : {}),
    });
    const result = await this.#shell(microvmId, endpoint, script, 30);
    if (result.exitCode !== null && result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "failed to launch background job");
    }
    return { jobId };
  }

  async jobStatus(request: SandboxJobRequest): Promise<SandboxJobStatus> {
    const { microvmId, endpoint, jobsDir } = await this.#jobContext(request);
    const result = await this.#shell(microvmId, endpoint, statusScript(jobsDir, request.jobId));
    return parseJobStatus(request.jobId, result.stdout);
  }

  async jobLogs(request: SandboxJobRequest): Promise<SandboxJobLogs> {
    const bytes = request.outputLimitBytes ?? 64 * 1024;
    const { microvmId, endpoint, jobsDir } = await this.#jobContext(request);
    const result = await this.#shell(microvmId, endpoint, logsScript(jobsDir, request.jobId, bytes));
    const logs = truncateText(result.stdout, bytes);
    return { jobId: request.jobId, logs: logs.value, truncated: logs.truncated };
  }

  async stopJob(request: SandboxJobRequest): Promise<SandboxJobStatus> {
    const { microvmId, endpoint, jobsDir } = await this.#jobContext(request);
    await this.#shell(microvmId, endpoint, stopScript(jobsDir, request.jobId));
    // Report the real terminal state: a job that had already finished keeps its
    // own exit code instead of being recorded as killed.
    const result = await this.#shell(microvmId, endpoint, statusScript(jobsDir, request.jobId));
    return parseJobStatus(request.jobId, result.stdout);
  }

  async suspend(request: SandboxReservationRef): Promise<void> {
    const microvmId = await this.#reservedId(request);
    if (microvmId) await this.#client.send(new SuspendMicrovmCommand({ microvmIdentifier: microvmId }));
  }

  async resume(request: SandboxReservationRef): Promise<void> {
    const microvmId = await this.#reservedId(request);
    if (microvmId) await this.#client.send(new ResumeMicrovmCommand({ microvmIdentifier: microvmId }));
  }

  async getInstanceInfo(request: SandboxReservationRef): Promise<SandboxInstanceInfo | null> {
    const microvmId = await this.#reservedId(request);
    if (!microvmId) return null;
    try {
      const info = await this.#client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
      return { externalId: microvmId, state: mapMicrovmState(info.state) };
    } catch (error) {
      if (isMicrovmNotFound(error)) {
        return null;
      }
      return { externalId: microvmId, state: "unknown" };
    }
  }

  async release(request: SandboxReservationRef): Promise<void> {
    const key = sandboxReservationKey(request);
    if (!key) return;
    const microvmId = await getSandboxExternalId(PROVIDER, key);
    if (microvmId) await this.#terminate(microvmId);
    await deleteSandboxInstance(PROVIDER, key).catch(() => {});
  }

  #optionOrEnv(option: string, env: string): string | undefined {
    const options = isPlainObject(this.#config.options) ? this.#config.options : {};
    return configString(options[option]) ?? optionalEnv(env);
  }

  #requireImageIdentifier(): string {
    // The first-class `snapshot` pin (per-config image ARN) wins, then the
    // `options.imageIdentifier` alias, then the harness-wide env default.
    const identifier = configString(this.#config.snapshot)
      ?? this.#optionOrEnv("imageIdentifier", "MICROVM_IMAGE_IDENTIFIER");
    if (!identifier) {
      throw new Error("MicroVM sandbox requires a config `snapshot` image ARN or MICROVM_IMAGE_IDENTIFIER in the harness runtime.");
    }
    return identifier;
  }

  #persistent(request: SandboxReservationRef): boolean {
    return this.#config.persistent === true && !!sandboxReservationKey(request);
  }

  async #reservedId(request: SandboxReservationRef): Promise<string | null> {
    const key = sandboxReservationKey(request);
    return key ? getSandboxExternalId(PROVIDER, key) : null;
  }

  #requirePersistent(request: SandboxReservationRef): string {
    const key = sandboxReservationKey(request);
    if (this.#config.persistent !== true || !key) {
      throw new Error("background jobs require a persistent lambda (MicroVM) sandbox reservation key");
    }
    return key;
  }

  #workspaceRoot(): string {
    const options = isPlainObject(this.#config.options) ? this.#config.options : {};
    return (configString(options.workspaceRoot) ?? DEFAULT_WORKSPACE_ROOT).replace(/\/+$/, "");
  }

  #workDir(key: string): string {
    return `${this.#workspaceRoot()}/${key}`;
  }

  #workspaceKey(request: SandboxReservationRef): string {
    const key = request.namespace ? microvmLocalNamespace(request.namespace) : sandboxReservationKey(request);
    if (!key) {
      throw new Error("persistent MicroVM lifecycle requires a workspace namespace or reservation key");
    }
    return key;
  }

  // Job markers live beside the workspace mount (not under the S3 mount) so the tiny
  // files stay on the VM's native disk and ride suspend/resume with the same VM.
  #jobsDir(key: string): string {
    return `${this.#workspaceRoot()}/.fp-jobs/${key}`;
  }

  // Acquire a MicroVM endpoint: a fresh ephemeral VM for stateless runs, or the
  // reserved VM (resumed if suspended) for a persistent reservation.
  async #acquire(request: SandboxRunRequest): Promise<{ microvmId: string; endpoint: string }> {
    if (!this.#persistent(request)) {
      return this.#runMicrovm(request);
    }
    const key = sandboxReservationKey(request)!;
    const existing = await getSandboxExternalId(PROVIDER, key);
    if (existing) {
      try {
        const reconnected = await this.#reconnect(existing);
        await saveSandboxInstance(PROVIDER, key, existing).catch(() => {});
        await upsertSandboxInstance(this.#config.controlPlane, PROVIDER, key, existing, request.metadata);
        return reconnected;
      } catch (error) {
        // Recreate only when the provider says the VM no longer exists. A slow
        // resume or transient control-plane error must propagate instead: replacing
        // a still-allocated (e.g. suspended) VM leaks it and burns the account's
        // MicroVM memory quota until nothing can launch.
        if (!isMicrovmNotFound(error)) throw error;
        await deleteSandboxInstance(PROVIDER, key, existing).catch(() => {});
      }
    }
    const created = await this.#runMicrovm(request);
    if (await claimSandboxInstance(PROVIDER, key, created.microvmId)) {
      await upsertSandboxInstance(this.#config.controlPlane, PROVIDER, key, created.microvmId, request.metadata);
      return created;
    }
    // Lost a concurrent create race: discard our duplicate and reconnect to the winner.
    const winner = await getSandboxExternalId(PROVIDER, key);
    await this.#terminate(created.microvmId);
    const reconnected = winner ? await this.#reconnect(winner).catch(() => null) : null;
    if (!reconnected) throw new Error("failed to reserve MicroVM (lost create race)");
    return reconnected;
  }

  // Fetch a reserved VM's endpoint, resuming it first if it idled into SUSPENDED.
  async #reconnect(microvmId: string): Promise<{ microvmId: string; endpoint: string }> {
    let info = await this.#client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
    if (info.state === "SUSPENDED" || info.state === "SUSPENDING") {
      await this.#client.send(new ResumeMicrovmCommand({ microvmIdentifier: microvmId }));
      const deadline = Date.now() + WARMUP_BUDGET_MS;
      do {
        await delay(WARMUP_RETRY_DELAY_MS);
        info = await this.#client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
      } while ((info.state === "SUSPENDED" || info.state === "SUSPENDING") && Date.now() < deadline);
    }
    if (!info.endpoint) throw new Error(`MicroVM ${microvmId} has no endpoint`);
    return { microvmId, endpoint: info.endpoint };
  }

  async #runMicrovm(request: SandboxRunRequest): Promise<{ microvmId: string; endpoint: string }> {
    const result = await this.#client.send(new RunMicrovmCommand(await this.#runInput(request)));
    if (!result.microvmId || !result.endpoint) {
      throw new Error("RunMicrovm did not return a microvmId and endpoint");
    }
    return { microvmId: result.microvmId, endpoint: result.endpoint };
  }

  async #runInput(request: SandboxRunRequest): Promise<RunMicrovmRequest> {
    const imageIdentifier = this.#requireImageIdentifier();
    const imageVersion = this.#optionOrEnv("imageVersion", "MICROVM_IMAGE_VERSION");
    const executionRoleArn = this.#optionOrEnv("executionRoleArn", "MICROVM_EXECUTION_ROLE_ARN");
    const persistent = this.#persistent(request);
    const lifecycle = resolveSandboxLifecycle(this.#config.lifecycle);
    const runHookPayload = await this.#runHookPayload(request);
    return {
      imageIdentifier,
      ...(imageVersion ? { imageVersion } : {}),
      ...(executionRoleArn ? { executionRoleArn } : {}),
      ...(persistent
        ? {
          idlePolicy: {
            maxIdleDurationSeconds: lifecycle.idleTimeoutSeconds,
            suspendedDurationSeconds: lifecycle.maxLifetimeSeconds ?? DEFAULT_RELEASE_GRACE_SECONDS,
            autoResumeEnabled: true,
          },
        }
        : {}),
      maximumDurationInSeconds: persistent
        ? Math.min(lifecycle.maxLifetimeSeconds ?? MAX_MICROVM_DURATION_SECONDS, MAX_MICROVM_DURATION_SECONDS)
        : Math.min(request.timeoutSeconds + 60, MAX_MICROVM_DURATION_SECONDS),
      ...this.#networkConnectors(persistent),
      ...(runHookPayload ? { runHookPayload } : {}),
    };
  }

  // Per-VM init delivered to the image's /run hook. Carries the workspace mount
  // (namespace + scoped, short-lived assume-role creds) so the VM mounts S3 itself.
  // Absent for stateless (no-workspace) runs.
  async #runHookPayload(request: SandboxRunRequest): Promise<string | undefined> {
    if (!request.namespace) return undefined;
    const mount = await resolveS3Mount(this.#s3Context(request.namespace));
    const workspaceRoot = (request.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT).replace(/\/+$/, "");
    const namespace = microvmLocalNamespace(request.namespace);
    return JSON.stringify({
      workspace: {
        namespace,
        root: workspaceRoot,
        mount: {
          bucket: mount.bucket,
          prefix: mount.prefix,
          ...(mount.region ? { region: mount.region } : {}),
          ...(mount.endpoint ? { endpoint: mount.endpoint } : {}),
          ...(mount.credentials ? { env: mount.credentials } : {}),
        },
      },
    });
  }

  #s3Context(namespace: string): S3MountContext {
    return {
      storage: this.#config.storage,
      namespace,
      managedBucket: optionalEnv("FILESYSTEM_BUCKET_NAME"),
      region: optionalEnv("AWS_REGION") ?? optionalEnv("AWS_DEFAULT_REGION"),
    };
  }

  // Map the account network mode onto egress connectors. allow-all uses the default
  // INTERNET_EGRESS (no connector). restricted/deny-all need a VPC egress connector
  // (provisioned in SST, ARN passed via env); without one we fail closed instead of
  // silently launching with the MicroVM service's default internet egress.
  // Persistent (reserved) VMs additionally attach the AWS-managed SHELL_INGRESS
  // connector so the dashboard terminal can mint shell auth tokens later —
  // connectors are fixed at RunMicrovm and cannot be added to a live VM.
  #networkConnectors(persistent: boolean): Pick<RunMicrovmRequest, "egressNetworkConnectors" | "ingressNetworkConnectors"> {
    const ingress = persistent
      ? { ingressNetworkConnectors: [managedIngressConnectorArn("ALL_INGRESS"), managedIngressConnectorArn("SHELL_INGRESS")] }
      : {};
    const mode = this.#config.network?.mode ?? "deny-all";
    if (mode === "allow-all") return ingress;
    const egress = optionalEnv("MICROVM_EGRESS_NETWORK_CONNECTOR_ARN");
    if (!egress) {
      throw new Error(`MicroVM sandbox cannot enforce ${mode} egress without MICROVM_EGRESS_NETWORK_CONNECTOR_ARN`);
    }
    return { ...ingress, egressNetworkConnectors: [egress] };
  }

  // The exec request body, wire-compatible with the image's existing JSON contract.
  #execPayload(request: SandboxRunRequest): Record<string, unknown> {
    return {
      runtime: request.runtime ?? "bash",
      code: request.code,
      ...(request.namespace ? { namespace: microvmLocalNamespace(request.namespace) } : {}),
      ...(request.workspaceRoot ? { workspace_root: request.workspaceRoot } : {}),
      timeout_ms: request.timeoutSeconds * 1000,
      ...(request.args && request.args.length > 0 ? { args: request.args } : {}),
      env: this.#sandboxEnvVars(request.envVars),
    };
  }

  #sandboxEnvVars(requestEnvVars?: Record<string, string>): Record<string, string> {
    return { ...stringRecord(this.#config.envVars), ...(requestEnvVars ?? {}) };
  }

  // POST the exec request to the VM endpoint, retrying while the snapshot warms.
  async #exec(microvmId: string, endpoint: string, payload: object): Promise<SandboxResponse> {
    const token = await this.#authToken(microvmId);
    const url = `https://${endpoint.replace(/^https?:\/\//, "")}/exec`;
    const deadline = Date.now() + WARMUP_BUDGET_MS;
    for (;;) {
      const warming = await this.#postExec(url, token, payload);
      if (!warming.retry) return warming.response;
      if (Date.now() >= deadline) {
        throw new Error(`MicroVM ${microvmId} did not become ready within ${WARMUP_BUDGET_MS}ms (last status ${warming.status})`);
      }
      await delay(WARMUP_RETRY_DELAY_MS);
    }
  }

  async #postExec(
    url: string,
    token: string,
    payload: object,
  ): Promise<{ retry: true; status: number | string } | { retry: false; response: SandboxResponse }> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-aws-proxy-auth": token,
          "X-aws-proxy-port": String(MICROVM_PROXY_PORT),
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // Connection refused/reset while the VM is still restoring its snapshot.
      return { retry: true, status: err instanceof Error ? err.message : "fetch error" };
    }
    // 502/503/504 from the proxy mean "warming"; the image itself answers request-
    // level errors with HTTP 200 + an ok:false body, so any other non-2xx is fatal.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return { retry: true, status: res.status };
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`MicroVM exec failed (${res.status}): ${text || res.statusText}`);
    }
    if (!text) throw new Error("MicroVM exec returned an empty response");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("MicroVM exec response must be an object");
    }
    return { retry: false, response: parsed as SandboxResponse };
  }

  async #authToken(microvmId: string): Promise<string> {
    const result = await this.#client.send(new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: microvmId,
      expirationInMinutes: AUTH_TOKEN_TTL_MINUTES,
      allowedPorts: [{ port: MICROVM_PROXY_PORT }],
    }));
    const token = result.authToken?.["X-aws-proxy-auth"];
    if (!token) throw new Error("CreateMicrovmAuthToken did not return an X-aws-proxy-auth token");
    return token;
  }

  // Run a control/lifecycle bash script in the VM and return its stdout + exit code.
  // Used for onCreate/onResume hooks and background-job marker scripts (no workspace
  // cwd — the scripts use absolute paths).
  async #shell(
    microvmId: string,
    endpoint: string,
    script: string,
    timeoutSeconds = 60,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const response = await this.#exec(microvmId, endpoint, {
      runtime: "bash",
      code: script,
      timeout_ms: timeoutSeconds * 1000,
      env: this.#sandboxEnvVars(),
    });
    return { stdout: response.stdout, stderr: response.stderr, exitCode: response.exit_code ?? null };
  }

  // onCreate (once, marker-guarded) / onResume (every acquire) hooks in the reserved
  // VM, mirroring the daytona/workdir persistent lifecycle.
  async #runLifecycle(microvmId: string, endpoint: string, workDir: string): Promise<void> {
    const script = lifecycleScript(workDir, this.#config.onCreate, this.#config.onResume);
    if (!script) return;
    const result = await this.#shell(microvmId, endpoint, script, this.#config.timeout ?? 120);
    if (result.exitCode !== null && result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "MicroVM lifecycle hook failed");
    }
  }

  // Reconnect to the reserved VM for a background-job control call.
  async #jobContext(request: SandboxJobRequest): Promise<{ microvmId: string; endpoint: string; jobsDir: string }> {
    const key = sandboxReservationKey(request);
    if (!key) throw new Error("job operations require a persistent sandbox reservation key");
    const microvmId = await getSandboxExternalId(PROVIDER, key);
    if (!microvmId) throw new Error("no reserved MicroVM for this workspace");
    const { endpoint } = await this.#reconnect(microvmId);
    return { microvmId, endpoint, jobsDir: this.#jobsDir(key) };
  }

  async #terminate(microvmId: string): Promise<void> {
    await this.#client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId })).catch(() => {});
  }
}

// AWS-managed ingress connectors live under a service-owned ARN namespace,
// parameterized only by region and name (ALL_INGRESS / SHELL_INGRESS / NO_INGRESS).
function managedIngressConnectorArn(name: string): string {
  const region = optionalEnv("AWS_REGION") ?? optionalEnv("AWS_DEFAULT_REGION");
  if (!region) throw new Error("MicroVM ingress connectors require AWS_REGION");
  return `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:${name}`;
}

/**
 * Mints the live-shell WebSocket target for a reserved MicroVM: the VM endpoint
 * plus a short-lived shell auth token. account-manage seals both into a terminal
 * ticket; the gateway dials the URL with the token in X-aws-proxy-auth. Fails for
 * VMs launched without the SHELL_INGRESS connector (reservations that predate it).
 */
export async function microvmShellConnection(
  microvmId: string,
  client = new LambdaMicrovms({ region: process.env.AWS_REGION }),
): Promise<{ url: string; authorization: string }> {
  const info = await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
  if (!info.endpoint) throw new Error(`MicroVM ${microvmId} has no endpoint`);
  const result = await client.send(new CreateMicrovmShellAuthTokenCommand({
    microvmIdentifier: microvmId,
    expirationInMinutes: SHELL_TOKEN_TTL_MINUTES,
  }));
  const token = result.authToken?.[MICROVM_SHELL_AUTH_HEADER];
  if (!token) throw new Error("CreateMicrovmShellAuthToken did not return an X-aws-proxy-auth token");

  return { url: `wss://${info.endpoint.replace(/^https?:\/\//, "")}`, authorization: token };
}

function mapMicrovmState(state: MicrovmState | undefined): SandboxInstanceInfo["state"] {
  switch (state) {
    case "RUNNING":
    case "PENDING":
      return "running";
    case "SUSPENDED":
    case "SUSPENDING":
      return "suspended";
    case "TERMINATING":
    case "TERMINATED":
      return "terminating";
    default:
      return "unknown";
  }
}

function microvmLocalNamespace(namespace: string): string {
  return namespace.split("/")[0] ?? namespace;
}

function isMicrovmNotFound(error: unknown): boolean {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  const message = error instanceof Error ? error.message : String(error);

  return name === "ResourceNotFoundException" || /not found|does not exist|not exist/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
