/**
 * Daytona-backed sandbox executor.
 * Keep Daytona SDK adaptation here. A real VM: mount the workspace, then run the
 * bash `code` as-is. Persistent mode reserves one sandbox per workspace,
 * reconnecting by stored id (Daytona auto-stops it on idle; the harness restarts it).
 */

import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { optionalEnv } from "../../_shared/env.ts";
import { logWarn } from "../../_shared/log.ts";
import { DEFAULT_RELEASE_GRACE_SECONDS, MAX_CONCURRENT_BACKGROUND_JOBS, WORKSPACE_MOUNT_PREFIX, resolveSandboxLifecycle } from "../../_shared/sandbox.ts";
import { Daytona, type Sandbox } from "@daytona/sdk";
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
import { configString, isRecordObject, isSandboxGoneError, isStringRecord, sandboxReservationKey, shellQuote, truncateText, workspacePath } from "./utils.ts";
import { generateJobId, launchScript, lifecycleScript, logsScript, parseJobStatus, statusScript, stopScript } from "./jobs.ts";
import { claimSandboxInstance, deleteSandboxInstance, getSandboxExternalId, saveSandboxInstance } from "./instance-store.ts";

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
    const options = isRecordObject(this.#config.options) ? this.#config.options : {};
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
      return client.create(await daytonaCreateOptions(this.#config, request, false));
    }
    const ns = sandboxReservationKey(request)!;
    const externalId = await getSandboxExternalId("daytona", ns);
    if (externalId) {
      try {
        const sandbox = await this.#reconnect(client, externalId);
        await saveSandboxInstance("daytona", ns, externalId).catch(() => {});
        return sandbox;
      } catch {
        await deleteSandboxInstance("daytona", ns).catch(() => {});
      }
    }
    const sandbox = await client.create(await daytonaCreateOptions(this.#config, request, true));
    if (await claimSandboxInstance("daytona", ns, sandbox.id)) {
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
  const options = isRecordObject(config.options) ? config.options : {};
  const apiKey = configString(options.apiKey) ?? optionalEnv("DAYTONA_API_KEY");
  const organizationId = configString(options.organizationId) ?? optionalEnv("DAYTONA_ORGANIZATION_ID");
  const apiUrl = configString(options.apiUrl) ?? optionalEnv("DAYTONA_API_URL");
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
  const options = isRecordObject(config.options) ? config.options : {};
  const baseEnv = { ...(isStringRecord(config.envVars) ? config.envVars : {}), ...(request.envVars ?? {}) };
  const envVars = await daytonaEnvVars(baseEnv, options, request.namespace);
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

async function daytonaEnvVars(
  userEnv: Record<string, string>,
  options: Record<string, unknown>,
  namespace: string | undefined,
): Promise<Record<string, string>> {
  const envVars = { ...userEnv };
  if (options.mountAwsS3Buckets !== true) {
    return envVars;
  }

  const credentials = await awsCredentialEnvVars(envVars, namespace);
  const region = configString(options.awsRegion) ?? optionalEnv("AWS_REGION") ?? optionalEnv("AWS_DEFAULT_REGION");
  return {
    ...envVars,
    ...credentials,
    ...(region ? { AWS_REGION: region, AWS_DEFAULT_REGION: region } : {}),
  };
}

// Sandbox env vars are readable by any code the agent runs, so the harness's
// own runtime credentials must never land there. Use the scoped mount role
// when deployed, otherwise only credentials the account supplied itself.
async function awsCredentialEnvVars(
  envVars: Record<string, string>,
  namespace: string | undefined,
): Promise<Record<string, string>> {
  const roleArn = optionalEnv("SANDBOX_MOUNT_ROLE_ARN");
  if (roleArn) {
    return assumeScopedMountCredentials(roleArn, namespace);
  }

  const accessKeyId = envVars.AWS_ACCESS_KEY_ID;
  const secretAccessKey = envVars.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "Daytona AWS S3 mounts require SANDBOX_MOUNT_ROLE_ARN in the harness runtime or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in sandbox envVars.",
    );
  }

  return {
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    ...(envVars.AWS_SESSION_TOKEN ? { AWS_SESSION_TOKEN: envVars.AWS_SESSION_TOKEN } : {}),
  };
}

// The role policy already limits access to the workspace/skills buckets; the
// session policy narrows the workspace bucket further to this sandbox's own
// namespace prefix.
async function assumeScopedMountCredentials(
  roleArn: string,
  namespace: string | undefined,
): Promise<Record<string, string>> {
  const workspaceBucket = optionalEnv("FILESYSTEM_BUCKET_NAME");
  const skillsBucket = optionalEnv("SKILLS_BUCKET_NAME");
  const prefix = namespace ? `${WORKSPACE_MOUNT_PREFIX}/${namespace}/` : undefined;
  const statements = workspaceBucket && prefix
    ? [
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
        Resource: [`arn:aws:s3:::${workspaceBucket}/${prefix}*`],
      },
      {
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [`arn:aws:s3:::${workspaceBucket}`],
        Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } },
      },
      ...(skillsBucket
        ? [{
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:ListBucket"],
          Resource: [`arn:aws:s3:::${skillsBucket}`, `arn:aws:s3:::${skillsBucket}/*`],
        }]
        : []),
    ]
    : undefined;

  const result = await new STSClient({}).send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: "fp-sandbox-mount",
    DurationSeconds: 3600,
    ...(statements ? { Policy: JSON.stringify({ Version: "2012-10-17", Statement: statements }) } : {}),
  }));
  const credentials = result.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
    throw new Error("Failed to assume the sandbox S3 mount role");
  }

  return {
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken,
  };
}

