import {
  CreateMicrovmAuthTokenCommand,
  CreateMicrovmImageCommand,
  CreateMicrovmShellAuthTokenCommand,
  GetMicrovmCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovms,
  type MicrovmState,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  type RunMicrovmRequest,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  recordSandboxBurst,
  removeSandboxInstance,
  upsertSandboxInstance,
} from "../../shared/convex/sandbox-instances.ts";
import type {
  SandboxExecRequest,
  SandboxExecResponse,
} from "../../shared/domain/sandbox-config.ts";
import { waitUntil } from "../../shared/in-flight.ts";
import type { SandboxRunMetadata } from "../../shared/sandbox-sizes.ts";
import { optionalEnv, requireEnv } from "../../shared/env.ts";
import { isTimeoutError, toErrorMessage } from "../../shared/errors.ts";
import { logWarn } from "../../shared/log.ts";
import { isPlainObject } from "@broods/convex/model/objects";
import { getObservabilityContext } from "../../shared/otel.ts";
import { stripTrailingSlashes } from "../../shared/paths.ts";
import {
  copyS3Object,
  deleteS3Object,
  getS3ObjectUrl,
  putS3ObjectUrl,
} from "../../shared/s3.ts";
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
import { snapshotCapture } from "./microvm-snapshot.ts";
import {
  type S3MountContext,
  mountAttribution,
  resolveS3Mount,
} from "./s3-mount.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxInstanceInfo,
  SandboxJobHandle,
  SandboxJobLogs,
  SandboxJobRequest,
  SandboxJobStatus,
  SandboxGuestPost,
  SandboxReleaseRequest,
  SandboxReservationRef,
  SandboxReservedPost,
  SandboxRunPrincipal,
  SandboxRunRequest,
  SandboxRunResult,
  SandboxSnapshotBuildState,
  SandboxSnapshotResult,
} from "./types.ts";
import {
  assertSnapshotBootable,
  configuredSandboxSpecs,
  configString,
  EXEC_GRACE_MS,
  execRunResult,
  mergeSandboxEnv,
  parseExecResponse,
  queueMirrorWrite,
  SandboxCapacityError,
  SandboxGoneError,
  sandboxReservationKey,
  shellQuote,
  truncateText,
} from "./utils.ts";

const MICROVM_PROXY_PORT = 8080;
const AUTH_TOKEN_TTL_MINUTES = 15;
const AUTH_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const WARMUP_BUDGET_MS = 30_000;
const WARMUP_RETRY_MIN_DELAY_MS = 150;
const WARMUP_RETRY_MAX_DELAY_MS = 750;
const CACHED_WARMUP_BUDGET_MS = 1_200;
const CAPACITY_EXCEPTIONS: ReadonlySet<string> = new Set([
  "InsufficientCapacityException",
  "ServiceQuotaExceededException",
  "ThrottlingException",
  "TooManyRequestsException",
]);
// An endpoint outlives suspend, so caching it is safe; the TTL caps how long a reservation
// moved by another pod goes unnoticed here.
const RESERVED_ENDPOINT_TTL_MS = 3 * 60_000;
const CACHE_MAX_ENTRIES = 512;
const MAX_MICROVM_DURATION_SECONDS = 28_800;
const DEFAULT_WORKSPACE_ROOT = "/mnt/workspaces";

const PROVIDER = "lambda" as const;
// Must match apps/lambda/sandbox-log-forwarder.mjs.
const LOG_STREAM_MAC_LENGTH = 16;

// STS sessions last 1h and a reserved VM outlives one, so push fresh mount creds well inside it.
const MOUNT_CREDENTIAL_REFRESH_MS = 30 * 60_000;
const MOUNT_CREDENTIALS_PATH = "/workspace/credentials";

const MOUNT_ASSERT_BUDGET_MS = 30_000;
const MOUNT_ASSERT_MIN_DELAY_MS = 250;
const MOUNT_ASSERT_MAX_DELAY_MS = 2_000;

// Module-scope caches, since an executor is built per request; evictToCap bounds each one.
const mountCredentialRefreshes = new Map<string, { expiresAt: number }>();
const authTokens = new Map<string, { token: string; expiresAt: number }>();
const burstReported = new Map<
  string,
  { vcpuSeconds: number; gbSeconds: number; expiresAt: number }
>();
const BURST_REPORT_MIN_GROWTH = 0.01;
const BURST_REPORT_TTL_MS = 24 * 60 * 60 * 1000;
const reservedEndpoints = new Map<
  string,
  { microvmId: string; endpoint: string; image: string; expiresAt: number }
>();

// The VM reaches only the filesystem bucket, so zips stage there; the build role may read
// only the artifact bucket's MicroVM image prefix.
const SNAPSHOT_STAGING_PREFIX = "sandbox-snapshots/";
const SNAPSHOT_ARTIFACT_PREFIX = "microvm-images/broods-snapshots/";
const SNAPSHOT_IMAGE_PREFIX = "broods-snapshot-";
const SNAPSHOT_CAPTURE_TIMEOUT_SECONDS = 600;

export const MICROVM_SHELL_AUTH_HEADER = "X-aws-proxy-auth";
const SHELL_TOKEN_TTL_MINUTES = 30;

// A refused or reset connection is a VM still restoring, but a timeout means the command ran
// past its budget, and retrying would run it twice.
const EXEC_RETRY: GuestRetry = {
  fetchError: (err: unknown): boolean => !isTimeoutError(err),
  warmingStatus: true,
};
// Only a connection that never opened: a reset or 502/503 can follow a call the guest ran.
const GUEST_ROUTE_RETRY: GuestRetry = {
  fetchError: (err: unknown): boolean =>
    err instanceof Error && "code" in err && err.code === "ConnectionRefused",
  warmingStatus: false,
};

const GUEST_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

const burstTotals = z.object({
  vcpu_seconds: z.number(),
  gb_seconds: z.number(),
});

type Warming<T> =
  | { retry: true; status: number | string }
  | { retry: false; response: T };

interface GuestRetry {
  fetchError: (err: unknown) => boolean;
  warmingStatus: boolean;
}

export interface MicrovmHarnessReservation {
  readonly microvmId: string;
  readonly endpoint: string;
  readonly isFirstCreate: boolean;
}

// The VM is terminal or runs another image: recreate it rather than retry.
class MicrovmGoneError extends SandboxGoneError {}

