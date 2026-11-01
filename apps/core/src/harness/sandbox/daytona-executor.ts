import { randomUUID } from "node:crypto";
import { Daytona, type Sandbox } from "@daytona/sdk";
import { upsertSandboxInstance } from "../../shared/convex/sandbox-instances.ts";
import { optionalEnv } from "../../shared/env.ts";
import { assertPublicHttpsUrl } from "../../shared/http.ts";
import { logWarn } from "../../shared/log.ts";
import { isPlainObject } from "../../shared/object.ts";
import type { SandboxSpecs } from "../../shared/sandbox-sizes.ts";
import {
  DEFAULT_RELEASE_GRACE_SECONDS,
  MAX_CONCURRENT_BACKGROUND_JOBS,
  resolveSandboxLifecycle,
} from "../../shared/sandbox.ts";
import {
  claimSandboxInstance,
  deleteSandboxInstance,
  getSandboxExternalId,
  saveSandboxInstance,
} from "./instance-store.ts";
import {
  callbackEnv,
  generateJobId,
  launchScript,
  lifecycleScript,
  logsScript,
  parseJobStatus,
  statusScript,
  stopScript,
} from "./jobs.ts";
import {
  type S3MountIdentity,
  executorS3Context,
  resolveS3Mount,
  resolveS3MountIdentity,
} from "./s3-mount.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxJobHandle,
  SandboxJobLogs,
  SandboxJobRequest,
  SandboxJobStatus,
  SandboxReleaseRequest,
  SandboxReservationRef,
  SandboxRunRequest,
  SandboxRunResult,
  SandboxSnapshotResult,
} from "./types.ts";
import {
  assertSnapshotBootable,
  configString,
  isNoRunnersError,
  isSandboxGoneError,
  mergeSandboxEnv,
  meterEphemeralSandbox,
  SandboxCapacityError,
  sandboxReservationKey,
  shellQuote,
  truncateText,
  workspacePath,
} from "./utils.ts";

const SNAPSHOT_TIMEOUT_SECONDS = 300;

