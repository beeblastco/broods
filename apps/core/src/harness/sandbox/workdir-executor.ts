import {
  Client,
  type CreateOptions,
  type Sandbox,
  SandboxError,
} from "@mv37/workdir";
import { upsertSandboxInstance } from "../../shared/convex/sandbox-instances.ts";
import { optionalEnv } from "../../shared/env.ts";
import { toErrorMessage } from "../../shared/errors.ts";
import { assertPublicHttpsUrl } from "../../shared/http.ts";
import { waitUntil } from "../../shared/in-flight.ts";
import { logWarn } from "../../shared/log.ts";
import { isPlainObject } from "@broods/convex/model/objects";
import { stripTrailingSlashes } from "../../shared/paths.ts";
import {
  type SandboxRunMetadata,
  workdirResources,
} from "../../shared/sandbox-sizes.ts";
import {
  MAX_CONCURRENT_BACKGROUND_JOBS,
  outlivedMaxLifetime,
  resolveSandboxLifecycle,
} from "../../shared/sandbox.ts";
import {
  claimSandboxInstance,
  deleteSandboxInstance,
  getSandboxExternalId,
  getSandboxReservationRecord,
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
  type ResolvedS3Mount,
  executorS3Context,
  freshMountScript,
  mountRoleArn,
  resolveS3Mount,
  resolveS3MountIdentity,
} from "./s3-mount.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxInstanceInfo,
  SandboxJobHandle,
  SandboxJobLogs,
  SandboxJobRequest,
  SandboxJobStatus,
  SandboxNetworkConfig,
  SandboxReleaseRequest,
  SandboxReservationRef,
  SandboxRunRequest,
  SandboxRunResult,
  SandboxSnapshotResult,
} from "./types.ts";
import {
  assertSnapshotBootable,
  configuredSandboxSpecs,
  configString,
  isSandboxGoneError,
  mergeSandboxEnv,
  meterEphemeralSandbox,
  SandboxCapacityError,
  SandboxGoneError,
  sandboxReservationKey,
  shellQuote,
  truncateText,
  workspacePath,
} from "./utils.ts";

const DEFAULT_WORKSPACE_ROOT = "/mnt/workspaces";
const DEFAULT_S3_SECRET_NAMES = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];

// workdir answers an out-of-range auto_stop with a 400; clamp so a legal config still creates.
const AUTO_STOP_MIN_SECONDS = 30;
const AUTO_STOP_MAX_SECONDS = 60 * 60;

export interface WorkdirHarnessReservation {
  readonly sandbox: Sandbox;
  readonly isFirstCreate: boolean;
}