async function mountAwsS3Buckets(
  sandbox: Sandbox,
  request: { workspaceRoot?: string; namespace?: string },
  config: SandboxExecutorConfig,
): Promise<void> {
  const options = isRecordObject(config.options) ? config.options : {};
  if (options.mountAwsS3Buckets !== true) {
    return;
  }

  const workspaceBucketName = configString(options.workspaceBucketName) ?? optionalEnv("FILESYSTEM_BUCKET_NAME");
  if (!workspaceBucketName) {
    throw new Error(
      "Daytona AWS S3 workspace mount requires config.options.workspaceBucketName or FILESYSTEM_BUCKET_NAME.",
    );
  }
  if (!request.namespace) {
    throw new Error("Daytona AWS S3 workspace mount requires a workspace namespace.");
  }

  const workspaceRoot = (request.workspaceRoot ?? "/mnt/workspaces").replace(/\/+$/, "");
  const workspaceMountPath = `${workspaceRoot}/${request.namespace}`;
  // Mount only the workspace key prefix so paths line up with the harness and the
  // Lambda provider's S3 Files access point (see workspaceNamespacePrefix).
  await mountS3Bucket(
    sandbox,
    workspaceBucketName,
    workspaceMountPath,
    options,
    `${WORKSPACE_MOUNT_PREFIX}/${request.namespace}/`,
  );

  const skillsBucketName = configString(options.skillsBucketName) ?? optionalEnv("SKILLS_BUCKET_NAME");
  if (!skillsBucketName) {
    return;
  }

  const skillsMountPath = configString(options.skillsMountPath) ?? "/mnt/skills";
  await mountS3Bucket(sandbox, skillsBucketName, skillsMountPath, options);
}

/**
 * Mounts an S3 bucket into the sandbox with full read/write permissions.
 * Idempotent: skips the mount when the path is already a mountpoint (a restarted
 * persistent sandbox keeps its filesystem but loses FUSE mounts).
 */
async function mountS3Bucket(
  sandbox: Sandbox,
  bucketName: string,
  mountPath: string,
  options: Record<string, unknown>,
  keyPrefix?: string,
): Promise<void> {
  await executeDaytonaSetupCommand(sandbox, `sudo mkdir -p ${shellQuote(mountPath)}`);
  await executeDaytonaSetupCommand(sandbox, `sudo chown "$(id -u)":"$(id -g)" ${shellQuote(mountPath)}`);
  const mountArgs = [
    "--allow-delete",
    "--allow-overwrite",
    "--allow-other",
    ...(keyPrefix ? ["--prefix", keyPrefix] : []),
    ...mountRegionArgs(options),
    bucketName,
    mountPath,
  ].map(shellQuote).join(" ");
  await executeDaytonaSetupCommand(
    sandbox,
    `mountpoint -q ${shellQuote(mountPath)} || sudo -E mount-s3 --uid "$(id -u)" --gid "$(id -g)" ${mountArgs}`,
  );
}

function mountRegionArgs(options: Record<string, unknown>): string[] {
  const region = configString(options.awsRegion) ?? optionalEnv("AWS_REGION") ?? optionalEnv("AWS_DEFAULT_REGION");
  return region ? ["--region", region] : [];
}

async function executeDaytonaSetupCommand(sandbox: Sandbox, command: string): Promise<void> {
  const response = await sandbox.process.executeCommand(command);
  if ((response.exitCode ?? 0) !== 0) {
    throw new Error(`Daytona setup command failed: ${command}\n${response.result ?? ""}`);
  }
}

function artifactStdout(artifacts: unknown): string {
  return isRecordObject(artifacts) && typeof artifacts.stdout === "string" ? artifacts.stdout : "";
}