// The proxy never took the request, so it never ran: the one failure safe to retry elsewhere.
class MicrovmNotReadyError extends Error {}

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

  // A shared VM survives a failed setup: another conversation may already hold it.
  async acquireHarnessReservation(request: {
    reservationKey: string;
    abortSignal?: AbortSignal;
    metadata?: SandboxRunMetadata;
    shared?: boolean;
  }): Promise<MicrovmHarnessReservation> {
    request.abortSignal?.throwIfAborted();
    if (!this.#persistent(request)) {
      throw new Error(
        "Harness sessions require a persistent lambda (MicroVM) reservation key",
      );
    }
    const reservation = await this.#acquire(
      this.#harnessRequest(request.reservationKey, request.metadata),
    );
    try {
      await this.#runLifecycle(
        reservation.microvmId,
        reservation.endpoint,
        this.#workDir(request.reservationKey),
      );
      request.abortSignal?.throwIfAborted();

      return reservation;
    } catch (error) {
      if (reservation.isFirstCreate && request.shared !== true) {
        await this.release(request).catch(() => {});
      }
      throw error;
    }
  }

  async resumeHarnessReservation(request: {
    reservationKey: string;
    abortSignal?: AbortSignal;
    metadata?: SandboxRunMetadata;
  }): Promise<Omit<MicrovmHarnessReservation, "isFirstCreate">> {
    request.abortSignal?.throwIfAborted();
    if (!this.#persistent(request)) {
      throw new Error(
        "Harness sessions require a persistent lambda (MicroVM) reservation key",
      );
    }
    const microvmId = await getSandboxExternalId(
      PROVIDER,
      request.reservationKey,
    );
    if (!microvmId) {
      throw new SandboxGoneError(
        "no reserved MicroVM for this Harness session",
      );
    }
    const reservation = await this.#reconnect(microvmId);
    await this.#runLifecycle(
      reservation.microvmId,
      reservation.endpoint,
      this.#workDir(request.reservationKey),
    );
    await saveSandboxInstance(
      PROVIDER,
      request.reservationKey,
      reservation.microvmId,
      this.#config.controlPlane?.accountId,
      this.#config.controlPlane?.releaseAfterIdleSeconds,
    ).catch(() => {});
    void queueMirrorWrite(reservation.microvmId, () =>
      upsertSandboxInstance(
        this.#config.controlPlane,
        PROVIDER,
        request.reservationKey,
        reservation.microvmId,
        request.metadata,
        { specs: configuredSandboxSpecs(this.#config) },
      ),
    );
    request.abortSignal?.throwIfAborted();

    return reservation;
  }

  // Harness state lives under `~/.ai-sdk-harness`, so every command gets the reservation's HOME.
  async runHarnessCommand(request: {
    microvmId: string;
    endpoint: string;
    reservationKey: string;
    code: string;
    env?: Record<string, string>;
    timeoutSeconds?: number;
    abortSignal?: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    request.abortSignal?.throwIfAborted();
    const response = await this.#exec(request.microvmId, request.endpoint, {
      runtime: "bash",
      code: request.code,
      timeout_ms:
        (request.timeoutSeconds ?? this.#config.timeout ?? 120) * 1000,
      env: {
        ...this.#sandboxEnvVars(request.env),
        ...homeEnv(this.#workDir(request.reservationKey)),
      },
    });
    request.abortSignal?.throwIfAborted();
    // Cut output ends in the server's truncation marker, which callers would read as data.
    if (response.truncated === true) {
      throw new Error("MicroVM harness command output passed the exec cap");
    }

    return {
      stdout: response.stdout,
      stderr: response.stderr,
      exitCode: response.exit_code ?? (response.ok ? 0 : 1),
    };
  }

  async createHarnessAuthToken(
    microvmId: string,
    port: number,
  ): Promise<string> {
    return this.#authToken(microvmId, port);
  }

  async postReserved(request: SandboxReservedPost): Promise<unknown> {
    if (!this.#persistent(request)) {
      throw new Error(
        "a guest route needs a persistent lambda (MicroVM) sandbox reservation",
      );
    }
    const post = async (
      target: { microvmId: string; endpoint: string },
      budgetMs: number,
    ): Promise<unknown> => {
      const readyBy = Date.now() + budgetMs;
      await this.#whileWarming(target.microvmId, budgetMs, () =>
        this.#ready(target, readyBy, request.abortSignal),
      );

      return this.#whileWarming(
        target.microvmId,
        Math.max(0, readyBy - Date.now()),
        () =>
          this.#post(
            target,
            request,
            GUEST_ROUTE_RETRY,
            (text, headers): unknown => {
              this.#reportBurst(target.microvmId, burstHeader(headers));

              return JSON.parse(text);
            },
          ),
      );
    };
    const reach: SandboxRunRequest = {
      ...this.#harnessRequest(sandboxReservationKey(request) ?? ""),
      reservationKey: request.reservationKey,
      namespace: request.namespace,
      workspaceRoot: request.workspaceRoot,
    };
    const cached = this.#cachedTarget(request);
    if (cached) {
      await this.#refreshMountCredentials(
        reach,
        cached.microvmId,
        cached.endpoint,
      );
      try {
        await this.#runLifecycle(
          cached.microvmId,
          cached.endpoint,
          this.#workDir(this.#workspaceKey(reach)),
          CACHED_WARMUP_BUDGET_MS,
        );

        return await post(cached, CACHED_WARMUP_BUDGET_MS);
      } catch (error) {
        if (!(error instanceof MicrovmNotReadyError)) throw error;
        reservedEndpoints.delete(sandboxReservationKey(request) ?? "");
      }
    }
    const acquired = await this.#acquire(reach);
    const workDir = this.#workDir(this.#workspaceKey(reach));
    await this.#prepareWorkspaceMount(reach, acquired, workDir);
    await this.#runLifecycle(acquired.microvmId, acquired.endpoint, workDir);
    request.abortSignal?.throwIfAborted();

    return post(acquired, WARMUP_BUDGET_MS);
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const persistent = this.#persistent(request);
    const payload = this.#execPayload(request);
    const cached = persistent ? this.#cachedTarget(request) : null;
    if (cached) {
      await this.#refreshMountCredentials(
        request,
        cached.microvmId,
        cached.endpoint,
      );
      const response = await this.#execReserved(cached, request, payload);
      if (response) {
        return execRunResult(request, response, PROVIDER, startedAt);
      }
    }
    const { microvmId, endpoint, isFirstCreate } = await this.#acquire(request);

    try {
      if (persistent) {
        const workDir = this.#workDir(this.#workspaceKey(request));
        await this.#prepareWorkspaceMount(
          request,
          {
            microvmId: microvmId,
            endpoint: endpoint,
            isFirstCreate: isFirstCreate,
          },
          workDir,
        );
        await this.#runLifecycle(microvmId, endpoint, workDir);
      } else if (request.namespace) {
        await this.#assertWorkspaceMounted(
          microvmId,
          endpoint,
          this.#workDir(microvmLocalNamespace(request.namespace)),
        );
      }

      return execRunResult(
        request,
        await this.#exec(microvmId, endpoint, payload),
        PROVIDER,
        startedAt,
      );
    } finally {
      // Off the caller's clock. The billing row goes only once the VM is gone, queued after
      // the upsert and burst writes so a slow upsert cannot recreate it.
      if (!persistent) {
        waitUntil(
          this.#terminate(microvmId).then(
            (gone: boolean): Promise<void> | undefined =>
              gone
                ? queueMirrorWrite(microvmId, () => this.#unmirror(microvmId))
                : undefined,
          ),
        );
      }
    }
  }

  async runBackground(request: SandboxRunRequest): Promise<SandboxJobHandle> {
    const key = this.#requirePersistent(request);
    const acquired = await this.#acquire(request);
    const { microvmId, endpoint } = acquired;
    const workDir = this.#workDir(this.#workspaceKey(request));
    await this.#prepareWorkspaceMount(request, acquired, workDir);
    await this.#runLifecycle(microvmId, endpoint, workDir);
    const jobId = request.jobId ?? generateJobId();
    const script = launchScript(
      this.#jobsDir(key),
      jobId,
      workDir,
      request.code,
      {
        maxConcurrentJobs: MAX_CONCURRENT_BACKGROUND_JOBS,
        ...(request.callback ? { callback: request.callback } : {}),
      },
    );
    const result = await this.#shell(microvmId, endpoint, script, {
      timeoutSeconds: 30,
      env: callbackEnv(request.callback),
      home: workDir,
    });
    if (result.exitCode !== null && result.exitCode !== 0) {
      throw new Error(
        result.stderr || result.stdout || "failed to launch background job",
      );
    }

    return { jobId: jobId, externalId: microvmId };
  }

  async jobStatus(request: SandboxJobRequest): Promise<SandboxJobStatus> {
    const { microvmId, endpoint, jobsDir } = await this.#jobContext(request);
    const result = await this.#shell(
      microvmId,
      endpoint,
      statusScript(jobsDir, request.jobId),
    );

    return parseJobStatus(request.jobId, result.stdout);
  }

  async jobLogs(request: SandboxJobRequest): Promise<SandboxJobLogs> {
    const bytes = request.outputLimitBytes ?? 64 * 1024;
    const { microvmId, endpoint, jobsDir } = await this.#jobContext(request);
    const result = await this.#shell(
      microvmId,
      endpoint,
      logsScript(jobsDir, request.jobId, bytes),
    );
    const logs = truncateText(result.stdout, bytes);

    return {
      jobId: request.jobId,
      logs: logs.value,
      truncated: logs.truncated,
    };
  }

  async stopJob(request: SandboxJobRequest): Promise<SandboxJobStatus> {
    const { microvmId, endpoint, jobsDir } = await this.#jobContext(request);
    await this.#shell(microvmId, endpoint, stopScript(jobsDir, request.jobId));
    const result = await this.#shell(
      microvmId,
      endpoint,
      statusScript(jobsDir, request.jobId),
    );

    return parseJobStatus(request.jobId, result.stdout);
  }

  async suspend(request: SandboxReservationRef): Promise<void> {
    const microvmId = await this.#reservedId(request);
    if (microvmId)
      await this.#client.send(
        new SuspendMicrovmCommand({ microvmIdentifier: microvmId }),
      );
  }

  async resume(request: SandboxReservationRef): Promise<void> {
    const microvmId = await this.#reservedId(request);
    if (microvmId)
      await this.#client.send(
        new ResumeMicrovmCommand({ microvmIdentifier: microvmId }),
      );
  }

  async snapshot(
    request: SandboxReservationRef,
  ): Promise<SandboxSnapshotResult> {
    const microvmId = await this.#reservedId(request);
    if (!microvmId) {
      throw new Error("no reserved MicroVM to snapshot for this sandbox");
    }
    const target = await this.#reconnect(microvmId);
    const vm = await this.#client.send(
      new GetMicrovmCommand({ microvmIdentifier: microvmId }),
    );
    if (!vm.imageArn || !vm.imageVersion || !vm.startedAt) {
      throw new Error(`MicroVM ${microvmId} does not report the image it runs`);
    }
    const source = await this.#client.send(
      new GetMicrovmImageVersionCommand({
        imageIdentifier: vm.imageArn,
        imageVersion: vm.imageVersion,
      }),
    );
    const artifact = s3Location(source.codeArtifact?.uri);
    if (!artifact) {
      throw new Error(`MicroVM image ${vm.imageArn} has no S3 code artifact`);
    }
    const staging = requireEnv("FILESYSTEM_BUCKET_NAME");
    const snapshotId = randomUUID().replaceAll("-", "").slice(0, 20);
    const stagedSource = `${SNAPSHOT_STAGING_PREFIX}${snapshotId}/source.zip`;
    const stagedImage = `${SNAPSHOT_STAGING_PREFIX}${snapshotId}/image.zip`;
    const artifactKey = `${SNAPSHOT_ARTIFACT_PREFIX}${snapshotId}.zip`;
    try {
      await copyS3Object(artifact.bucket, artifact.key, staging, stagedSource);
      const capture = snapshotCapture({
        snapshotId: snapshotId,
        startedAt: vm.startedAt,
        sourceUrl: await getS3ObjectUrl(staging, stagedSource, {
          expiresInSeconds: SNAPSHOT_CAPTURE_TIMEOUT_SECONDS,
        }),
        uploadUrl: await putS3ObjectUrl(staging, stagedImage, {
          expiresInSeconds: SNAPSHOT_CAPTURE_TIMEOUT_SECONDS,
        }),
        workspaceRoot: this.#workspaceRoot(),
      });
      const captured = await this.#shell(
        target.microvmId,
        target.endpoint,
        capture.script,
        { timeoutSeconds: SNAPSHOT_CAPTURE_TIMEOUT_SECONDS, env: capture.env },
      );
      if (captured.exitCode !== 0) {
        throw new Error(
          `snapshot capture failed: ${captured.stderr || captured.stdout}`,
        );
      }
      await copyS3Object(staging, stagedImage, artifact.bucket, artifactKey);
    } finally {
      await Promise.all([
        deleteS3Object(staging, stagedSource),
        deleteS3Object(staging, stagedImage),
      ]).catch(() => {});
    }
    const created = await this.#client
      .send(
        new CreateMicrovmImageCommand({
          name: `${SNAPSHOT_IMAGE_PREFIX}${snapshotId}`,
          description: `Broods snapshot of ${microvmId} on ${vm.imageArn}`,
          baseImageArn: source.baseImageArn,
          // Versions read back as "1.0", but create takes only the major number.
          baseImageVersion: source.baseImageVersion?.split(".")[0],
          buildRoleArn: source.buildRoleArn,
          codeArtifact: { uri: `s3://${artifact.bucket}/${artifactKey}` },
          hooks: source.hooks,
          additionalOsCapabilities: source.additionalOsCapabilities,
          cpuConfigurations: source.cpuConfigurations,
          resources: source.resources,
          environmentVariables: source.environmentVariables,
          egressNetworkConnectors: source.egressNetworkConnectors,
          logging: source.logging,
        }),
      )
      .catch(async (error: unknown): Promise<never> => {
        await deleteS3Object(artifact.bucket, artifactKey).catch(() => {});
        throw error;
      });
    if (!created.imageArn) {
      throw new Error("CreateMicrovmImage returned no image ARN");
    }

    return {
      snapshotId: snapshotId,
      externalImageId: created.imageArn,
      status: "building",
    };
  }

  async snapshotStatus(
    externalImageId: string,
  ): Promise<SandboxSnapshotBuildState> {
    const image = await this.#client.send(
      new GetMicrovmImageCommand({ imageIdentifier: externalImageId }),
    );
    if (image.latestActiveImageVersion) return "active";
    if (image.latestFailedImageVersion || image.state === "CREATE_FAILED") {
      return "build_failed";
    }

    return "building";
  }

  async getInstanceInfo(
    request: SandboxReservationRef,
  ): Promise<SandboxInstanceInfo | null> {
    const microvmId = await this.#reservedId(request);
    if (!microvmId) return null;
    try {
      const info = await this.#client.send(
        new GetMicrovmCommand({ microvmIdentifier: microvmId }),
      );

      return { externalId: microvmId, state: mapMicrovmState(info.state) };
    } catch (error) {
      if (isMicrovmGone(error)) {
        return null;
      }

      return {
        externalId: microvmId,
        state: "unknown",
        errorMessage: toErrorMessage(error),
      };
    }
  }

  async release(request: SandboxReleaseRequest): Promise<void> {
    const key = sandboxReservationKey(request);
    if (!key) return;
    const microvmId =
      request.expectedExternalId ?? (await getSandboxExternalId(PROVIDER, key));
    reservedEndpoints.delete(key);
    mountCredentialRefreshes.delete(key);
    if (!microvmId) return;
    if (!(await this.#terminate(microvmId))) {
      throw new Error(`failed to terminate MicroVM ${microvmId}`);
    }
    await deleteSandboxInstance(
      PROVIDER,
      key,
      this.#config.controlPlane?.accountId,
      microvmId,
    ).catch(() => {});
  }

  // A pin must stay in the default image's account and region: anything else would boot a
  // foreign image under the platform role, and tenants cannot build MicroVM images.
  #image(): { imageIdentifier: string; imageVersion?: string } {
    const fallback = optionalEnv("MICROVM_IMAGE_IDENTIFIER");
    const pinned = configString(this.#config.snapshot);
    if (pinned) {
      const scope = fallback ? microvmImageScope(fallback) : undefined;
      if (!scope || microvmImageScope(pinned) !== scope) {
        throw new Error(
          "config.snapshot must name a platform MicroVM image in this region",
        );
      }

      return { imageIdentifier: pinned };
    }
    if (this.#config.image) {
      const variant = fallback
        ? microvmImageVariant(fallback, this.#config.image)
        : undefined;
      if (!variant) {
        throw new Error(
          "config.image needs MICROVM_IMAGE_IDENTIFIER to be a MicroVM image ARN in the harness runtime.",
        );
      }

      return { imageIdentifier: variant };
    }
    if (!fallback) {
      throw new Error(
        "MicroVM sandbox requires MICROVM_IMAGE_IDENTIFIER in the harness runtime.",
      );
    }
    const imageVersion = optionalEnv("MICROVM_IMAGE_VERSION");

    return {
      imageIdentifier: fallback,
      ...(imageVersion ? { imageVersion: imageVersion } : {}),
    };
  }

  #imageName(): string {
    return microvmImageName(this.#image().imageIdentifier);
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
      throw new Error(
        "background jobs require a persistent lambda (MicroVM) sandbox reservation key",
      );
    }

    return key;
  }

  #workspaceRoot(): string {
    const options = isPlainObject(this.#config.options)
      ? this.#config.options
      : {};

    return stripTrailingSlashes(
      configString(options.workspaceRoot) ?? DEFAULT_WORKSPACE_ROOT,
    );
  }

  #workDir(key: string): string {
    return `${this.#workspaceRoot()}/${key}`;
  }

  #harnessRequest(
    reservationKey: string,
    metadata?: SandboxRunMetadata,
  ): SandboxRunRequest {
    return {
      code: "true",
      reservationKey: reservationKey,
      timeoutSeconds: this.#config.timeout ?? 120,
      outputLimitBytes: this.#config.outputLimitBytes ?? 64 * 1024,
      ...(metadata ? { metadata: metadata } : {}),
    };
  }

  #workspaceKey(request: SandboxReservationRef): string {
    const key = request.namespace
      ? microvmLocalNamespace(request.namespace)
      : sandboxReservationKey(request);
    if (!key) {
      throw new Error(
        "persistent MicroVM lifecycle requires a workspace namespace or reservation key",
      );
    }

    return key;
  }

  #jobsDir(key: string): string {
    return `${this.#workspaceRoot()}/.fp-jobs/${key}`;
  }

  #cachedTarget(
    request: SandboxReservationRef,
  ): { microvmId: string; endpoint: string } | null {
    const key = sandboxReservationKey(request);
    const cached = key ? reservedEndpoints.get(key) : undefined;
    if (!cached || cached.expiresAt <= Date.now()) return null;
    if (cached.image !== this.#imageName()) {
      return null;
    }

    return { microvmId: cached.microvmId, endpoint: cached.endpoint };
  }

  async #acquire(
    request: SandboxRunRequest,
  ): Promise<MicrovmHarnessReservation> {
    if (!this.#persistent(request)) {
      const created = await this.#runMicrovm(request);
      void queueMirrorWrite(created.microvmId, () =>
        upsertSandboxInstance(
          this.#config.controlPlane,
          PROVIDER,
          created.microvmId,
          created.microvmId,
          request.metadata,
          {
            ephemeral: true,
            logStream: created.logStream,
            specs: configuredSandboxSpecs(this.#config),
          },
        ),
      );

      return {
        microvmId: created.microvmId,
        endpoint: created.endpoint,
        isFirstCreate: true,
      };
    }
    const key = sandboxReservationKey(request)!;
    const existing = await getSandboxExternalId(PROVIDER, key);
    if (existing) {
      try {
        const reconnected = await this.#reconnect(existing);
        void saveSandboxInstance(
          PROVIDER,
          key,
          existing,
          this.#config.controlPlane?.accountId,
          this.#config.controlPlane?.releaseAfterIdleSeconds,
        ).catch(() => {});
        void queueMirrorWrite(existing, () =>
          upsertSandboxInstance(
            this.#config.controlPlane,
            PROVIDER,
            key,
            existing,
            request.metadata,
            { specs: configuredSandboxSpecs(this.#config) },
          ),
        );

        return {
          ...this.#cacheTarget(key, reconnected),
          isFirstCreate: false,
        };
      } catch (error) {
        // Recreate only a VM gone for good. Replacing a still-allocated (e.g. suspended) one
        // leaks it and burns the MicroVM memory quota until nothing can launch.
        if (!isMicrovmGone(error)) throw error;
        await deleteSandboxInstance(
          PROVIDER,
          key,
          this.#config.controlPlane?.accountId,
          existing,
        ).catch(() => {});
      }
    }
    const created = await this.#runMicrovm(request);
    try {
      if (
        await claimSandboxInstance(
          PROVIDER,
          key,
          created.microvmId,
          this.#config.controlPlane?.accountId,
          this.#config.controlPlane?.releaseAfterIdleSeconds,
        )
      ) {
        void queueMirrorWrite(created.microvmId, () =>
          upsertSandboxInstance(
            this.#config.controlPlane,
            PROVIDER,
            key,
            created.microvmId,
            request.metadata,
            {
              logStream: created.logStream,
              specs: configuredSandboxSpecs(this.#config),
            },
          ),
        );

        return { ...this.#cacheTarget(key, created), isFirstCreate: true };
      }
    } catch (error) {
      // The claim may have committed despite the rejection, so undo both sides conditionally.
      await Promise.allSettled([
        this.#terminate(created.microvmId),
        deleteSandboxInstance(
          PROVIDER,
          key,
          this.#config.controlPlane?.accountId,
          created.microvmId,
        ),
      ]);
      throw error;
    }
    const winner = await getSandboxExternalId(PROVIDER, key);
    await this.#terminate(created.microvmId);
    const reconnected = winner
      ? await this.#reconnect(winner).catch(() => null)
      : null;
    if (!reconnected)
      throw new Error("failed to reserve MicroVM (lost create race)");

    return { ...this.#cacheTarget(key, reconnected), isFirstCreate: false };
  }

  #cacheTarget(
    key: string,
    target: { microvmId: string; endpoint: string },
  ): { microvmId: string; endpoint: string } {
    const now = Date.now();
    evictToCap(reservedEndpoints, now);
    const entry = { microvmId: target.microvmId, endpoint: target.endpoint };
    reservedEndpoints.set(key, {
      ...entry,
      image: this.#imageName(),
      expiresAt: now + RESERVED_ENDPOINT_TTL_MS,
    });

    return entry;
  }

  // A resumed VM is not polled to RUNNING: its endpoint outlives suspend and #exec retries the
  // proxy's 502/503 while it restores. Only a record with no endpoint waits.
  async #reconnect(
    microvmId: string,
  ): Promise<{ microvmId: string; endpoint: string }> {
    let info = await this.#client.send(
      new GetMicrovmCommand({ microvmIdentifier: microvmId }),
    );
    if (
      !isTerminalMicrovmState(info.state) &&
      info.imageArn &&
      microvmImageName(info.imageArn) !== this.#imageName()
    ) {
      await this.#terminate(microvmId);
      throw new MicrovmGoneError(
        `MicroVM ${microvmId} runs ${info.imageArn}, not the sandbox's image`,
      );
    }
    if (info.state === "SUSPENDED" || info.state === "SUSPENDING") {
      await this.#client.send(
        new ResumeMicrovmCommand({ microvmIdentifier: microvmId }),
      );
      const deadline = Date.now() + WARMUP_BUDGET_MS;
      let wait = WARMUP_RETRY_MIN_DELAY_MS;
      while (
        !info.endpoint &&
        !isTerminalMicrovmState(info.state) &&
        Date.now() < deadline
      ) {
        await delay(wait);
        wait = Math.min(wait * 2, WARMUP_RETRY_MAX_DELAY_MS);
        info = await this.#client.send(
          new GetMicrovmCommand({ microvmIdentifier: microvmId }),
        );
      }
    }
    // GetMicrovm still answers for a terminal VM; re-checked as one can end while we wait.
    if (isTerminalMicrovmState(info.state)) {
      throw new MicrovmGoneError(`MicroVM ${microvmId} is ${info.state}`);
    }
    if (!info.endpoint) throw new Error(`MicroVM ${microvmId} has no endpoint`);

    return { microvmId: microvmId, endpoint: info.endpoint };
  }

  async #execReserved(
    target: { microvmId: string; endpoint: string },
    request: SandboxRunRequest,
    payload: SandboxExecRequest,
  ): Promise<SandboxExecResponse | null> {
    void queueMirrorWrite(target.microvmId, () =>
      upsertSandboxInstance(
        this.#config.controlPlane,
        PROVIDER,
        sandboxReservationKey(request) ?? target.microvmId,
        target.microvmId,
        request.metadata,
        { specs: configuredSandboxSpecs(this.#config) },
      ),
    );
    try {
      await this.#runLifecycle(
        target.microvmId,
        target.endpoint,
        this.#workDir(this.#workspaceKey(request)),
        CACHED_WARMUP_BUDGET_MS,
      );

      return await this.#exec(
        target.microvmId,
        target.endpoint,
        payload,
        CACHED_WARMUP_BUDGET_MS,
      );
    } catch (error) {
      if (!(error instanceof MicrovmNotReadyError)) throw error;
      const key = sandboxReservationKey(request);
      if (key) reservedEndpoints.delete(key);

      return null;
    }
  }

  async #runMicrovm(
    request: SandboxRunRequest,
  ): Promise<{ microvmId: string; endpoint: string; logStream: string }> {
    const logStream = this.#logStream();
    const command = new RunMicrovmCommand(
      await this.#runInput(request, logStream),
    );
    const result = await this.#client.send(command).catch((error: unknown) => {
      if (error instanceof Error && CAPACITY_EXCEPTIONS.has(error.name)) {
        throw new SandboxCapacityError(error.message);
      }
      throw error;
    });
    if (!result.microvmId || !result.endpoint) {
      throw new Error("RunMicrovm did not return a microvmId and endpoint");
    }

    return {
      microvmId: result.microvmId,
      endpoint: result.endpoint,
      logStream: logStream,
    };
  }

  async #runInput(
    request: SandboxRunRequest,
    logStream: string,
  ): Promise<RunMicrovmRequest> {
    const image = this.#image();
    // All snapshot images sit in the platform account, so boot one only for its own account.
    const imageName = image.imageIdentifier.split(":")[6] ?? "";
    if (imageName.startsWith(SNAPSHOT_IMAGE_PREFIX)) {
      const registered = await assertSnapshotBootable(
        this.#config.controlPlane,
        microvmImageName(image.imageIdentifier),
      );
      if (!registered) {
        throw new Error("config.snapshot names a snapshot of another account");
      }
    }
    // From the runtime env only: an account naming the build role would get its IMDS creds.
    const executionRoleArn = optionalEnv("MICROVM_EXECUTION_ROLE_ARN");
    const logGroup = optionalEnv("MICROVM_LOG_GROUP_NAME");
    const persistent = this.#persistent(request);
    const lifecycle = resolveSandboxLifecycle(this.#config.lifecycle);
    const runHookPayload = await this.#runHookPayload(request);

    return {
      ...image,
      ...(executionRoleArn ? { executionRoleArn: executionRoleArn } : {}),
      ...(logGroup
        ? {
            logging: {
              cloudWatch: { logGroup: logGroup, logStream: logStream },
            },
          }
        : {}),
      ...(persistent
        ? {
            idlePolicy: {
              maxIdleDurationSeconds: lifecycle.idleTimeoutSeconds,
              suspendedDurationSeconds:
                lifecycle.maxLifetimeSeconds ?? DEFAULT_RELEASE_GRACE_SECONDS,
              autoResumeEnabled: true,
            },
          }
        : {}),
      maximumDurationInSeconds: persistent
        ? Math.min(
            lifecycle.maxLifetimeSeconds ?? MAX_MICROVM_DURATION_SECONDS,
            MAX_MICROVM_DURATION_SECONDS,
          )
        : Math.min(request.timeoutSeconds + 60, MAX_MICROVM_DURATION_SECONDS),
      ...this.#networkConnectors(persistent),
      ...(runHookPayload ? { runHookPayload: runHookPayload } : {}),
    };
  }

  // `<account>/<project>/<stage>/<uuid>[/<mac>]`, parsed by the log forwarder to label the tenant.
  // A guest can create any stream in the group, so the forwarder labels only names core signed.
  #logStream(): string {
    const scope = getObservabilityContext();
    const name = [
      scope?.accountId || this.#config.controlPlane?.accountId || "-",
      scope?.project || "-",
      scope?.stage || "-",
      crypto.randomUUID(),
    ].join("/");
    const key = optionalEnv("OTEL_EXPORTER_OTLP_HEADERS");
    if (!key) return name;
    const mac = createHmac("sha256", key)
      .update(name)
      .digest("hex")
      .slice(0, LOG_STREAM_MAC_LENGTH);

    return `${name}/${mac}`;
  }

  // The VM mounts S3 itself on these scoped creds, so core's own creds never reach it.
  async #runHookPayload(
    request: SandboxRunRequest,
  ): Promise<string | undefined> {
    if (!request.namespace) return undefined;
    const mount = await resolveS3Mount(
      this.#s3Context(request.namespace, request),
    );
    const workspaceRoot = (
      request.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT
    ).replace(/\/+$/, "");
    const namespace = microvmLocalNamespace(request.namespace);

    return JSON.stringify({
      workspace: {
        namespace: namespace,
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

  #s3Context(namespace: string, request: SandboxRunRequest): S3MountContext {
    return {
      storage: this.#config.storage,
      namespace: namespace,
      managedBucket: optionalEnv("FILESYSTEM_BUCKET_NAME"),
      region: optionalEnv("AWS_REGION") ?? optionalEnv("AWS_DEFAULT_REGION"),
      attribution: mountAttribution(this.#config, request),
    };
  }

  // Fail closed without the egress connector: the service default is open internet. Connectors
  // are fixed at RunMicrovm, so a reserved VM takes SHELL_INGRESS up front for the terminal.
  #networkConnectors(
    persistent: boolean,
  ): Pick<
    RunMicrovmRequest,
    "egressNetworkConnectors" | "ingressNetworkConnectors"
  > {
    // AWS rejects ALL_INGRESS beside other connectors; HTTP_INGRESS restores the default path.
    const ingress = persistent
      ? {
          ingressNetworkConnectors: [
            managedIngressConnectorArn("HTTP_INGRESS"),
            managedIngressConnectorArn("SHELL_INGRESS"),
          ],
        }
      : {};
    const network = this.#config.network ?? { mode: "deny-all" as const };
    if (network.mode === "allow-all") return ingress;
    const egress = optionalEnv("MICROVM_EGRESS_NETWORK_CONNECTOR_ARN");
    if (!egress) {
      throw new Error(
        `MicroVM sandbox cannot enforce ${network.mode} egress without MICROVM_EGRESS_NETWORK_CONNECTOR_ARN`,
      );
    }
    if (
      (network.allowDomains?.length ?? 0) > 0 ||
      (network.allowCidrs?.length ?? 0) > 0
    ) {
      throw new Error(
        "MicroVM sandbox cannot enforce network.allowDomains or network.allowCidrs; use deny-all or allow-all",
      );
    }

    return { ...ingress, egressNetworkConnectors: [egress] };
  }

  #execPayload(request: SandboxRunRequest): SandboxExecRequest {
    const home =
      this.#persistent(request) && !request.namespace
        ? this.#workDir(this.#workspaceKey(request))
        : undefined;

    return {
      runtime: request.runtime ?? "bash",
      code: request.code,
      ...(request.namespace
        ? { namespace: microvmLocalNamespace(request.namespace) }
        : {}),
      ...(request.workspaceRoot
        ? { workspace_root: request.workspaceRoot }
        : {}),
      timeout_ms: request.timeoutSeconds * 1000,
      ...(request.args && request.args.length > 0
        ? { args: request.args }
        : {}),
      env: {
        ...this.#sandboxEnvVars(request.envVars, request.principal),
        ...homeEnv(home),
      },
    };
  }

  #sandboxEnvVars(
    requestEnvVars?: Record<string, string>,
    principal?: SandboxRunPrincipal,
  ): Record<string, string> {
    return mergeSandboxEnv(this.#config.envVars, requestEnvVars, principal);
  }

  async #exec(
    microvmId: string,
    endpoint: string,
    payload: SandboxExecRequest,
    budgetMs = WARMUP_BUDGET_MS,
  ): Promise<SandboxExecResponse> {
    const response = await this.#whileWarming(microvmId, budgetMs, () =>
      this.#post(
        { microvmId: microvmId, endpoint: endpoint },
        { path: "/exec", body: payload, timeoutMs: payload.timeout_ms },
        EXEC_RETRY,
        (text): SandboxExecResponse => parseExecResponse(text, "MicroVM exec"),
      ),
    );
    this.#reportBurst(microvmId, response.burst);

    return response;
  }

  async #whileWarming<T>(
    microvmId: string,
    budgetMs: number,
    post: () => Promise<Warming<T>>,
  ): Promise<T> {
    const deadline = Date.now() + budgetMs;
    let wait = WARMUP_RETRY_MIN_DELAY_MS;
    for (;;) {
      const warming = await post();
      if (!warming.retry) return warming.response;
      if (Date.now() >= deadline) {
        throw new MicrovmNotReadyError(
          `MicroVM ${microvmId} did not become ready within ${budgetMs}ms (last status ${warming.status})`,
        );
      }
      await delay(wait);
      wait = Math.min(wait * 2, WARMUP_RETRY_MAX_DELAY_MS);
    }
  }

  // Convex bills only growth, so a resend is harmless; totals below the last mean a fresh VM.
  #reportBurst(microvmId: string, burst: SandboxExecResponse["burst"]): void {
    const accountId = this.#config.controlPlane?.accountId;
    if (!burst || !accountId) return;
    const totals = {
      vcpuSeconds: burst.vcpu_seconds,
      gbSeconds: burst.gb_seconds,
    };
    const last = burstReported.get(microvmId);
    const since =
      last &&
      totals.vcpuSeconds >= last.vcpuSeconds &&
      totals.gbSeconds >= last.gbSeconds
        ? last
        : { vcpuSeconds: 0, gbSeconds: 0 };
    if (
      totals.vcpuSeconds - since.vcpuSeconds < BURST_REPORT_MIN_GROWTH &&
      totals.gbSeconds - since.gbSeconds < BURST_REPORT_MIN_GROWTH
    ) {
      return;
    }
    waitUntil(
      queueMirrorWrite(microvmId, async () => {
        if (!(await recordSandboxBurst(accountId, microvmId, totals))) return;
        const now = Date.now();
        evictToCap(burstReported, now);
        burstReported.set(microvmId, {
          ...totals,
          expiresAt: now + BURST_REPORT_TTL_MS,
        });
      }),
    );
  }

  // A 504 is fatal: the proxy gave up on a guest that may still be running the call.
  async #post<T>(
    target: { microvmId: string; endpoint: string },
    request: SandboxGuestPost,
    retry: GuestRetry,
    parse: (text: string, headers: Headers) => T,
  ): Promise<Warming<T>> {
    const token = await this.#authToken(target.microvmId);
    const deadline = AbortSignal.timeout(request.timeoutMs + EXEC_GRACE_MS);
    let res: Response;
    try {
      res = await fetch(
        `https://${target.endpoint.replace(/^https?:\/\//, "")}${request.path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [MICROVM_SHELL_AUTH_HEADER]: token,
            "X-aws-proxy-port": String(MICROVM_PROXY_PORT),
          },
          body: JSON.stringify(request.body),
          signal: request.abortSignal
            ? AbortSignal.any([deadline, request.abortSignal])
            : deadline,
        },
      );
    } catch (err) {
      if (!retry.fetchError(err)) throw err;

      return {
        retry: true,
        status: err instanceof Error ? err.message : "fetch error",
      };
    }
    if (retry.warmingStatus && (res.status === 502 || res.status === 503)) {
      return { retry: true, status: res.status };
    }
    const text = await boundedText(res, request.path);
    if (!res.ok) {
      throw new Error(
        `MicroVM ${request.path} failed (${res.status}): ${text || res.statusText}`,
      );
    }

    return { retry: false, response: parse(text, res.headers) };
  }

  async #ready(
    target: { microvmId: string; endpoint: string },
    readyBy: number,
    abortSignal?: AbortSignal,
  ): Promise<Warming<void>> {
    const token = await this.#authToken(target.microvmId);
    const deadline = AbortSignal.timeout(Math.max(1, readyBy - Date.now()));
    try {
      const res = await fetch(
        `https://${target.endpoint.replace(/^https?:\/\//, "")}/healthz`,
        {
          headers: {
            [MICROVM_SHELL_AUTH_HEADER]: token,
            "X-aws-proxy-port": String(MICROVM_PROXY_PORT),
          },
          signal: abortSignal
            ? AbortSignal.any([deadline, abortSignal])
            : deadline,
        },
      );
      await res.body?.cancel();

      return res.ok
        ? { retry: false, response: undefined }
        : { retry: true, status: res.status };
    } catch (err) {
      abortSignal?.throwIfAborted();

      return {
        retry: true,
        status: err instanceof Error ? err.message : "fetch error",
      };
    }
  }

  async #authToken(
    microvmId: string,
    port = MICROVM_PROXY_PORT,
  ): Promise<string> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`MicroVM auth token port is invalid: ${port}`);
    }
    // Keyed per port: a token is scoped to the ports it was minted for.
    const cacheKey = `${microvmId}:${port}`;
    const now = Date.now();
    const cached = authTokens.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.token;
    const result = await this.#client.send(
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: microvmId,
        expirationInMinutes: AUTH_TOKEN_TTL_MINUTES,
        allowedPorts: [{ port: port }],
      }),
    );
    const token = result.authToken?.["X-aws-proxy-auth"];
    if (!token)
      throw new Error(
        "CreateMicrovmAuthToken did not return an X-aws-proxy-auth token",
      );
    evictToCap(authTokens, now);
    authTokens.set(cacheKey, {
      token: token,
      expiresAt:
        now + AUTH_TOKEN_TTL_MINUTES * 60_000 - AUTH_TOKEN_REFRESH_MARGIN_MS,
    });

    return token;
  }

  async #shell(
    microvmId: string,
    endpoint: string,
    script: string,
    options: {
      timeoutSeconds?: number;
      budgetMs?: number;
      env?: Record<string, string>;
      home?: string;
    } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const response = await this.#exec(
      microvmId,
      endpoint,
      {
        runtime: "bash",
        code: script,
        timeout_ms: (options.timeoutSeconds ?? 60) * 1000,
        env: {
          ...this.#sandboxEnvVars(),
          ...options.env,
          ...homeEnv(options.home),
        },
      },
      options.budgetMs ?? WARMUP_BUDGET_MS,
    );

    return {
      stdout: response.stdout,
      stderr: response.stderr,
      exitCode: response.exit_code ?? null,
    };
  }

  // A failed `/run` hook leaves a plain local dir whose writes die with the VM. /exec answers
  // before the hook finishes mounting, so poll up to the image's own hook budget.
  async #assertWorkspaceMounted(
    microvmId: string,
    endpoint: string,
    workDir: string,
  ): Promise<void> {
    const deadline = Date.now() + MOUNT_ASSERT_BUDGET_MS;
    let wait = MOUNT_ASSERT_MIN_DELAY_MS;
    for (;;) {
      const result = await this.#shell(
        microvmId,
        endpoint,
        `mountpoint -q ${shellQuote(workDir)}`,
        { timeoutSeconds: 30 },
      );
      if (result.exitCode === 0) return;
      if (Date.now() >= deadline) break;
      await delay(wait);
      wait = Math.min(wait * 2, MOUNT_ASSERT_MAX_DELAY_MS);
    }

    throw new Error(
      `MicroVM workspace mount is not live at ${workDir}; the sandbox would write to local disk instead of S3`,
    );
  }

  #markMountCredentialsFresh(request: SandboxRunRequest): void {
    const key = sandboxReservationKey(request);
    if (key) markMountCredentialsFresh(key);
  }

  async #prepareWorkspaceMount(
    request: SandboxRunRequest,
    acquired: { microvmId: string; endpoint: string; isFirstCreate: boolean },
    workDir: string,
  ): Promise<void> {
    if (!acquired.isFirstCreate || !request.namespace) {
      await this.#refreshMountCredentials(
        request,
        acquired.microvmId,
        acquired.endpoint,
      );

      return;
    }
    this.#markMountCredentialsFresh(request);
    try {
      await this.#assertWorkspaceMounted(
        acquired.microvmId,
        acquired.endpoint,
        workDir,
      );
    } catch (error) {
      // Release it, or every later call reuses a VM writing to local disk.
      await this.release(request).catch(() => {});
      throw error;
    }
  }

  // Best effort: a failed push is retried next call and must never fail the caller's exec.
  async #refreshMountCredentials(
    request: SandboxRunRequest,
    microvmId: string,
    endpoint: string,
  ): Promise<void> {
    if (!request.namespace) return;
    const key = sandboxReservationKey(request);
    if (!key) return;
    const refreshed = mountCredentialRefreshes.get(key);
    if (refreshed && refreshed.expiresAt > Date.now()) return;
    try {
      const mount = await resolveS3Mount(
        this.#s3Context(request.namespace, request),
      );
      if (!mount.credentials) {
        markMountCredentialsFresh(key);

        return;
      }
      const token = await this.#authToken(microvmId);
      const res = await fetch(
        `https://${endpoint.replace(/^https?:\/\//, "")}${MOUNT_CREDENTIALS_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-aws-proxy-auth": token,
            "X-aws-proxy-port": String(MICROVM_PROXY_PORT),
          },
          body: JSON.stringify(mount.credentials),
        },
      );
      // A 404 is an older image with no credential endpoint: nothing to refresh.
      if (res.ok || res.status === 404) {
        markMountCredentialsFresh(key);
      }
    } catch (error) {
      logWarn("failed to refresh MicroVM mount credentials", {
        namespace: request.namespace,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #runLifecycle(
    microvmId: string,
    endpoint: string,
    workDir: string,
    budgetMs = WARMUP_BUDGET_MS,
  ): Promise<void> {
    const script = lifecycleScript(
      workDir,
      this.#config.onCreate,
      this.#config.onResume,
    );
    if (!script) return;
    const result = await this.#shell(microvmId, endpoint, script, {
      timeoutSeconds: this.#config.timeout ?? 120,
      budgetMs: budgetMs,
      home: workDir,
    });
    if (result.exitCode !== null && result.exitCode !== 0) {
      throw new Error(
        result.stderr || result.stdout || "MicroVM lifecycle hook failed",
      );
    }
  }

  async #jobContext(
    request: SandboxJobRequest,
  ): Promise<{ microvmId: string; endpoint: string; jobsDir: string }> {
    const key = sandboxReservationKey(request);
    if (!key)
      throw new Error(
        "job operations require a persistent sandbox reservation key",
      );
    const microvmId = await getSandboxExternalId(PROVIDER, key);
    if (!microvmId) throw new Error("no reserved MicroVM for this workspace");
    const { endpoint } = await this.#reconnect(microvmId);

    return {
      microvmId: microvmId,
      endpoint: endpoint,
      jobsDir: this.#jobsDir(key),
    };
  }

  async #terminate(microvmId: string): Promise<boolean> {
    for (const key of authTokens.keys()) {
      if (key.startsWith(`${microvmId}:`)) authTokens.delete(key);
    }

    return this.#client
      .send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }))
      .then(
        (): boolean => true,
        (error: unknown): boolean => isMicrovmGone(error),
      );
  }

  async #unmirror(microvmId: string): Promise<void> {
    const accountId = this.#config.controlPlane?.accountId;
    if (accountId) await removeSandboxInstance(accountId, microvmId);
  }
}

export async function microvmShellConnection(
  microvmId: string,
  client = new LambdaMicrovms({ region: process.env.AWS_REGION }),
): Promise<{ url: string; authorization: string }> {
  const info = await client.send(
    new GetMicrovmCommand({ microvmIdentifier: microvmId }),
  );
  if (!info.endpoint) throw new Error(`MicroVM ${microvmId} has no endpoint`);
  const result = await client.send(
    new CreateMicrovmShellAuthTokenCommand({
      microvmIdentifier: microvmId,
      expirationInMinutes: SHELL_TOKEN_TTL_MINUTES,
    }),
  );
  const token = result.authToken?.[MICROVM_SHELL_AUTH_HEADER];
  if (!token)
    throw new Error(
      "CreateMicrovmShellAuthToken did not return an X-aws-proxy-auth token",
    );

  return {
    url: `wss://${info.endpoint.replace(/^https?:\/\//, "")}`,
    authorization: token,
  };
}

async function boundedText(res: Response, path: string): Promise<string> {
  const tooLarge = (): Error =>
    new Error(
      `MicroVM ${path} answered more than ${GUEST_RESPONSE_MAX_BYTES} bytes`,
    );
  if (Number(res.headers.get("content-length")) > GUEST_RESPONSE_MAX_BYTES) {
    await res.body?.cancel();
    throw tooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > GUEST_RESPONSE_MAX_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evictToCap<T extends { expiresAt: number }>(
  cache: Map<string, T>,
  now: number,
): void {
  if (cache.size < CACHE_MAX_ENTRIES) return;
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  if (cache.size < CACHE_MAX_ENTRIES) return;
  const oldest = cache.keys().next().value;
  if (oldest) cache.delete(oldest);
}

// HOME and TMPDIR for an exec the guest would otherwise give a throwaway home.
function homeEnv(home: string | undefined): Record<string, string> {
  return home ? { HOME: home, TMPDIR: "/tmp" } : {};
}

function isMicrovmGone(error: unknown): boolean {
  if (error instanceof MicrovmGoneError) return true;
  const name =
    error && typeof error === "object"
      ? (error as { name?: unknown }).name
      : undefined;
  const message = error instanceof Error ? error.message : String(error);

  return (
    name === "ResourceNotFoundException" ||
    /not found|does not exist|not exist/i.test(message)
  );
}

function isTerminalMicrovmState(state: MicrovmState | undefined): boolean {
  return state === "TERMINATED" || state === "TERMINATING";
}

function managedIngressConnectorArn(name: string): string {
  const region = optionalEnv("AWS_REGION") ?? optionalEnv("AWS_DEFAULT_REGION");
  if (!region) throw new Error("MicroVM ingress connectors require AWS_REGION");

  return `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:${name}`;
}

function mapMicrovmState(
  state: MicrovmState | undefined,
): SandboxInstanceInfo["state"] {
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

function markMountCredentialsFresh(key: string): void {
  const now = Date.now();
  evictToCap(mountCredentialRefreshes, now);
  mountCredentialRefreshes.set(key, {
    expiresAt: now + MOUNT_CREDENTIAL_REFRESH_MS,
  });
}

function microvmImageName(arn: string): string {
  return arn.split(":").slice(0, 7).join(":");
}

function microvmImageScope(arn: string): string | undefined {
  const parts = arn.split(":");
  if (parts[0] !== "arn" || parts[2] !== "lambda") return undefined;
  if (parts[5] !== "microvm-image" || parts.length < 7) return undefined;

  return parts.slice(0, 6).join(":");
}

function microvmImageVariant(arn: string, variant: string): string | undefined {
  const scope = microvmImageScope(arn);
  const name = arn.split(":")[6];
  if (!scope || !name) return undefined;

  return `${scope}:${name}-${variant}`;
}

function burstHeader(headers: Headers): SandboxExecResponse["burst"] {
  const header = headers.get("x-sandbox-burst");
  if (!header) return undefined;
  try {
    const totals = burstTotals.safeParse(JSON.parse(header));

    return totals.success ? totals.data : undefined;
  } catch {
    return undefined;
  }
}

function s3Location(
  uri: string | undefined,
): { bucket: string; key: string } | undefined {
  const [, bucket, key] = uri?.match(/^s3:\/\/([^/]+)\/(.+)$/) ?? [];

  return bucket && key ? { bucket: bucket, key: key } : undefined;
}

function microvmLocalNamespace(namespace: string): string {
  return namespace.split("/")[0] ?? namespace;
}
