/**
 * workdir-backed sandbox executor — the vanilla `sandbox` provider.
 * Thin adapter over the published `@mv37/workdir` SDK (a self-hosted
 * Rust/Firecracker control plane) reached at a configurable base URL, so the
 * same code targets a local node while testing and a dedicated host in
 * production. A real microVM: declare an S3 workspace mount + egress policy at
 * create, then run the bash `code` as-is. Persistent mode reserves one sandbox
 * per key and uses workdir's native pause/resume + standby; snapshots capture
 * reusable images.
 *
 * S3 workspace mount (see #s3MountStrategy): the mount target + credentials come
 * from the workspace's storage config (resolveS3Mount). `exec` strategy mounts via
 * mount-s3 with short-lived assume-role credentials (a bring-your-own-bucket role,
 * or the platform role — the default when SANDBOX_MOUNT_ROLE_ARN is set);
 * `declarative` strategy declares a boot mount that reads static keys from named
 * org secrets (no role configured). Both honor an S3-compatible endpoint (R2/MinIO).
 */

import { Client, type CreateOptions, type Sandbox } from "@mv37/workdir";
import { upsertSandboxInstance } from "../../shared/convex/sandbox-instances.ts";
import { optionalEnv } from "../../shared/env.ts";
import { isPlainObject } from "../../shared/object.ts";
import { workdirSizeResources } from "../../shared/sandbox-sizes.ts";
import {
  MAX_CONCURRENT_BACKGROUND_JOBS,
  resolveSandboxLifecycle,
} from "../../shared/sandbox.ts";
import {
  claimSandboxInstance,
  deleteSandboxInstance,
  getSandboxExternalId,
  getSandboxReservedAt,
  saveSandboxInstance,
} from "./instance-store.ts";
import {
  generateJobId,
  launchScript,
  lifecycleScript,
  logsScript,
  parseJobStatus,
  statusScript,
  stopScript,
} from "./jobs.ts";
import {
  type S3MountContext,
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
  SandboxReservationRef,
  SandboxRunRequest,
  SandboxRunResult,
  SandboxSnapshotResult,
} from "./types.ts";
import {
  assertSafeTenantProviderUrl,
  configString,
  isSandboxGoneError,
  sandboxReservationKey,
  shellQuote,
  stringRecord,
  stripTrailingSlashes,
  truncateText,
  workspacePath,
} from "./utils.ts";

const DEFAULT_WORKSPACE_ROOT = "/mnt/workspaces";
const DEFAULT_S3_SECRET_NAMES = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];

// workdir rejects an out-of-range auto_stop with a 400, and the account-facing
// `idleTimeoutSeconds` allows far more than it accepts (up to MAX_IDLE_TIMEOUT_SECONDS).
// Clamping keeps a legal config running with the closest idle window workdir supports,
// where forwarding it verbatim would fail every create the sandbox ever attempts.
const AUTO_STOP_MIN_SECONDS = 30;
const AUTO_STOP_MAX_SECONDS = 60 * 60;