export class DaytonaSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;

  constructor(config: SandboxExecutorConfig) {
    this.#config = config;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const persistent = this.#persistent(request);
    const sandbox = await this.#acquire(request);
    const endMeter = persistent
      ? undefined
      : meterEphemeralSandbox(
          this.#config.controlPlane,
          "daytona",
          sandbox.id,
          request.metadata,
          () => daytonaSpecs(sandbox),
        );

    try {
      await mountAwsS3Buckets(sandbox, request, this.#config);
      if (persistent) {
        await this.#runLifecycle(
          sandbox,
          this.#workDir(sandboxReservationKey(request)!),
        );
      }
      const response = await sandbox.process.executeCommand(
        request.code,
        workspacePath(request),
        // Per exec too: create options never reach a reconnected sandbox, nor would an edited env.
        this.#execEnvVars(request),
        request.timeoutSeconds,
      );
      const stdout = truncateText(
        response.result ?? artifactStdout(response.artifacts),
        request.outputLimitBytes,
      );

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
      if (!persistent) {
        await sandbox.delete();
        endMeter?.();
      }
    }
  }

  async runBackground(request: SandboxRunRequest): Promise<SandboxJobHandle> {
    const ns = this.#requirePersistent(request);
    const sandbox = await this.#acquire(request);
    await mountAwsS3Buckets(sandbox, request, this.#config);
    await this.#runLifecycle(sandbox, this.#workDir(ns));
    const jobId = request.jobId ?? generateJobId();
    const script = launchScript(
      this.#jobsDir(ns),
      jobId,
      this.#workDir(ns),
      request.code,
      {
        maxConcurrentJobs: MAX_CONCURRENT_BACKGROUND_JOBS,
        ...(request.callback ? { callback: request.callback } : {}),
      },
    );
    const response = await sandbox.process.executeCommand(
      script,
      undefined,
      callbackEnv(request.callback),
    );
    if ((response.exitCode ?? 0) !== 0) {
      throw new Error(
        response.result ??
          artifactStdout(response.artifacts) ??
          "failed to launch background job",
      );
    }

    return { jobId: jobId, externalId: sandbox.id };
  }

  async jobStatus(request: SandboxJobRequest): Promise<SandboxJobStatus> {
    const { sandbox, jobsDir } = await this.#reserved(request);

    return parseJobStatus(
      request.jobId,
      await this.#shell(sandbox, statusScript(jobsDir, request.jobId)),
    );
  }

  async jobLogs(request: SandboxJobRequest): Promise<SandboxJobLogs> {
    const bytes = request.outputLimitBytes ?? 64 * 1024;
    const { sandbox, jobsDir } = await this.#reserved(request);
    const logs = truncateText(
      await this.#shell(sandbox, logsScript(jobsDir, request.jobId, bytes)),
      bytes,
    );

    return {
      jobId: request.jobId,
      logs: logs.value,
      truncated: logs.truncated,
    };
  }

  async stopJob(request: SandboxJobRequest): Promise<SandboxJobStatus> {
    const { sandbox, jobsDir } = await this.#reserved(request);
    await this.#shell(sandbox, stopScript(jobsDir, request.jobId));

    return parseJobStatus(
      request.jobId,
      await this.#shell(sandbox, statusScript(jobsDir, request.jobId)),
    );
  }

  async release(request: SandboxReleaseRequest): Promise<void> {
    const key = sandboxReservationKey(request);
    if (!key) return;
    const externalId =
      request.expectedExternalId ??
      (await getSandboxExternalId("daytona", key));
    if (!externalId) return;
    try {
      const sandbox = await new Daytona(daytonaClientOptions(this.#config)).get(
        externalId,
      );
      await sandbox.delete();
    } catch (err) {
      // Only a gone sandbox is forgotten; wrong creds throw so the caller tries its next config.
      if (!isSandboxGoneError(err)) throw err;
    }
    await deleteSandboxInstance(
      "daytona",
      key,
      this.#config.controlPlane?.accountId,
      externalId,
    ).catch(() => {});
  }

  async snapshot(
    request: SandboxReservationRef,
  ): Promise<SandboxSnapshotResult> {
    // Names are unique per Daytona org; the account's own name for it stays in the snapshot row.
    const name = `broods-${randomUUID()}`;
    const { sandbox } = await this.#reserved(request);
    await sandbox.createSnapshot(name, SNAPSHOT_TIMEOUT_SECONDS);

    return { snapshotId: name };
  }

  #persistent(request: {
    namespace?: string;
    reservationKey?: string;
  }): boolean {
    return this.#config.persistent === true && !!sandboxReservationKey(request);
  }

  #requirePersistent(request: {
    namespace?: string;
    reservationKey?: string;
  }): string {
    if (!this.#persistent(request)) {
      throw new Error(
        "background jobs require a persistent daytona sandbox reservation key",
      );
    }

    return sandboxReservationKey(request)!;
  }

  #workspaceRoot(): string {
    const options = isPlainObject(this.#config.options)
      ? this.#config.options
      : {};

    return (configString(options.workspaceRoot) ?? "/mnt/workspaces").replace(
      /\/+$/,
      "",
    );
  }

  #workDir(namespace: string): string {
    return `${this.#workspaceRoot()}/${namespace}`;
  }

  // Beside the S3 mount, not under it, so the markers stay on the native, stop-persistent disk.
  #jobsDir(reservationKey: string): string {
    return `${this.#workspaceRoot()}/.fp-jobs/${reservationKey}`;
  }

  async #acquire(request: SandboxRunRequest): Promise<Sandbox> {
    const client = new Daytona(daytonaClientOptions(this.#config));
    if (!this.#persistent(request)) {
      return this.#create(
        client,
        await daytonaCreateOptions(this.#config, request, false),
      );
    }
    const ns = sandboxReservationKey(request)!;
    const externalId = await getSandboxExternalId("daytona", ns);
    if (externalId) {
      try {
        const sandbox = await this.#reconnect(client, externalId);
        await saveSandboxInstance(
          "daytona",
          ns,
          externalId,
          this.#config.controlPlane?.accountId,
        ).catch(() => {});
        await upsertSandboxInstance(
          this.#config.controlPlane,
          "daytona",
          ns,
          externalId,
          request.metadata,
          { specs: daytonaSpecs(sandbox) },
        );

        return sandbox;
      } catch (error) {
        // Recreate only when really gone: a transient error would orphan the live sandbox.
        if (!isSandboxGoneError(error)) throw error;
        await deleteSandboxInstance(
          "daytona",
          ns,
          this.#config.controlPlane?.accountId,
          externalId,
        ).catch(() => {});
      }
    }
    const sandbox = await this.#create(
      client,
      await daytonaCreateOptions(this.#config, request, true),
    );
    try {
      if (
        await claimSandboxInstance(
          "daytona",
          ns,
          sandbox.id,
          this.#config.controlPlane?.accountId,
        )
      ) {
        await upsertSandboxInstance(
          this.#config.controlPlane,
          "daytona",
          ns,
          sandbox.id,
          request.metadata,
          { specs: daytonaSpecs(sandbox) },
        );

        return sandbox;
      }
    } catch (error) {
      // The claim may have committed though it rejected: undo both sides, conditionally.
      await Promise.allSettled([
        sandbox.delete(),
        deleteSandboxInstance(
          "daytona",
          ns,
          this.#config.controlPlane?.accountId,
          sandbox.id,
        ),
      ]);
      throw error;
    }
    const winner = await getSandboxExternalId("daytona", ns);
    await sandbox.delete().catch(() => {});
    if (!winner)
      throw new Error("failed to reserve daytona sandbox (lost create race)");

    return this.#reconnect(client, winner);
  }

  #execEnvVars(request: SandboxRunRequest): Record<string, string> | undefined {
    const env = mergeSandboxEnv(
      this.#config.envVars,
      request.envVars,
      request.principal,
    );

    return Object.keys(env).length > 0 ? env : undefined;
  }

  async #reserved(
    request: SandboxReservationRef,
  ): Promise<{ sandbox: Sandbox; jobsDir: string }> {
    const key = sandboxReservationKey(request);
    if (!key)
      throw new Error("a persistent sandbox reservation key is required");
    const externalId = await getSandboxExternalId("daytona", key);
    if (!externalId)
      throw new Error("no reserved daytona sandbox for this reservation");
    const sandbox = await this.#reconnect(
      new Daytona(daytonaClientOptions(this.#config)),
      externalId,
    );

    return { sandbox: sandbox, jobsDir: this.#jobsDir(key) };
  }

  async #create(
    client: Daytona,
    options: Record<string, unknown>,
  ): Promise<Sandbox> {
    try {
      return await client.create(options);
    } catch (err) {
      if (isNoRunnersError(err)) {
        const snapshot = this.#config.snapshot;
        throw new SandboxCapacityError(
          `Daytona has no available runner for ${snapshot ? `snapshot '${snapshot}'` : "the request"} in the ` +
            `selected region. The snapshot may be non-general (pinned to one runner) or the runner is at capacity. ` +
            `Rebuild it as a general snapshot or retry.`,
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
    const script = lifecycleScript(
      workDir,
      this.#config.onCreate,
      this.#config.onResume,
    );
    if (!script) return;
    const response = await sandbox.process.executeCommand(script);
    if ((response.exitCode ?? 0) !== 0) {
      throw new Error(
        response.result ??
          artifactStdout(response.artifacts) ??
          "daytona lifecycle hook failed",
      );
    }
  }
}

function artifactStdout(artifacts: unknown): string {
  return isPlainObject(artifacts) && typeof artifacts.stdout === "string"
    ? artifacts.stdout
    : "";
}

function daytonaClientOptions(
  config: SandboxExecutorConfig,
): Record<string, unknown> {
  const options = isPlainObject(config.options) ? config.options : {};
  const customApiUrl = configString(options.apiUrl);
  if (customApiUrl) {
    assertPublicHttpsUrl(customApiUrl, "config.options.apiUrl");
  }
  const customApiKey = configString(options.apiKey);
  if (customApiUrl && !customApiKey) {
    throw new Error(
      "config.options.apiKey is required when config.options.apiUrl is set",
    );
  }
  const apiKey = customApiKey ?? optionalEnv("DAYTONA_API_KEY");
  const organizationId =
    configString(options.organizationId) ??
    optionalEnv("DAYTONA_ORGANIZATION_ID");
  const apiUrl = customApiUrl ?? optionalEnv("DAYTONA_API_URL");
  const target = configString(options.target) ?? optionalEnv("DAYTONA_TARGET");

  return {
    ...(apiKey ? { apiKey: apiKey } : {}),
    ...(organizationId ? { organizationId: organizationId } : {}),
    ...(apiUrl ? { apiUrl: apiUrl } : {}),
    ...(target ? { target: target } : {}),
  };
}

async function daytonaCreateOptions(
  config: SandboxExecutorConfig,
  request: Pick<SandboxRunRequest, "namespace" | "envVars" | "metadata">,
  persistent: boolean,
): Promise<Record<string, unknown>> {
  const options = isPlainObject(config.options) ? config.options : {};
  await assertSnapshotBootable(config.controlPlane, config.snapshot);
  // No run identity: the sandbox outlives this run, and each exec lays its own over this env.
  const baseEnv = mergeSandboxEnv(config.envVars, request.envVars);
  const envVars = await daytonaEnvVars(config, request, baseEnv);
  const lifecycle = resolveSandboxLifecycle(config.lifecycle);
  const autoStopMinutes = Math.max(
    1,
    Math.round(lifecycle.idleTimeoutSeconds / 60),
  );
  const autoDeleteMinutes = Math.max(
    1,
    Math.round(
      (lifecycle.maxLifetimeSeconds ?? DEFAULT_RELEASE_GRACE_SECONDS) / 60,
    ),
  );

  return {
    language: "typescript",
    ...(config.snapshot ? { snapshot: config.snapshot } : {}),
    ...(configString(options.image)
      ? { image: configString(options.image) }
      : {}),
    ...(Object.keys(envVars).length > 0 ? { envVars: envVars } : {}),
    ...daytonaNetworkOptions(config),
    ...(persistent
      ? {
          autoStopInterval: autoStopMinutes,
          autoDeleteInterval: autoDeleteMinutes,
        }
      : {}),
  };
}

// mount-s3 runs under `sudo -E` and reads creds from the env, which agent code reads too: only
// the resolver's short-lived, prefix-scoped creds go here, never the harness's own.
async function daytonaEnvVars(
  config: SandboxExecutorConfig,
  request: Pick<SandboxRunRequest, "namespace" | "metadata">,
  baseEnv: Record<string, string>,
): Promise<Record<string, string>> {
  const options = isPlainObject(config.options) ? config.options : {};
  if (options.mountAwsS3Buckets !== true) {
    return baseEnv;
  }
  const mount = await resolveS3Mount(executorS3Context(config, request));

  return {
    ...baseEnv,
    ...(mount.credentials ?? staticAwsKeys(baseEnv)),
    ...(mount.region
      ? { AWS_REGION: mount.region, AWS_DEFAULT_REGION: mount.region }
      : {}),
  };
}

function daytonaNetworkOptions(
  config: SandboxExecutorConfig,
): Record<string, unknown> {
  const network = config.network ?? { mode: "deny-all" as const };
  if (network.mode === "allow-all") {
    return { networkBlockAll: false };
  }
  if (network.mode === "deny-all") {
    return { networkBlockAll: true };
  }
  if ((network.allowDomains?.length ?? 0) > 0) {
    logWarn(
      "daytona sandbox ignores restricted network domain allowlist; only CIDRs are enforced",
      {
        allowDomains: network.allowDomains?.length ?? 0,
      },
    );
  }

  return {
    networkBlockAll: true,
    ...((network.allowCidrs?.length ?? 0) > 0
      ? { networkAllowList: network.allowCidrs!.join(",") }
      : {}),
  };
}

// Daytona reports memory and disk in GiB.
function daytonaSpecs(sandbox: Sandbox): SandboxSpecs {
  return {
    vcpu: sandbox.cpu,
    memoryMb: sandbox.memory * 1024,
    storageGb: sandbox.disk,
  };
}

async function executeDaytonaSetupCommand(
  sandbox: Sandbox,
  command: string,
): Promise<void> {
  const response = await sandbox.process.executeCommand(command);
  if ((response.exitCode ?? 0) !== 0) {
    throw new Error(
      `Daytona setup command failed: ${command}\n${response.result ?? ""}`,
    );
  }
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
  // Identity only, no STS: the create path already put the assumed role's creds in the env.
  const identity = resolveS3MountIdentity(executorS3Context(config, request));
  const workspaceRoot = (request.workspaceRoot ?? "/mnt/workspaces").replace(
    /\/+$/,
    "",
  );
  await mountS3Bucket(
    sandbox,
    identity,
    `${workspaceRoot}/${request.namespace}`,
  );

  if (
    configString(options.skillsBucketName) ||
    optionalEnv("SKILLS_BUCKET_NAME")
  ) {
    logWarn(
      "Daytona skills bucket mount skipped; selected skills are staged into the workspace bucket instead",
    );
  }
}

// Every call: a restarted sandbox keeps its disk but loses its FUSE mounts.
async function mountS3Bucket(
  sandbox: Sandbox,
  mount: S3MountIdentity,
  mountPath: string,
): Promise<void> {
  await executeDaytonaSetupCommand(
    sandbox,
    `sudo mkdir -p ${shellQuote(mountPath)}`,
  );
  await executeDaytonaSetupCommand(
    sandbox,
    `sudo chown "$(id -u)":"$(id -g)" ${shellQuote(mountPath)}`,
  );
  const mountArgs = [
    "--allow-delete",
    "--allow-overwrite",
    "--allow-other",
    ...(mount.prefix ? ["--prefix", mount.prefix] : []),
    ...(mount.region ? ["--region", mount.region] : []),
    ...(mount.endpoint ? ["--endpoint-url", mount.endpoint] : []),
    mount.bucket,
    mountPath,
  ]
    .map(shellQuote)
    .join(" ");
  await executeDaytonaSetupCommand(
    sandbox,
    `mountpoint -q ${shellQuote(mountPath)} || sudo -E mount-s3 --uid "$(id -u)" --gid "$(id -g)" ${mountArgs}`,
  );
}

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
    ...(env.AWS_SESSION_TOKEN
      ? { AWS_SESSION_TOKEN: env.AWS_SESSION_TOKEN }
      : {}),
  };
}