export class WorkdirSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;
  readonly #client: Client;

  constructor(config: SandboxExecutorConfig) {
    this.#config = config;
    this.#client = workdirClient(config);
  }

  // A `shared` machine survives a failed first setup; the unset onCreate marker retries it.
  async acquireHarnessReservation(request: {
    reservationKey: string;
    abortSignal?: AbortSignal;
    metadata?: SandboxRunMetadata;
    shared?: boolean;
  }): Promise<WorkdirHarnessReservation> {
    request.abortSignal?.throwIfAborted();
    if (!this.#persistent(request)) {
      throw new Error(
        "Harness sessions require a persistent workdir sandbox reservation key",
      );
    }
    const reservation = await this.#acquireWithState(request);
    try {
      await this.#runLifecycle(
        reservation.sandbox,
        this.#workDir(request.reservationKey),
      );
    } catch (error) {
      if (reservation.isFirstCreate && request.shared !== true) {
        await this.release(request).catch(() => {});
      }
      throw error;
    }
    request.abortSignal?.throwIfAborted();

    return reservation;
  }

  async resumeHarnessReservation(request: {
    reservationKey: string;
    abortSignal?: AbortSignal;
    metadata?: SandboxRunMetadata;
  }): Promise<Sandbox> {
    request.abortSignal?.throwIfAborted();
    if (!this.#persistent(request)) {
      throw new Error(
        "Harness sessions require a persistent workdir sandbox reservation key",
      );
    }
    const externalId = await getSandboxExternalId(
      "sandbox",
      request.reservationKey,
    );
    if (!externalId) {
      throw new SandboxGoneError(
        "no reserved workdir sandbox for this Harness session",
      );
    }
    const sandbox = await this.#reconnect(externalId);
    await this.#runLifecycle(sandbox, this.#workDir(request.reservationKey));
    await saveSandboxInstance(
      "sandbox",
      request.reservationKey,
      externalId,
      this.#config.controlPlane?.accountId,
      this.#config.controlPlane?.releaseAfterIdleSeconds,
    ).catch(() => {});
    void upsertSandboxInstance(
      this.#config.controlPlane,
      "sandbox",
      request.reservationKey,
      externalId,
      request.metadata,
    );
    request.abortSignal?.throwIfAborted();

    return sandbox;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const persistent = this.#persistent(request);
    const execMount = this.#s3MountStrategy(request) === "exec";
    const ephemeralMount =
      execMount && !persistent
        ? resolveS3Mount(executorS3Context(this.#config, request))
        : undefined;
    void ephemeralMount?.catch((): void => {});
    const { sandbox, isFirstCreate } = await this.#acquireWithState(request);
    const endMeter = persistent
      ? undefined
      : meterEphemeralSandbox(
          this.#config.controlPlane,
          "sandbox",
          sandbox.id,
          request.metadata,
          () => configuredSandboxSpecs(this.#config),
        );

    try {
      if (execMount)
        await this.#ensureS3Mount(
          sandbox,
          request,
          isFirstCreate,
          ephemeralMount,
        );
      if (persistent)
        await this.#runLifecycle(
          sandbox,
          this.#workDir(sandboxReservationKey(request)!),
        );
      const cwd = request.namespace
        ? workspacePath(request, this.#workspaceRoot())
        : undefined;
      // The workdir API has no exec timeout, so the command carries its own.
      const result = await sandbox.exec(
        `timeout -k 5 ${request.timeoutSeconds} bash -c ${shellQuote(request.code)}`,
        {
          ...(cwd ? { cwd: cwd } : {}),
          env: mergeSandboxEnv(
            this.#config.envVars,
            request.envVars,
            request.principal,
          ),
        },
      );
      const stdout = truncateText(
        result.stdout ?? "",
        request.outputLimitBytes,
      );
      const stderr = truncateText(
        result.stderr ?? "",
        request.outputLimitBytes,
      );

      return {
        ok: result.exit_code === 0,
        runtime: request.runtime ?? "bash",
        exitCode: result.exit_code,
        stdout: stdout.value,
        stderr: stderr.value,
        durationMs: Date.now() - startedAt,
        truncated: stdout.truncated || stderr.truncated,
        timedOut: result.exit_code === 124 || result.exit_code === 137,
        provider: "sandbox",
      };
    } finally {
      // Off the tool clock, but shutdown drains it: workdir has no TTL to reap a stranded VM.
      if (!persistent) {
        waitUntil(
          sandbox.delete().then(
            (): void => endMeter?.(),
            (error: unknown): void => {
              logWarn("workdir sandbox delete failed", {
                sandboxId: sandbox.id,
                error: toErrorMessage(error),
              });
            },
          ),
        );
      }
    }
  }

  async runBackground(request: SandboxRunRequest): Promise<SandboxJobHandle> {
    const ns = this.#requirePersistent(request);
    const { sandbox, isFirstCreate } = await this.#acquireWithState(request);
    if (this.#s3MountStrategy(request) === "exec")
      await this.#ensureS3Mount(sandbox, request, isFirstCreate);
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
    const result = await sandbox.exec(script, {
      env: {
        ...mergeSandboxEnv(this.#config.envVars, request.envVars),
        ...callbackEnv(request.callback),
      },
    });
    if (result.exit_code !== 0) {
      throw new Error(
        result.stderr || result.stdout || "failed to launch background job",
      );
    }

    return { jobId: jobId, externalId: sandbox.id };
  }

  async jobStatus(request: SandboxJobRequest): Promise<SandboxJobStatus> {
    const { sandbox, jobsDir } = await this.#jobContext(request);

    return parseJobStatus(
      request.jobId,
      await this.#shell(sandbox, statusScript(jobsDir, request.jobId)),
    );
  }

  async jobLogs(request: SandboxJobRequest): Promise<SandboxJobLogs> {
    const bytes = request.outputLimitBytes ?? 64 * 1024;
    const { sandbox, jobsDir } = await this.#jobContext(request);
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
    const { sandbox, jobsDir } = await this.#jobContext(request);
    await this.#shell(sandbox, stopScript(jobsDir, request.jobId));

    return parseJobStatus(
      request.jobId,
      await this.#shell(sandbox, statusScript(jobsDir, request.jobId)),
    );
  }

  async prewarm(request: {
    namespace?: string;
    reservationKey?: string;
  }): Promise<void> {
    if (!this.#persistent(request)) return;
    await this.#acquire(request).catch(() => {});
  }

  async suspend(request: SandboxReservationRef): Promise<void> {
    const sandbox = await this.#reserved(request);
    if (sandbox) await sandbox.pause();
  }

  async resume(request: SandboxReservationRef): Promise<void> {
    const sandbox = await this.#reserved(request);
    if (sandbox) await sandbox.resume();
  }

  async snapshot(
    request: SandboxReservationRef,
  ): Promise<SandboxSnapshotResult> {
    const sandbox = await this.#reserved(request);
    if (!sandbox)
      throw new Error(
        "no reserved workdir sandbox to snapshot for this workspace",
      );
    const data = (await sandbox.snapshot()) as Record<string, unknown>;
    const snapshotId = configString(data.id) ?? configString(data.snapshot_id);
    if (!snapshotId) throw new Error("workdir snapshot did not return an id");
    const externalImageId =
      configString(data.image_id) ?? configString(data.image);

    return {
      snapshotId: snapshotId,
      ...(externalImageId ? { externalImageId: externalImageId } : {}),
    };
  }

  async getInstanceInfo(
    request: SandboxReservationRef,
  ): Promise<SandboxInstanceInfo | null> {
    const externalId = await this.#reservedId(request);
    if (!externalId) return null;
    try {
      const sandbox = await this.#client.sandboxes.get(externalId);
      const state = mapWorkdirState(sandbox.state);

      return {
        externalId: externalId,
        state: state,
        errorMessage:
          state === "error" ? workdirRecordError(sandbox) : undefined,
      };
    } catch (err) {
      if (isSandboxGoneError(err))
        return { externalId: externalId, state: "terminating" };
      throw err;
    }
  }

  async release(request: SandboxReleaseRequest): Promise<void> {
    const key = sandboxReservationKey(request);
    if (!key) return;
    const externalId =
      request.expectedExternalId ??
      (await getSandboxExternalId("sandbox", key));
    if (!externalId) return;
    try {
      const sandbox = await this.#client.sandboxes.get(externalId);
      // workdir keeps the record of a deleted sandbox and refuses a second delete.
      if (mapWorkdirState(sandbox.state) !== "terminating")
        await sandbox.delete();
    } catch (err) {
      if (!isSandboxGoneError(err)) throw err;
    }
    await deleteSandboxInstance(
      "sandbox",
      key,
      this.#config.controlPlane?.accountId,
      externalId,
    ).catch(() => {});
  }

  #options(): Record<string, unknown> {
    return isPlainObject(this.#config.options) ? this.#config.options : {};
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
        "background jobs require a persistent workdir sandbox reservation key",
      );
    }

    return sandboxReservationKey(request)!;
  }

  #workspaceRoot(): string {
    return stripTrailingSlashes(
      configString(this.#options().workspaceRoot) ?? DEFAULT_WORKSPACE_ROOT,
    );
  }

  #workDir(namespace: string): string {
    return `${this.#workspaceRoot()}/${namespace}`;
  }

  #jobsDir(reservationKey: string): string {
    return `${this.#workspaceRoot()}/.fp-jobs/${reservationKey}`;
  }

  // `exec` passes scoped credentials per call, which workdir's org-global secrets cannot hold.
  // Keyed on namespace, not `storage`: a managed workspace carries no storage block.
  #s3MountStrategy(request: {
    namespace?: string;
  }): "none" | "exec" | "declarative" {
    if (!request.namespace && this.#options().mountAwsS3Buckets !== true)
      return "none";

    return this.#config.storage?.auth?.type === "r2" ||
      mountRoleArn(this.#config.storage)
      ? "exec"
      : "declarative";
  }

  #mountPath(request: { namespace?: string; workspaceRoot?: string }): string {
    const root = (request.workspaceRoot ?? this.#workspaceRoot()).replace(
      /\/+$/,
      "",
    );

    return `${root}/${request.namespace}`;
  }

  #s3Mounts(request: {
    namespace?: string;
    workspaceRoot?: string;
  }): CreateOptions["mounts"] | undefined {
    if (this.#s3MountStrategy(request) !== "declarative") return undefined;
    const { bucket, prefix, region, endpoint } = resolveS3MountIdentity(
      executorS3Context(this.#config, request),
    );

    return [
      {
        type: "s3",
        bucket: bucket,
        mount_path: this.#mountPath(request),
        read_only: false,
        ...(prefix ? { prefix: prefix } : {}),
        ...(region ? { region: region } : {}),
        ...(endpoint ? { endpoint: endpoint } : {}),
      },
    ];
  }

  #createOptions(
    request: { namespace?: string; workspaceRoot?: string },
    persistent: boolean,
  ): CreateOptions {
    const options = this.#options();
    const mounts = this.#s3Mounts(request);

    const startup: Record<string, unknown> = {};
    const network = workdirNetwork(this.#config.network);
    if (network) startup.network = network;
    if (mounts) startup.secrets = s3SecretNames(options);

    const image = configString(this.#config.snapshot);

    return {
      ...(workdirResources(this.#config)
        ? { resources: workdirResources(this.#config) }
        : {}),
      ...(image ? { image: image } : {}),
      ...(configString(options.imageVersion)
        ? { image_version: configString(options.imageVersion) }
        : {}),
      ...(mounts ? { mounts: mounts } : {}),
      ...(options.docker === true ? { docker: { enabled: true } } : {}),
      ...(persistent
        ? {
            auto_stop_seconds: Math.min(
              Math.max(
                resolveSandboxLifecycle(this.#config.lifecycle)
                  .idleTimeoutSeconds,
                AUTO_STOP_MIN_SECONDS,
              ),
              AUTO_STOP_MAX_SECONDS,
            ),
          }
        : {}),
      ...(Object.keys(startup).length > 0 ? { startup: startup } : {}),
    };
  }

  async #reservedId(
    request: SandboxReservationRef,
  ): Promise<string | undefined> {
    const key = sandboxReservationKey(request);
    if (!key) return undefined;

    return (await getSandboxExternalId("sandbox", key)) ?? undefined;
  }

  async #reserved(
    request: SandboxReservationRef,
  ): Promise<Sandbox | undefined> {
    const externalId = await this.#reservedId(request);

    return externalId ? this.#client.sandboxes.get(externalId) : undefined;
  }

  async #acquire(
    request:
      | SandboxRunRequest
      | { namespace?: string; reservationKey?: string },
  ): Promise<Sandbox> {
    return (await this.#acquireWithState(request)).sandbox;
  }

  async #create(options: CreateOptions): Promise<Sandbox> {
    // One workdir host serves every account, so an image id alone would boot anyone's snapshot.
    await assertSnapshotBootable(this.#config.controlPlane, options.image);
    try {
      return await this.#client.sandboxes.create(options);
    } catch (error) {
      if (
        error instanceof SandboxError &&
        (error.status === 429 || error.status === 503)
      ) {
        throw new SandboxCapacityError(error.message);
      }
      throw error;
    }
  }

  async #acquireWithState(
    request:
      | SandboxRunRequest
      | { namespace?: string; reservationKey?: string },
  ): Promise<WorkdirHarnessReservation> {
    if (!this.#persistent(request)) {
      return {
        sandbox: await this.#create(this.#createOptions(request, false)),
        isFirstCreate: true,
      };
    }
    const ns = sandboxReservationKey(request)!;
    const reserved = await getSandboxReservationRecord("sandbox", ns);
    const expired =
      reserved !== null &&
      outlivedMaxLifetime(
        resolveSandboxLifecycle(this.#config.lifecycle),
        reserved.claimedAt,
      );
    if (expired) {
      // Not caught: a failed delete would leak the old sandbox once the new one claims the key.
      await this.release({
        reservationKey: ns,
        expectedExternalId: reserved.externalId,
      });
    }
    const externalId = expired ? null : (reserved?.externalId ?? null);
    if (externalId) {
      try {
        const sandbox = await this.#reconnect(externalId);
        void saveSandboxInstance(
          "sandbox",
          ns,
          externalId,
          this.#config.controlPlane?.accountId,
          this.#config.controlPlane?.releaseAfterIdleSeconds,
        ).catch(() => {});
        void upsertSandboxInstance(
          this.#config.controlPlane,
          "sandbox",
          ns,
          externalId,
          "metadata" in request ? request.metadata : undefined,
        );

        return { sandbox: sandbox, isFirstCreate: false };
      } catch (error) {
        // Only a gone sandbox is recreated; on a transient error the live one would be orphaned.
        if (!isSandboxGoneError(error)) throw error;
        await this.release({
          reservationKey: ns,
          expectedExternalId: externalId,
        });
      }
    }
    const created = await this.#create(this.#createOptions(request, true));
    try {
      if (
        await claimSandboxInstance(
          "sandbox",
          ns,
          created.id,
          this.#config.controlPlane?.accountId,
          this.#config.controlPlane?.releaseAfterIdleSeconds,
        )
      ) {
        await upsertSandboxInstance(
          this.#config.controlPlane,
          "sandbox",
          ns,
          created.id,
          "metadata" in request ? request.metadata : undefined,
          { specs: configuredSandboxSpecs(this.#config) },
        );

        return { sandbox: created, isFirstCreate: true };
      }
    } catch (error) {
      // The claim may have committed even though it rejected.
      await Promise.allSettled([
        created.delete(),
        deleteSandboxInstance(
          "sandbox",
          ns,
          this.#config.controlPlane?.accountId,
          created.id,
        ),
      ]);
      throw error;
    }
    const winner = await getSandboxExternalId("sandbox", ns);
    await created.delete().catch((error: unknown): void => {
      logWarn("workdir sandbox delete failed", {
        sandboxId: created.id,
        error: toErrorMessage(error),
      });
    });
    if (!winner)
      throw new Error("failed to reserve workdir sandbox (lost create race)");

    return {
      sandbox: await this.#reconnect(winner),
      isFirstCreate: false,
    };
  }

  // `stopped` does not auto-resume on exec. `failed` answers 409 to all but delete, and a
  // `deleted` record to everything, so both count as gone.
  async #reconnect(externalId: string): Promise<Sandbox> {
    const sandbox = await this.#client.sandboxes.get(externalId);
    const state = mapWorkdirState(sandbox.state);
    if (state === "error" || state === "terminating") {
      const reason = workdirRecordError(sandbox);
      throw new SandboxGoneError(
        `workdir sandbox ${externalId} is ${sandbox.state}${reason ? `: ${reason}` : ""}`,
      );
    }
    if (sandbox.state === "stopped" || sandbox.state === "standby") {
      await sandbox.resume();
    }

    return sandbox;
  }

  async #jobContext(
    request: SandboxJobRequest,
  ): Promise<{ sandbox: Sandbox; jobsDir: string }> {
    const key = sandboxReservationKey(request);
    if (!key)
      throw new Error(
        "job operations require a persistent sandbox reservation key",
      );
    const externalId = await getSandboxExternalId("sandbox", key);
    if (!externalId)
      throw new Error("no reserved workdir sandbox for this workspace");

    return {
      sandbox: await this.#reconnect(externalId),
      jobsDir: this.#jobsDir(key),
    };
  }

  async #shell(sandbox: Sandbox, cmd: string): Promise<string> {
    return (await sandbox.exec(cmd)).stdout ?? "";
  }

  async #runLifecycle(sandbox: Sandbox, workDir: string): Promise<void> {
    const script = lifecycleScript(
      workDir,
      this.#config.onCreate,
      this.#config.onResume,
    );
    if (!script) return;
    const result = await sandbox.exec(script);
    if (result.exit_code !== 0) {
      throw new Error(
        result.stderr || result.stdout || "workdir lifecycle hook failed",
      );
    }
  }

  // Never the harness's own broad credentials: any code the agent runs could read them.
  async #ensureS3Mount(
    sandbox: Sandbox,
    request: Pick<
      SandboxRunRequest,
      "namespace" | "workspaceRoot" | "metadata"
    >,
    isFirstCreate: boolean,
    minted?: Promise<ResolvedS3Mount>,
  ): Promise<void> {
    const context = executorS3Context(this.#config, request);
    if (!isFirstCreate) {
      const check = await sandbox.exec(
        freshMountScript(
          this.#mountPath(request),
          Math.floor(Date.now() / 1000),
        ),
      );
      if (check.exit_code === 0) return;
    }
    await this.#mountS3(
      sandbox,
      request,
      await (minted ?? resolveS3Mount(context)),
    );
  }

  async #mountS3(
    sandbox: Sandbox,
    request: { namespace?: string; workspaceRoot?: string },
    mount: ResolvedS3Mount,
  ): Promise<void> {
    if (!mount.credentials) {
      throw new Error("workdir S3 assume-role mount resolved no credentials");
    }
    const mountPath = this.#mountPath(request);
    const mountArgs = [
      mount.bucket,
      mountPath,
      ...(mount.prefix ? ["--prefix", mount.prefix] : []),
      "--allow-delete",
      "--allow-overwrite",
      ...(mount.region ? ["--region", mount.region] : []),
      ...(mount.endpoint ? ["--endpoint-url", mount.endpoint] : []),
    ]
      .map(shellQuote)
      .join(" ");
    const quotedPath = shellQuote(mountPath);
    const now = Math.floor(Date.now() / 1000);
    const result = await sandbox.exec(
      [
        `if ! { ${freshMountScript(mountPath, now)}; }; then`,
        `fusermount -u ${quotedPath} 2>/dev/null || umount -l ${quotedPath} 2>/dev/null;`,
        `mkdir -p ${quotedPath} && mount-s3 ${mountArgs} && echo ${now} > "$stamp_file";`,
        `fi`,
      ].join("\n"),
      {
        env: {
          ...mount.credentials,
          // No IMDS in the guest; the AWS client would stall ~4s probing it on every mount.
          AWS_EC2_METADATA_DISABLED: "true",
          ...(mount.region
            ? { AWS_REGION: mount.region, AWS_DEFAULT_REGION: mount.region }
            : {}),
        },
      },
    );
    if (result.exit_code !== 0) {
      throw new Error(
        result.stderr || result.stdout || "workdir S3 workspace mount failed",
      );
    }
  }
}

