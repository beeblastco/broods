/**
 * Daytona-backed sandbox executor.
 * Keep Daytona SDK adaptation here. A real VM: mount the workspace, then run the
 * bash `code` as-is. Persistent mode reserves one sandbox per workspace,
 * reconnecting by stored id (Daytona auto-stops it on idle; the harness restarts it).
 */

import { optionalEnv } from "../../_shared/env.ts";
import { logWarn } from "../../_shared/log.ts";
import { isPlainObject, isStringRecord } from "../../_shared/object.ts";
import { DEFAULT_RELEASE_GRACE_SECONDS, MAX_CONCURRENT_BACKGROUND_JOBS, resolveSandboxLifecycle } from "../../_shared/sandbox.ts";
import { Daytona, type Sandbox } from "@daytona/sdk";
import { type S3MountContext, type S3MountIdentity, resolveS3Mount, resolveS3MountIdentity } from "./s3-mount.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxJobHandle,
  SandboxJobLogs,
  SandboxJobRequest,
  SandboxJobStatus,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";
import { assertSafeTenantProviderUrl, configString, isNoRunnersError, isSandboxGoneError, sandboxReservationKey, shellQuote, truncateText, workspacePath } from "./utils.ts";
import { generateJobId, launchScript, lifecycleScript, logsScript, parseJobStatus, statusScript, stopScript } from "./jobs.ts";
import { claimSandboxInstance, deleteSandboxInstance, getSandboxExternalId, saveSandboxInstance } from "./instance-store.ts";
import { upsertSandboxInstance } from "../../_shared/storage/convex/sandbox-instances.ts";