// The mount's assume-role session lasts an hour and mount-s3 takes its credentials as
// process env, so the only way to hand it new ones is to replace the daemon. Remount
// with this much of the session left, rather than letting it expire into I/O errors.
const MOUNT_MAX_AGE_SECONDS = 45 * 60;

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

  async acquireHarnessReservation(request: {
    reservationKey: string;
    abortSignal?: AbortSignal;
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
      if (reservation.isFirstCreate) {
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
      throw new Error("no reserved workdir sandbox for this Harness session");
    }
    const sandbox = await this.#reconnect(externalId);
    await this.#runLifecycle(sandbox, this.#workDir(request.reservationKey));
    await saveSandboxInstance(
      "sandbox",
      request.reservationKey,
      externalId,
      this.#config.controlPlane?.accountId,
    ).catch(() => {});
    request.abortSignal?.throwIfAborted();

    return sandbox;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const persistent = this.#persistent(request);
    const sandbox = await this.#acquire(request);

    try {
      if (this.#s3MountStrategy(request) === "exec")
        await this.#ensureS3Mount(sandbox, request);
      if (persistent)
        await this.#runLifecycle(
          sandbox,
          this.#workDir(sandboxReservationKey(request)!),
        );
      const cwd = request.namespace
        ? workspacePath(request, this.#workspaceRoot())
        : undefined;
      const result = await sandbox.exec(request.code, {
        ...(cwd ? { cwd: cwd } : {}),
        env: {
          ...stringRecord(this.#config.envVars),
          ...(request.envVars ?? {}),
        },
      });
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
        provider: "sandbox",
      };
    } finally {
      if (!persistent) await sandbox.delete().catch(() => {});
    }
  }

  async runBackground(request: SandboxRunRequest): Promise<SandboxJobHandle> {
    const ns = this.#requirePersistent(request);
    const sandbox = await this.#acquire(request);
    if (this.#s3MountStrategy(request) === "exec")
      await this.#ensureS3Mount(sandbox, request);
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
        ...stringRecord(this.#config.envVars),
        ...(request.envVars ?? {}),
      },
    });
    if (result.exit_code !== 0) {
      throw new Error(
        result.stderr || result.stdout || "failed to launch background job",
      );
    }

    return { jobId: jobId };
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

    // Report the real terminal state: a job that already finished keeps its own
    // exit code instead of being recorded as killed.
    return parseJobStatus(
      request.jobId,
      await this.#shell(sandbox, statusScript(jobsDir, request.jobId)),
    );
  }

  // Create/resume the reserved sandbox ahead of the first real call. Fire-and-
  // forget: callers feature-detect and ignore failures.
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

    return { snapshotId: snapshotId, ...(externalImageId ? { externalImageId: externalImageId } : {}) };
  }

  async getInstanceInfo(
    request: SandboxReservationRef,
  ): Promise<SandboxInstanceInfo | null> {
    const externalId = await this.#reservedId(request);
    if (!externalId) return null;
    try {
      const sandbox = await this.#client.sandboxes.get(externalId);

      return { externalId: externalId, state: mapWorkdirState(sandbox.state) };
    } catch (err) {
      if (isSandboxGoneError(err)) return { externalId: externalId, state: "terminating" };
      throw err;
    }
  }

  async release(request: {
    namespace?: string;
    reservationKey?: string;
  }): Promise<void> {
    const key = sandboxReservationKey(request);
    if (!key) return;
    const externalId = await getSandboxExternalId("sandbox", key);
    if (!externalId) return;
    try {
      await (await this.#client.sandboxes.get(externalId)).delete();
    } catch (err) {
      // Already gone => safe to forget. Wrong creds / transient => propagate so a
      // caller iterating multiple configs can try the next one.
      if (!isSandboxGoneError(err)) throw err;
    }
    await deleteSandboxInstance(
      "sandbox",
      key,
      this.#config.controlPlane?.accountId,
    ).catch(() => {});
  }

  #options(): Record<string, unknown> {
    return isPlainObject(this.#config.options) ? this.#config.options : {};
  }

  // workdir has no native hard expiry — `auto_stop_seconds` only stops the machine,
  // it never deletes it — so `lifecycle.maxLifetimeSeconds` is enforced here, at
  // acquire time. Checking between turns rather than on a timer means an expiry can
  // never interrupt a running exec: the next call retires the old sandbox and boots
  // a fresh one, which costs a cold create instead of a resume. Local disk is lost;
  // the S3 workspace mount is not, so the agent's files come back with it. Unset
  // maxLifetimeSeconds keeps the sandbox until something releases the reservation.
  async #outlivedMaxLifetime(reservationKey: string): Promise<boolean> {
    const { maxLifetimeSeconds } = resolveSandboxLifecycle(
      this.#config.lifecycle,
    );
    if (maxLifetimeSeconds === undefined) return false;
    const reservedAt = await getSandboxReservedAt("sandbox", reservationKey);
    if (reservedAt === null) return false;

    return Date.now() - reservedAt >= maxLifetimeSeconds * 1000;
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

  // Job-state markers live beside the workspace mount so the tiny files stay on
  // the sandbox's native disk, not under the S3 mount.
  #jobsDir(reservationKey: string): string {
    return `${this.#workspaceRoot()}/.fp-jobs/${reservationKey}`;
  }

  // S3 workspace mount strategy:
  //  - `none`:        not a workspace run (no namespace) and mounting not forced.
  //  - `exec`:        a role is configured (bring-your-own assumeRole, or the
  //                   platform SANDBOX_MOUNT_ROLE_ARN) -> mount via exec with the
  //                   short-lived credentials (#ensureS3Mount). Preferred —
  //                   workdir's org-global secret store can't safely hold
  //                   per-namespace scoped creds, but a per-call exec env can.
  //  - `declarative`: no role -> declare a boot mount that reads static keys from
  //                   named org secrets (#s3Mounts), for stores without a role.
  // Gated on the run's namespace, not `storage`: managed workspaces carry no
  // storage block (their bucket is the managed fallback), same as microvm.
  #s3MountStrategy(request: {
    namespace?: string;
  }): "none" | "exec" | "declarative" {
    if (!request.namespace && this.#options().mountAwsS3Buckets !== true)
      return "none";

    return mountRoleArn(this.#config.storage) ? "exec" : "declarative";
  }

  // Build the resolver context from the workspace storage plus executor option /
  // env fallbacks. Throws when the workspace namespace is missing.
  #s3Context(request: { namespace?: string }): S3MountContext {
    if (!request.namespace) {
      throw new Error(
        "workdir AWS S3 workspace mount requires a workspace namespace.",
      );
    }
    const options = this.#options();

    return {
      storage: this.#config.storage,
      namespace: request.namespace,
      managedBucket:
        configString(options.workspaceBucketName) ??
        optionalEnv("FILESYSTEM_BUCKET_NAME"),
      region:
        configString(options.awsRegion) ??
        optionalEnv("AWS_REGION") ??
        optionalEnv("AWS_DEFAULT_REGION"),
      endpoint: configString(options.s3Endpoint),
    };
  }

  // Guest filesystem path the workspace mounts at.
  #mountPath(request: { namespace?: string; workspaceRoot?: string }): string {
    const root = (request.workspaceRoot ?? this.#workspaceRoot()).replace(
      /\/+$/,
      "",
    );

    return `${root}/${request.namespace}`;
  }

  // Declarative boot mount (top-level `mounts[]`) — `declarative` strategy only.
  // workdir runs mount-s3 at boot and reads creds from the guest secret env, which
  // it injects from the named org secrets (s3SecretNames). The role path mounts via
  // exec instead (#ensureS3Mount).
  #s3Mounts(request: {
    namespace?: string;
    workspaceRoot?: string;
  }): CreateOptions["mounts"] | undefined {
    if (this.#s3MountStrategy(request) !== "declarative") return undefined;
    const { bucket, prefix, region, endpoint } = resolveS3MountIdentity(
      this.#s3Context(request),
    );

    return [
      {
        type: "s3",
        bucket: bucket,
        mount_path: this.#mountPath(request),
        // The agent reads AND writes; workdir defaults S3 mounts to read_only:true.
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
    // Declarative mount creds come from the guest secret env (named org secrets).
    if (mounts) startup.secrets = s3SecretNames(options);

    // The first-class `snapshot` pin wins; `options.image` stays a back-compat alias.
    const image =
      configString(this.#config.snapshot) ?? configString(options.image);

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
      SandboxRunRequest | { namespace?: string; reservationKey?: string },
  ): Promise<Sandbox> {
    return (await this.#acquireWithState(request)).sandbox;
  }

  async #acquireWithState(
    request:
      SandboxRunRequest | { namespace?: string; reservationKey?: string },
  ): Promise<WorkdirHarnessReservation> {
    if (!this.#persistent(request)) {
      return {
        sandbox: await this.#client.sandboxes.create(
          this.#createOptions(request, false),
        ),
        isFirstCreate: true,
      };
    }
    const ns = sandboxReservationKey(request)!;
    if (await this.#outlivedMaxLifetime(ns)) {
      // Deliberately not caught: a failed delete here would leak the old sandbox
      // at the provider the moment the new one claims the key.
      await this.release({ reservationKey: ns });
    }
    const externalId = await getSandboxExternalId("sandbox", ns);
    if (externalId) {
      try {
        const sandbox = await this.#reconnect(externalId);
        // Reservation refresh and dashboard mirror are both recoverable on the next
        // call, so they never hold up an exec that already has its endpoint.
        void saveSandboxInstance(
          "sandbox",
          ns,
          externalId,
          this.#config.controlPlane?.accountId,
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
        // Recreate only when the sandbox is really gone; a transient error must
        // propagate or the still-live sandbox is orphaned at the provider. The
        // conditional delete keeps a row a concurrent call already re-claimed.
        if (!isSandboxGoneError(error)) throw error;
        await deleteSandboxInstance(
          "sandbox",
          ns,
          this.#config.controlPlane?.accountId,
          externalId,
        ).catch(() => {});
      }
    }
    const created = await this.#client.sandboxes.create(
      this.#createOptions(request, true),
    );
    try {
      if (
        await claimSandboxInstance(
          "sandbox",
          ns,
          created.id,
          this.#config.controlPlane?.accountId,
        )
      ) {
        await upsertSandboxInstance(
          this.#config.controlPlane,
          "sandbox",
          ns,
          created.id,
          "metadata" in request ? request.metadata : undefined,
        );

        return { sandbox: created, isFirstCreate: true };
      }
    } catch (error) {
      // The claim may already have committed even when its caller rejects. Tear
      // down both sides conditionally so a failed acquisition cannot leak the
      // newly created sandbox or erase a concurrent winner's reservation.
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
    // Lost a concurrent create race: discard our duplicate and reconnect to the
    // sandbox the winner recorded.
    const winner = await getSandboxExternalId("sandbox", ns);
    await created.delete().catch(() => {});
    if (!winner)
      throw new Error("failed to reserve workdir sandbox (lost create race)");

    return {
      sandbox: await this.#reconnect(winner),
      isFirstCreate: false,
    };
  }

  // A reserved sandbox idles into `stopped`/`standby`; resume it before use.
  // (`standby` auto-resumes on exec, but resuming an explicit `stopped` is not.)
  async #reconnect(externalId: string): Promise<Sandbox> {
    const sandbox = await this.#client.sandboxes.get(externalId);
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

  // `exec` strategy: mount the bucket via mount-s3 inside the guest, handing it
  // short-lived credentials (incl. the session token) scoped to the mount prefix as
  // per-call exec env — never the harness's own broad creds, which any code the
  // agent runs could read (the daytona model).
  //
  // One idempotent guard covers three states: not mounted, mounted over a wedged FUSE
  // endpoint a bare mount-s3 cannot retake, and mounted on credentials near expiry —
  // mount-s3 only reads them at startup, so rotating means replacing the daemon.
  // Age comes from a stamp written with the harness's clock, not the guest's, which a
  // Firecracker pause freezes. The stamp lives on agent-writable disk, so it is treated
  // as untrusted input: anything non-numeric reads as "unknown age" and forces a remount.
  async #ensureS3Mount(
    sandbox: Sandbox,
    request: { namespace?: string; workspaceRoot?: string },
  ): Promise<void> {
    const mount = await resolveS3Mount(this.#s3Context(request));
    if (!mount.credentials) {
      throw new Error("workdir S3 assume-role mount resolved no credentials");
    }
    const mountPath = this.#mountPath(request);
    const mountArgs = [
      mount.bucket,
      mountPath,
      ...(mount.prefix ? ["--prefix", mount.prefix] : []),
      // The agent reads AND writes workspace files, so allow overwrite + delete.
      "--allow-delete",
      "--allow-overwrite",
      ...(mount.region ? ["--region", mount.region] : []),
      ...(mount.endpoint ? ["--endpoint-url", mount.endpoint] : []),
    ]
      .map(shellQuote)
      .join(" ");
    const quotedPath = shellQuote(mountPath);
    const quotedStamp = shellQuote(`${mountPath}.mounted-at`);
    const now = Math.floor(Date.now() / 1000);
    const result = await sandbox.exec(
      [
        `stamp=$(cat ${quotedStamp} 2>/dev/null || echo 0);`,
        `case "$stamp" in '' | *[!0-9]*) stamp=0 ;; esac;`,
        `if ! mountpoint -q ${quotedPath} || [ $((${now} - stamp)) -ge ${MOUNT_MAX_AGE_SECONDS} ]; then`,
        `fusermount -u ${quotedPath} 2>/dev/null || umount -l ${quotedPath} 2>/dev/null;`,
        `mkdir -p ${quotedPath} && mount-s3 ${mountArgs} && echo ${now} > ${quotedStamp};`,
        `fi`,
      ].join(" "),
      {
        env: {
          ...mount.credentials,
          // The guest has no EC2 IMDS; without this the AWS client probes
          // 169.254.169.254 and stalls every mount ~4s on the connect timeout.
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

// Resolve the workdir control-plane target for a sandbox config: a tenant's own
// node (options.workdirUrl + apiKey) or the platform default from the env. Also
// used by the account-manage `terminal` op to dial the node's PTY WebSocket.
export function workdirConnection(config: SandboxExecutorConfig): {
  baseUrl: string;
  apiKey: string;
} {
  const options = isPlainObject(config.options) ? config.options : {};
  const customBaseUrl = configString(options.workdirUrl);
  if (customBaseUrl) {
    assertSafeTenantProviderUrl(customBaseUrl, "config.options.workdirUrl");
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

// The in-guest TTY workdir exposes per sandbox (`GET /v1/sandboxes/:id/pty`).
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

function workdirResources(
  config: SandboxExecutorConfig,
): CreateOptions["resources"] | undefined {
  const options = isPlainObject(config.options) ? config.options : {};
  // A pinned size seeds the dimensions (vcpu clamped to workdir's allowed set);
  // explicit cpu/memoryMb/diskGb options still win over the size defaults.
  const sized = config.size ? workdirSizeResources(config.size) : undefined;
  const cpu = numberOption(options.cpu) ?? sized?.cpu;
  const memoryMb =
    numberOption(options.memoryMb) ?? config.memoryLimit ?? sized?.memoryMb;
  const diskGb = numberOption(options.diskGb) ?? sized?.diskGb;
  if (cpu === undefined && memoryMb === undefined && diskGb === undefined)
    return undefined;

  return {
    ...(cpu !== undefined ? { cpu: cpu } : {}),
    ...(memoryMb !== undefined ? { memoryMb: memoryMb } : {}),
    ...(diskGb !== undefined ? { diskGb: diskGb } : {}),
  };
}

function numberOption(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

// Map the harness network policy onto workdir's create-time egress modes
// (default | none | allowlist). Domains become rule objects; CIDRs/IPs are
// shorthand strings. Restricted-with-no-rules collapses to a full egress block,
// since an allowlist requires at least one rule.
function workdirNetwork(
  network: SandboxNetworkConfig | undefined,
): Record<string, unknown> | undefined {
  if (!network) return undefined;
  if (network.mode === "allow-all") return { egress: "default" };
  if (network.mode === "deny-all") return { egress: "none" };
  const allow = [
    ...(network.allowDomains ?? []).map((value) => ({ type: "domain", value: value })),
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