export function workdirConnection(config: SandboxExecutorConfig): {
  baseUrl: string;
  apiKey: string;
} {
  const options = isPlainObject(config.options) ? config.options : {};
  const customBaseUrl = configString(options.workdirUrl);
  if (customBaseUrl) {
    assertPublicHttpsUrl(customBaseUrl, "config.options.workdirUrl");
  }
  const baseUrl = customBaseUrl ?? optionalEnv("WORKDIR_URL");
  if (!baseUrl) {
    throw new Error(
      "workdir sandbox requires config.options.workdirUrl or the WORKDIR_URL environment variable",
    );
  }
  const customApiKey = configString(options.apiKey);
  if (customBaseUrl && !customApiKey) {
    throw new Error(
      "config.options.apiKey is required when config.options.workdirUrl is set",
    );
  }

  return {
    baseUrl: baseUrl,
    apiKey: customApiKey ?? optionalEnv("WORKDIR_API_KEY") ?? "",
  };
}

export function workdirPtyUrl(baseUrl: string, externalId: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/sandboxes/${encodeURIComponent(externalId)}/pty`;

  return url.toString();
}

function workdirClient(config: SandboxExecutorConfig): Client {
  const { baseUrl, apiKey } = workdirConnection(config);

  return new Client(baseUrl, apiKey);
}

function workdirNetwork(
  network: SandboxNetworkConfig | undefined,
): Record<string, unknown> | undefined {
  if (!network) return undefined;
  if (network.mode === "allow-all") return { egress: "default" };
  if (network.mode === "deny-all") return { egress: "none" };
  const allow = [
    ...(network.allowDomains ?? []).map((value) => ({
      type: "domain",
      value: value,
    })),
    ...(network.allowCidrs ?? []),
  ];
  if (allow.length === 0) return { egress: "none" };

  return { egress: "allowlist", allow: allow };
}

function mapWorkdirState(state: unknown): SandboxInstanceInfo["state"] {
  switch (state) {
    case "running":
    case "creating":
    case "resuming":
      return "running";
    case "stopped":
    case "standby":
    case "stopping":
      return "suspended";
    case "deleting":
    case "deleted":
      return "terminating";
    case "failed":
      return "error";
    default:
      return "unknown";
  }
}

// The SDK types `data` private, and a failed sandbox's `error` in it has no getter.
function workdirRecordError(sandbox: Sandbox): string | undefined {
  const record = sandbox as unknown as { data?: { error?: unknown } };

  return configString(record.data?.error);
}

function s3SecretNames(options: Record<string, unknown>): string[] {
  const names = options.s3SecretNames;
  if (Array.isArray(names)) {
    const list = names.filter(
      (n): n is string => typeof n === "string" && n.trim().length > 0,
    );
    if (list.length > 0) return list;
  }

  return DEFAULT_S3_SECRET_NAMES;
}