export class DaytonaSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;

  constructor(config: SandboxExecutorConfig) {
    this.#config = config;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const persistent = this.#persistent(request);
    const sandbox = await this.#acquire(request);

    try {
      await mountAwsS3Buckets(sandbox, request, this.#config);
      if (persistent) {
        await this.#runLifecycle(sandbox, this.#workDir(sandboxReservationKey(request)!));
      }
      const response = await sandbox.process.executeCommand(
        request.code,
        workspacePath(request),
        undefined,
        request.timeoutSeconds,
      );
      const stdout = truncateText(response.result ?? artifactStdout(response.artifacts), request.outputLimitBytes);
      return {
        ok: (response.exitCode ?? 0) === 0,
        runtime: request.runtime ?? "bash",
        exitCode: response.exitCode ?? null,
        stdout: stdout.value,
        stderr: "",
        durationMs: Date.now() - startedAt,
        truncated: stdout.truncated,
        provider: "daytona",
      };
    } finally {
      if (!persistent) await sandbox.delete();
    }
  }

  async runBackground(request: SandboxRunRequest): Promise<SandboxJobHandle> {
    const ns = this.#requirePersistent(request);
    const sandbox = await this.#acquire(request);
    await mountAwsS3Buckets(sandbox, request, this.#config);
    await this.#runLifecycle(sandbox, this.#workDir(ns));
    const jobId = request.jobId ?? generateJobId();
    const script = launchScript(this.#jobsDir(ns), jobId, this.#workDir(ns), request.code, {
      maxConcurrentJobs: MAX_CONCURRENT_BACKGROUND_JOBS,
      ...(request.callback ? { callback: request.callback } : {}),
    });
    const response = await sandbox.process.executeCommand(script);
    if ((response.exitCode ?? 0) !== 0) {
      throw new Error(response.result ?? artifactStdout(response.artifacts) ?? "failed to launch background job");
    }
    return { jobId };
  }

  async jobStatus(request: SandboxJobRequest): Promise<SandboxJobStatus> {
    const { sandbox, jobsDir } = await this.#jobContext(request);
    return parseJobStatus(request.jobId, await this.#shell(sandbox, statusScript(jobsDir, request.jobId)));
  }

  async jobLogs(request: SandboxJobRequest): Promise<SandboxJobLogs> {
    const bytes = request.outputLimitBytes ?? 64 * 1024;
    const { sandbox, jobsDir } = await this.#jobContext(request);
    const logs = truncateText(await this.#shell(sandbox, logsScript(jobsDir, request.jobId, bytes)), bytes);
    return { jobId: request.jobId, logs: logs.value, truncated: logs.truncated };
  }

  async stopJob(request: SandboxJobRequest): Promise<SandboxJobStatus> {
    const { sandbox, jobsDir } = await this.#jobContext(request);
    await this.#shell(sandbox, stopScript(jobsDir, request.jobId));
    // Report the real terminal state: a job that had already finished keeps its
    // own exit code instead of being recorded as killed.
    return parseJobStatus(request.jobId, await this.#shell(sandbox, statusScript(jobsDir, request.jobId)));
  }

  async release(request: { namespace?: string; reservationKey?: string }): Promise<void> {
    const key = sandboxReservationKey(request);
    if (!key) return;
    const externalId = await getSandboxExternalId("daytona", key);
    if (!externalId) return;
    try {
      const sandbox = await new Daytona(daytonaClientOptions(this.#config)).get(externalId);
      await sandbox.delete();
    } catch (err) {
      // Already gone => safe to forget. Wrong creds / transient => propagate so a
      // caller iterating multiple configs can try the next one.
      if (!isSandboxGoneError(err)) throw err;
    }
    await deleteSandboxInstance("daytona", key).catch(() => {});
  }

  #persistent(request: { namespace?: string; reservationKey?: string }): boolean {
    return this.#config.persistent === true && !!sandboxReservationKey(request);
  }

  #requirePersistent(request: { namespace?: string; reservationKey?: string }): string {
    if (!this.#persistent(request)) {
      throw new Error("background jobs require a persistent daytona sandbox reservation key");
    }
    return sandboxReservationKey(request)!;
  }

  #workspaceRoot(): string {
    const options = isPlainObject(this.#config.options) ? this.#config.options : {};
    return (configString(options.workspaceRoot) ?? "/mnt/workspaces").replace(/\/+$/, "");
  }

  #workDir(namespace: string): string {
    return `${this.#workspaceRoot()}/${namespace}`;
  }

  // Markers live beside the workspace mount (not under the S3 mount) so the tiny
  // files stay on the sandbox's native, stop-persistent disk.
  #jobsDir(reservationKey: string): string {
    return `${this.#workspaceRoot()}/.fp-jobs/${reservationKey}`;
  }

  async #acquire(request: { namespace?: string; reservationKey?: string; envVars?: Record<string, string> }): Promise<Sandbox> {
    const client = new Daytona(daytonaClientOptions(this.#config));
    if (!this.#persistent(request)) {
      return this.#create(client, await daytonaCreateOptions(this.#config, request, false));
    }
    const ns = sandboxReservationKey(request)!;
    const externalId = await getSandboxExternalId("daytona", ns);
    if (externalId) {
      try {
        const sandbox = await this.#reconnect(client, externalId);
        await saveSandboxInstance("daytona", ns, externalId).catch(() => {});
        await upsertSandboxInstance(this.#config.controlPlane, "daytona", ns, externalId);
        return sandbox;
      } catch {
        await deleteSandboxInstance("daytona", ns).catch(() => {});
      }
    }
    const sandbox = await this.#create(client, await daytonaCreateOptions(this.#config, request, true));
    if (await claimSandboxInstance("daytona", ns, sandbox.id)) {
      await upsertSandboxInstance(this.#config.controlPlane, "daytona", ns, sandbox.id);
      return sandbox;
    }
    // Lost a concurrent create race: discard our duplicate and reconnect to the
    // sandbox the winner recorded.
    const winner = await getSandboxExternalId("daytona", ns);
    await sandbox.delete().catch(() => {});
    if (!winner) throw new Error("failed to reserve daytona sandbox (lost create race)");
    return this.#reconnect(client, winner);
  }

  async #jobContext(request: SandboxJobRequest): Promise<{ sandbox: Sandbox; jobsDir: string }> {
    const key = sandboxReservationKey(request);
    if (!key) throw new Error("job operations require a persistent sandbox reservation key");
    const externalId = await getSandboxExternalId("daytona", key);
    if (!externalId) throw new Error("no reserved daytona sandbox for this workspace");
    const sandbox = await this.#reconnect(new Daytona(daytonaClientOptions(this.#config)), externalId);
    return { sandbox, jobsDir: this.#jobsDir(key) };
  }

  async #create(client: Daytona, options: Record<string, unknown>): Promise<Sandbox> {
    try {
      return await client.create(options);
    } catch (err) {
      if (isNoRunnersError(err)) {
        const snapshot = configString(isPlainObject(this.#config.options) ? this.#config.options.snapshot : undefined);
        throw new Error(
          `Daytona has no available runner for ${snapshot ? `snapshot '${snapshot}'` : "the request"} in the ` +
          `selected region. The snapshot may be non-general (pinned to one runner) or the runner is at capacity — ` +
          `rebuild it as a general snapshot or retry.`,
        );
      }
      throw err;
    }
  }

  async #reconnect(client: Daytona, externalId: string): Promise<Sandbox> {
    const sandbox = await client.get(externalId);
    const state = String(sandbox.state ?? "");
    if (state && state !== "started" && state !== "starting") {
      await sandbox.start();
    }
    return sandbox;
  }

  async #shell(sandbox: Sandbox, code: string): Promise<string> {
    const response = await sandbox.process.executeCommand(code);
    return response.result ?? artifactStdout(response.artifacts);
  }

  async #runLifecycle(sandbox: Sandbox, workDir: string): Promise<void> {
    const script = lifecycleScript(workDir, this.#config.onCreate, this.#config.onResume);
    if (!script) return;
    const response = await sandbox.process.executeCommand(script);
    if ((response.exitCode ?? 0) !== 0) {
      throw new Error(response.result ?? artifactStdout(response.artifacts) ?? "daytona lifecycle hook failed");
    }
  }
}

function daytonaClientOptions(config: SandboxExecutorConfig): Record<string, unknown> {
  const options = isPlainObject(config.options) ? config.options : {};
  const customApiUrl = configString(options.apiUrl);
  if (customApiUrl) {
    assertSafeTenantProviderUrl(customApiUrl, "config.options.apiUrl");
  }
  const customApiKey = configString(options.apiKey);
  if (customApiUrl && !customApiKey) {
    throw new Error("config.options.apiKey is required when config.options.apiUrl is set");
  }
  const apiKey = customApiKey ?? optionalEnv("DAYTONA_API_KEY");
  const organizationId = configString(options.organizationId) ?? optionalEnv("DAYTONA_ORGANIZATION_ID");
  const apiUrl = customApiUrl ?? optionalEnv("DAYTONA_API_URL");
  const target = configString(options.target) ?? optionalEnv("DAYTONA_TARGET");
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(apiUrl ? { apiUrl } : {}),
    ...(target ? { target } : {}),
  };
}

async function daytonaCreateOptions(
  config: SandboxExecutorConfig,
  request: { namespace?: string; envVars?: Record<string, string> },
  persistent: boolean,
): Promise<Record<string, unknown>> {
  const options = isPlainObject(config.options) ? config.options : {};
  const baseEnv = { ...(isStringRecord(config.envVars) ? config.envVars : {}), ...(request.envVars ?? {}) };
  const envVars = await daytonaEnvVars(config, request, baseEnv);
  // Persistent: auto-stop on idle (filesystem persists, harness restarts on next
  // call); auto-delete after the grace if it stays stopped (leak backstop).
  const lifecycle = resolveSandboxLifecycle(config.lifecycle);
  const autoStopMinutes = Math.max(1, Math.round(lifecycle.idleTimeoutSeconds / 60));
  const autoDeleteMinutes = Math.max(1, Math.round((lifecycle.maxLifetimeSeconds ?? DEFAULT_RELEASE_GRACE_SECONDS) / 60));
  return {
    language: "typescript",
    ...(configString(options.snapshot) ? { snapshot: configString(options.snapshot) } : {}),
    ...(configString(options.image) ? { image: configString(options.image) } : {}),
    ...(Object.keys(envVars).length > 0 ? { envVars } : {}),
    ...daytonaNetworkOptions(config),
    ...(persistent ? { autoStopInterval: autoStopMinutes, autoDeleteInterval: autoDeleteMinutes } : {}),
  };
}

function daytonaNetworkOptions(config: SandboxExecutorConfig): Record<string, unknown> {
  const network = config.network ?? { mode: "deny-all" as const };
  if (network.mode === "allow-all") {
    return { networkBlockAll: false };
  }
  if (network.mode === "deny-all") {
    return { networkBlockAll: true };
  }
  if ((network.allowDomains?.length ?? 0) > 0) {
    logWarn("daytona sandbox ignores restricted network domain allowlist; only CIDRs are enforced", {
      allowDomains: network.allowDomains?.length ?? 0,
    });
  }
  return {
    networkBlockAll: true,
    ...((network.allowCidrs?.length ?? 0) > 0 ? { networkAllowList: network.allowCidrs!.join(",") } : {}),
  };
}

// Resolve the S3 mount credentials (+ region) into the sandbox env at create time.
// Daytona's mount-s3 runs via `sudo -E` and reads creds from the process env. The
// shared resolver hands back short-lived, prefix-scoped assume-role creds (the
// developer's bring-your-own-bucket role, or the platform role); a store with no
// role falls back to whatever static keys the account itself supplied. The harness's
// own broad runtime creds must never land here — agent code can read the env.
async function daytonaEnvVars(
  config: SandboxExecutorConfig,
  request: { namespace?: string },
  baseEnv: Record<string, string>,
): Promise<Record<string, string>> {
  const options = isPlainObject(config.options) ? config.options : {};
  if (options.mountAwsS3Buckets !== true) {
    return baseEnv;
  }
  const mount = await resolveS3Mount(daytonaS3Context(config, request));
  return {
    ...baseEnv,
    ...(mount.credentials ?? staticAwsKeys(baseEnv)),
    ...(mount.region ? { AWS_REGION: mount.region, AWS_DEFAULT_REGION: mount.region } : {}),
  };
}

// Build the shared-resolver context from the executor options + env fallbacks.
// Throws on a missing namespace before any STS call (the create path hits this first).
function daytonaS3Context(config: SandboxExecutorConfig, request: { namespace?: string }): S3MountContext {
  const options = isPlainObject(config.options) ? config.options : {};
  if (!request.namespace) {
    throw new Error("Daytona AWS S3 mounts require a workspace namespace.");
  }
  return {
    storage: config.storage,
    namespace: request.namespace,
    managedBucket: configString(options.workspaceBucketName) ?? optionalEnv("FILESYSTEM_BUCKET_NAME"),
    region: configString(options.awsRegion) ?? optionalEnv("AWS_REGION") ?? optionalEnv("AWS_DEFAULT_REGION"),
    ...(configString(options.s3Endpoint) ? { endpoint: configString(options.s3Endpoint) } : {}),
  };
}

// Static keys the account supplied itself, for a store with no role configured.
// The scoped mount role is preferred; these are only the fallback.
function staticAwsKeys(env: Record<string, string>): Record<string, string> {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "Daytona AWS S3 mounts require SANDBOX_MOUNT_ROLE_ARN in the harness runtime or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in sandbox envVars.",
    );
  }
  return {
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    ...(env.AWS_SESSION_TOKEN ? { AWS_SESSION_TOKEN: env.AWS_SESSION_TOKEN } : {}),
  };
}

async function mountAwsS3Buckets(
  sandbox: Sandbox,
  request: { workspaceRoot?: string; namespace?: string },
  config: SandboxExecutorConfig,
): Promise<void> {
  const options = isPlainObject(config.options) ? config.options : {};
  if (options.mountAwsS3Buckets !== true) {
    return;
  }
  // Identity only (no STS): the create path already assumed the role into the env.
  const identity = resolveS3MountIdentity(daytonaS3Context(config, request));
  const workspaceRoot = (request.workspaceRoot ?? "/mnt/workspaces").replace(/\/+$/, "");
  await mountS3Bucket(sandbox, identity, `${workspaceRoot}/${request.namespace}`);

  if (configString(options.skillsBucketName) || optionalEnv("SKILLS_BUCKET_NAME")) {
    logWarn("Daytona skills bucket mount skipped; selected skills are staged into the workspace bucket instead");
  }
}

/**
 * Mounts an S3 bucket into the sandbox with full read/write permissions, reading
 * creds from the process env (set at create time, preserved through `sudo -E`).
 * Idempotent: skips the mount when the path is already a mountpoint (a restarted
 * persistent sandbox keeps its filesystem but loses FUSE mounts).
 */
async function mountS3Bucket(sandbox: Sandbox, mount: S3MountIdentity, mountPath: string): Promise<void> {
  await executeDaytonaSetupCommand(sandbox, `sudo mkdir -p ${shellQuote(mountPath)}`);
  await executeDaytonaSetupCommand(sandbox, `sudo chown "$(id -u)":"$(id -g)" ${shellQuote(mountPath)}`);
  const mountArgs = [
    "--allow-delete",
    "--allow-overwrite",
    "--allow-other",
    ...(mount.prefix ? ["--prefix", mount.prefix] : []),
    ...(mount.region ? ["--region", mount.region] : []),
    ...(mount.endpoint ? ["--endpoint-url", mount.endpoint] : []),
    mount.bucket,
    mountPath,
  ].map(shellQuote).join(" ");
  await executeDaytonaSetupCommand(
    sandbox,
    `mountpoint -q ${shellQuote(mountPath)} || sudo -E mount-s3 --uid "$(id -u)" --gid "$(id -g)" ${mountArgs}`,
  );
}

async function executeDaytonaSetupCommand(sandbox: Sandbox, command: string): Promise<void> {
  const response = await sandbox.process.executeCommand(command);
  if ((response.exitCode ?? 0) !== 0) {
    throw new Error(`Daytona setup command failed: ${command}\n${response.result ?? ""}`);
  }
}

function artifactStdout(artifacts: unknown): string {
  return isPlainObject(artifacts) && typeof artifacts.stdout === "string" ? artifacts.stdout : "";
}
