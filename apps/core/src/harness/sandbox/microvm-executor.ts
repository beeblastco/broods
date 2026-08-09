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
import {
  removeSandboxInstance,
  upsertSandboxInstance,
} from "../../shared/convex/sandbox-instances.ts";
import { optionalEnv } from "../../shared/env.ts";
import { logWarn } from "../../shared/log.ts";
import { isPlainObject } from "../../shared/object.ts";
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
  generateJobId,
  launchScript,
  lifecycleScript,
  logsScript,
  parseJobStatus,
  statusScript,
  stopScript,
} from "./jobs.ts";
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
import {
  configString,
  sandboxReservationKey,
  shellQuote,
  stringRecord,
  stripTrailingSlashes,
  truncateText,
} from "./utils.ts";

// The image serves the exec API on this port; the proxy maps external 443 -> 8080.
const MICROVM_PROXY_PORT = 8080;
// Auth tokens are short-lived (well under the 60-min cap) so a leaked one expires
// fast, and reused until close to expiry so a warm exec costs no control-plane call.
const AUTH_TOKEN_TTL_MINUTES = 15;
const AUTH_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
// A freshly run MicroVM restores its snapshot in ~1–10s; the proxy returns 502/503
// while it warms. Retry the first exec within this budget before giving up, polling
// fast at first (a resumed VM is usually ready in well under a second) then backing
// off — a flat delay put its whole value on the floor of every single call.
const WARMUP_BUDGET_MS = 30_000;
const WARMUP_RETRY_MIN_DELAY_MS = 150;
const WARMUP_RETRY_MAX_DELAY_MS = 750;
// A cached endpoint is a guess, so it gets a short warm-up before the call falls back
// to the authoritative reservation instead of spending the full budget on a dead VM. A
// warm VM answers in well under this; anything slower is a restore the authoritative
// path handles with the full budget, or a VM that is gone.
const CACHED_WARMUP_BUDGET_MS = 1_200;
// A reserved VM's endpoint is stable for the life of its microvmId and survives
// suspend (the proxy auto-resumes on ingress), so the reservation lookup + GetMicrovm
// pair is pure overhead on a repeat call. The TTL bounds how long a reservation that
// moved on another pod can go unnoticed here; a stale entry costs one failed POST and
// CACHED_WARMUP_BUDGET_MS before the authoritative path takes over.
const RESERVED_ENDPOINT_TTL_MS = 3 * 60_000;
const CACHE_MAX_ENTRIES = 512;
// MicroVMs live at most 8h; we still bound each instance with a maximumDuration as
// a backstop (ephemeral VMs are terminated in `finally` long before this).
const MAX_MICROVM_DURATION_SECONDS = 28_800;
const DEFAULT_WORKSPACE_ROOT = "/mnt/workspaces";

const PROVIDER = "lambda" as const;

// A reservation whose VM cannot be reconnected because it reached a terminal state.
// GetMicrovm still answers for a TERMINATED VM, so this is the only signal that
// separates "recreate it" from a transient control-plane failure.
class MicrovmGoneError extends Error {}

// The sandbox serves these to mountpoint-s3, which re-fetches as its session ages.
// Sessions last an hour and a persistent VM outlives that, so refresh on this
// interval — comfortably inside the hour, and cheap (one STS call per VM per cycle).
const MOUNT_CREDENTIAL_REFRESH_MS = 30 * 60_000;
const MOUNT_CREDENTIALS_PATH = "/workspace/credentials";

// The `/run` hook's own budget in the published image. A mount still missing after
// this is one the hook has already given up on, not one still being established.
const MOUNT_ASSERT_BUDGET_MS = 30_000;
const MOUNT_ASSERT_MIN_DELAY_MS = 250;
const MOUNT_ASSERT_MAX_DELAY_MS = 2_000;

// When each reservation's mount credentials next need pushing. Module scope for the
// same reason as the token cache, and capped the same way: a reservation that ends
// without release() would otherwise leave its entry here for the life of the pod.
const mountCredentialRefreshes = new Map<string, { expiresAt: number }>();

// Minted tokens are per-MicroVM and valid for AUTH_TOKEN_TTL_MINUTES, so minting one
// per exec burns a control-plane round trip on every call. Cached at module scope
// because an executor is constructed per request, and dropped again on terminate.
const authTokens = new Map<string, { token: string; expiresAt: number }>();

// Reserved endpoints, keyed by reservation key. Same module-scope reasoning as the
// token cache: an executor is constructed per request, so an instance field never hits.
const reservedEndpoints = new Map<
  string,
  { microvmId: string; endpoint: string; expiresAt: number }
>();

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

export interface MicrovmHarnessReservation {
  readonly microvmId: string;
  readonly endpoint: string;
  // True only when this call created the VM, so the caller owns its teardown.
  readonly isFirstCreate: boolean;
}

interface AcquiredMicrovm extends MicrovmHarnessReservation {
  readonly ephemeralMirror?: Promise<void>;
}

// The proxy never accepted the request inside the warm-up budget, so the exec
// definitely did not run. That is the only failure safe to retry against another VM —
// any error raised after a 2xx may have already run the caller's code once.
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

  async acquireHarnessReservation(request: {
    reservationKey: string;
    abortSignal?: AbortSignal;
  }): Promise<MicrovmHarnessReservation> {
    request.abortSignal?.throwIfAborted();
    if (!this.#persistent(request)) {
      throw new Error(
        "Harness sessions require a persistent lambda (MicroVM) reservation key",
      );
    }
    const reservation = await this.#acquire(
      this.#harnessRequest(request.reservationKey),
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
      if (reservation.isFirstCreate) {
        await this.release(request).catch(() => {});
      }
      throw error;
    }
  }

  async resumeHarnessReservation(request: {
    reservationKey: string;
    abortSignal?: AbortSignal;
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
      throw new Error("no reserved MicroVM for this Harness session");
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
    ).catch(() => {});
    request.abortSignal?.throwIfAborted();

    return reservation;
  }

  async runHarnessCommand(request: {
    microvmId: string;
    endpoint: string;
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
      env: this.#sandboxEnvVars(request.env),
    });
    request.abortSignal?.throwIfAborted();

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

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const persistent = this.#persistent(request);
    const payload = this.#execPayload(request);
    // A reserved VM already reached this pod is exec'd straight through its cached
    // endpoint, skipping both the reservation lookup and GetMicrovm. Only `run` takes
    // that shortcut — it is the hot path, and the one with a fallback when the guess
    // turns out to be dead. Ephemeral runs never cache: they have no reservation.
    const cached = persistent ? this.#cachedTarget(request) : null;
    if (cached) {
      await this.#refreshMountCredentials(
        request,
        cached.microvmId,
        cached.endpoint,
      );
      const response = await this.#execReserved(cached, request, payload);
      if (response) return sandboxResult(request, response, startedAt);
    }
    const { microvmId, endpoint, ephemeralMirror, isFirstCreate } =
      await this.#acquire(request);

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
      }

      return sandboxResult(
        request,
        await this.#exec(microvmId, endpoint, payload),
        startedAt,
      );
    } finally {
      // The result is already in hand, so teardown must not be on the caller's clock:
      // fire the terminate and drop the VM's dashboard row without awaiting either.
      if (!persistent) {
        void this.#terminate(microvmId);
        // Preserve upsert → remove ordering without putting either Convex write on
        // the tool-call clock; otherwise a slow upsert can recreate a deleted row.
        void ephemeralMirror?.then(() => this.#unmirror(microvmId));
      }
    }
  }

  // Detached background work survives the harness request because a persistent
  // MicroVM is not terminated after the call. The job is launched as a setsid
  // session that POSTs its result to the completion callback when it exits; it is
  // snapshotted/restored with the VM across suspend/resume (same boot id).
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
    const result = await this.#shell(microvmId, endpoint, script, 30);
    if (result.exitCode !== null && result.exitCode !== 0) {
      throw new Error(
        result.stderr || result.stdout || "failed to launch background job",
      );
    }

    return { jobId: jobId };
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
    // Report the real terminal state: a job that had already finished keeps its
    // own exit code instead of being recorded as killed.
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

      return { externalId: microvmId, state: "unknown" };
    }
  }

  async release(request: SandboxReservationRef): Promise<void> {
    const key = sandboxReservationKey(request);
    if (!key) return;
    reservedEndpoints.delete(key);
    mountCredentialRefreshes.delete(key);
    const microvmId = await getSandboxExternalId(PROVIDER, key);
    if (microvmId) await this.#terminate(microvmId);
    await deleteSandboxInstance(
      PROVIDER,
      key,
      this.#config.controlPlane?.accountId,
    ).catch(() => {});
  }

  #optionOrEnv(option: string, env: string): string | undefined {
    const options = isPlainObject(this.#config.options)
      ? this.#config.options
      : {};

    return configString(options[option]) ?? optionalEnv(env);
  }

  #requireImageIdentifier(): string {
    // The first-class `snapshot` pin (per-config image ARN) wins, then the
    // `options.imageIdentifier` alias, then the harness-wide env default.
    const identifier =
      configString(this.#config.snapshot) ??
      this.#optionOrEnv("imageIdentifier", "MICROVM_IMAGE_IDENTIFIER");
    if (!identifier) {
      throw new Error(
        "MicroVM sandbox requires a config `snapshot` image ARN or MICROVM_IMAGE_IDENTIFIER in the harness runtime.",
      );
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

  #harnessRequest(reservationKey: string): SandboxRunRequest {
    return {
      code: "true",
      reservationKey: reservationKey,
      timeoutSeconds: this.#config.timeout ?? 120,
      outputLimitBytes: this.#config.outputLimitBytes ?? 64 * 1024,
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

  // Job markers live beside the workspace mount (not under the S3 mount) so the tiny
  // files stay on the VM's native disk and ride suspend/resume with the same VM.
  #jobsDir(key: string): string {
    return `${this.#workspaceRoot()}/.fp-jobs/${key}`;
  }

  #cachedTarget(
    request: SandboxReservationRef,
  ): { microvmId: string; endpoint: string } | null {
    const key = sandboxReservationKey(request);
    const cached = key ? reservedEndpoints.get(key) : undefined;
    if (!cached || cached.expiresAt <= Date.now()) return null;

    return { microvmId: cached.microvmId, endpoint: cached.endpoint };
  }

  // Acquire a MicroVM endpoint: a fresh ephemeral VM for stateless runs, or the
  // reserved VM (resumed if suspended) for a persistent reservation.
  async #acquire(request: SandboxRunRequest): Promise<AcquiredMicrovm> {
    if (!this.#persistent(request)) {
      const created = await this.#runMicrovm(request);
      // An ephemeral VM is still real, chargeable compute for the length of the call,
      // so it shows in the dashboard too — keyed by microvmId (it has no reservation)
      // and dropped again by run()'s teardown.
      const ephemeralMirror = upsertSandboxInstance(
        this.#config.controlPlane,
        PROVIDER,
        created.microvmId,
        created.microvmId,
        request.metadata,
        { ephemeral: true },
      );

      return {
        ...created,
        ephemeralMirror: ephemeralMirror,
        isFirstCreate: true,
      };
    }
    const key = sandboxReservationKey(request)!;
    const existing = await getSandboxExternalId(PROVIDER, key);
    if (existing) {
      try {
        const reconnected = await this.#reconnect(existing);
        // Reservation refresh and dashboard mirror are both recoverable on the next
        // call, so they never hold up an exec that already has its endpoint.
        void saveSandboxInstance(
          PROVIDER,
          key,
          existing,
          this.#config.controlPlane?.accountId,
        ).catch(() => {});
        void upsertSandboxInstance(
          this.#config.controlPlane,
          PROVIDER,
          key,
          existing,
          request.metadata,
        );

        return {
          ...this.#cacheTarget(key, reconnected),
          isFirstCreate: false,
        };
      } catch (error) {
        // Recreate only when the VM is unusable for good — unknown to the provider,
        // or terminal. A slow resume or transient control-plane error must propagate
        // instead: replacing a still-allocated (e.g. suspended) VM leaks it and burns
        // the account's MicroVM memory quota until nothing can launch.
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
        )
      ) {
        void upsertSandboxInstance(
          this.#config.controlPlane,
          PROVIDER,
          key,
          created.microvmId,
          request.metadata,
        );

        return { ...this.#cacheTarget(key, created), isFirstCreate: true };
      }
    } catch (error) {
      // The claim may already have committed even when its caller rejects. Tear down
      // both sides conditionally so a failed acquisition cannot leak the new VM or
      // erase a concurrent winner's reservation.
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
    // Lost a concurrent create race: discard our duplicate and reconnect to the winner.
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
    reservedEndpoints.set(key, {
      ...target,
      expiresAt: now + RESERVED_ENDPOINT_TTL_MS,
    });

    return target;
  }

  // Fetch a reserved VM's endpoint, resuming it first if it idled into SUSPENDED.
  // The resume is deliberately not polled to RUNNING: the endpoint survives suspend
  // and #exec already retries the proxy's 502/503/504 while the snapshot restores, so
  // waiting here only added a fixed delay to every warm call. A record with no
  // endpoint is the one case with nothing to POST to, so that alone still waits.
  async #reconnect(
    microvmId: string,
  ): Promise<{ microvmId: string; endpoint: string }> {
    let info = await this.#client.send(
      new GetMicrovmCommand({ microvmIdentifier: microvmId }),
    );
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
    // A terminal VM is not coming back, and GetMicrovm still answers for one, so the
    // caller has to be told to recreate rather than retry this id forever. Checked
    // after the resume too: a VM can reach a terminal state while we wait on it.
    if (isTerminalMicrovmState(info.state)) {
      throw new MicrovmGoneError(`MicroVM ${microvmId} is ${info.state}`);
    }
    if (!info.endpoint) throw new Error(`MicroVM ${microvmId} has no endpoint`);

    return { microvmId: microvmId, endpoint: info.endpoint };
  }

  // Exec against a cached reservation endpoint. Returns null when that VM never
  // accepted the request — it was terminated, or the reservation moved to another VM
  // — so the caller re-acquires from the authoritative record. Any other failure
  // propagates: past the proxy, the caller's code may already have run.
  async #execReserved(
    target: { microvmId: string; endpoint: string },
    request: SandboxRunRequest,
    payload: object,
  ): Promise<SandboxResponse | null> {
    // The reservation's own record has a 30-day TTL, so skipping its refresh costs
    // nothing — but the dashboard row carries lastUsedAt and the trace link, so it
    // still mirrors every call. Fire-and-forget, like the acquire path.
    void upsertSandboxInstance(
      this.#config.controlPlane,
      PROVIDER,
      sandboxReservationKey(request) ?? target.microvmId,
      target.microvmId,
      request.metadata,
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
  ): Promise<{ microvmId: string; endpoint: string }> {
    const result = await this.#client.send(
      new RunMicrovmCommand(await this.#runInput(request)),
    );
    if (!result.microvmId || !result.endpoint) {
      throw new Error("RunMicrovm did not return a microvmId and endpoint");
    }

    return { microvmId: result.microvmId, endpoint: result.endpoint };
  }

  async #runInput(request: SandboxRunRequest): Promise<RunMicrovmRequest> {
    const imageIdentifier = this.#requireImageIdentifier();
    const imageVersion = this.#optionOrEnv(
      "imageVersion",
      "MICROVM_IMAGE_VERSION",
    );
    const executionRoleArn = this.#optionOrEnv(
      "executionRoleArn",
      "MICROVM_EXECUTION_ROLE_ARN",
    );
    const logGroup = this.#optionOrEnv("logGroup", "MICROVM_LOG_GROUP_NAME");
    const persistent = this.#persistent(request);
    const lifecycle = resolveSandboxLifecycle(this.#config.lifecycle);
    const runHookPayload = await this.#runHookPayload(request);

    return {
      imageIdentifier: imageIdentifier,
      ...(imageVersion ? { imageVersion: imageVersion } : {}),
      ...(executionRoleArn ? { executionRoleArn: executionRoleArn } : {}),
      ...(logGroup ? { logging: { cloudWatch: { logGroup: logGroup } } } : {}),
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

  // Per-VM init delivered to the image's /run hook. Carries the workspace mount
  // (namespace + scoped, short-lived assume-role creds) so the VM mounts S3 itself.
  // Absent for stateless (no-workspace) runs.
  async #runHookPayload(
    request: SandboxRunRequest,
  ): Promise<string | undefined> {
    if (!request.namespace) return undefined;
    const mount = await resolveS3Mount(this.#s3Context(request.namespace));
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

  #s3Context(namespace: string): S3MountContext {
    return {
      storage: this.#config.storage,
      namespace: namespace,
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
  #networkConnectors(
    persistent: boolean,
  ): Pick<
    RunMicrovmRequest,
    "egressNetworkConnectors" | "ingressNetworkConnectors"
  > {
    // ALL_INGRESS cannot be combined with other ingress connectors (AWS rejects
    // it); HTTP_INGRESS + SHELL_INGRESS restore the default HTTP path and add
    // the shell endpoint.
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
    // The connector's security group is fixed at deploy time, so a per-account allowlist
    // cannot be applied to it. Both restricted modes get the same workspace-S3-only egress.
    if (
      (network.allowDomains?.length ?? 0) > 0 ||
      (network.allowCidrs?.length ?? 0) > 0
    ) {
      logWarn(
        "MicroVM sandbox ignores restricted network allowlists; egress is the shared connector (workspace S3 only)",
        {
          allowCidrs: network.allowCidrs?.length ?? 0,
          allowDomains: network.allowDomains?.length ?? 0,
        },
      );
    }

    return { ...ingress, egressNetworkConnectors: [egress] };
  }

  // The exec request body, wire-compatible with the image's existing JSON contract.
  #execPayload(request: SandboxRunRequest): Record<string, unknown> {
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
      env: this.#sandboxEnvVars(request.envVars),
    };
  }

  #sandboxEnvVars(
    requestEnvVars?: Record<string, string>,
  ): Record<string, string> {
    return { ...stringRecord(this.#config.envVars), ...(requestEnvVars ?? {}) };
  }

  // POST the exec request to the VM endpoint, retrying while the snapshot warms.
  async #exec(
    microvmId: string,
    endpoint: string,
    payload: object,
    budgetMs = WARMUP_BUDGET_MS,
  ): Promise<SandboxResponse> {
    const token = await this.#authToken(microvmId);
    const url = `https://${endpoint.replace(/^https?:\/\//, "")}/exec`;
    const deadline = Date.now() + budgetMs;
    let wait = WARMUP_RETRY_MIN_DELAY_MS;
    for (;;) {
      const warming = await this.#postExec(url, token, payload);
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

  async #postExec(
    url: string,
    token: string,
    payload: object,
  ): Promise<
    | { retry: true; status: number | string }
    | { retry: false; response: SandboxResponse }
  > {
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
      return {
        retry: true,
        status: err instanceof Error ? err.message : "fetch error",
      };
    }
    // 502/503/504 from the proxy mean "warming"; the image itself answers request-
    // level errors with HTTP 200 + an ok:false body, so any other non-2xx is fatal.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return { retry: true, status: res.status };
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `MicroVM exec failed (${res.status}): ${text || res.statusText}`,
      );
    }
    if (!text) throw new Error("MicroVM exec returned an empty response");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("MicroVM exec response must be an object");
    }

    return { retry: false, response: parsed as SandboxResponse };
  }

  async #authToken(
    microvmId: string,
    port = MICROVM_PROXY_PORT,
  ): Promise<string> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`MicroVM auth token port is invalid: ${port}`);
    }
    // Cached per (VM, port): a token is scoped to the ports it was minted for, so the
    // bridge port must never be handed the proxy port's token.
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

  // Run a control/lifecycle bash script in the VM and return its stdout + exit code.
  // Used for onCreate/onResume hooks and background-job marker scripts (no workspace
  // cwd — the scripts use absolute paths).
  async #shell(
    microvmId: string,
    endpoint: string,
    script: string,
    timeoutSeconds = 60,
    budgetMs = WARMUP_BUDGET_MS,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const response = await this.#exec(
      microvmId,
      endpoint,
      {
        runtime: "bash",
        code: script,
        timeout_ms: timeoutSeconds * 1000,
        env: this.#sandboxEnvVars(),
      },
      budgetMs,
    );

    return {
      stdout: response.stdout,
      stderr: response.stderr,
      exitCode: response.exit_code ?? null,
    };
  }

  // Refuse to hand back a workspace VM whose S3 mount never came up. The `/run` hook
  // establishes it, but a hook failure leaves the mount point as a plain directory on
  // the VM's own disk — writes look fine and are lost when the VM goes. Only on the
  // create that runs the hook, so the warm path never pays for it.
  //
  // The VM answers /exec as soon as it boots, which is before `/run` has finished
  // mounting, so a single immediate check reports every healthy workspace as broken.
  // Poll instead, up to the hook's own timeout — past that the hook itself has given
  // up and the mount is never coming.
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
        30,
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

  // Everything a persistent workspace VM owes the caller before any work lands on
  // it: a mount proven live on the create that established it, and fresh scoped
  // credentials on every later acquire. Both entry points go through here — a
  // background job on a degraded mount writes to local disk just as silently.
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
    // The `/run` payload just delivered fresh credentials, so the endpoint is
    // already stocked — start the refresh clock instead of pushing again.
    this.#markMountCredentialsFresh(request);
    try {
      await this.#assertWorkspaceMounted(
        acquired.microvmId,
        acquired.endpoint,
        workDir,
      );
    } catch (error) {
      // The VM is already claimed and cached by now, and the assertion only runs on
      // a create — so leaving it reserved would hand every later call a VM writing
      // to local disk, exactly the failure this check exists to catch. Drop the
      // reservation so the next call builds a fresh one.
      await this.release(request).catch(() => {});
      throw error;
    }
  }

  // Keep the sandbox's credential endpoint stocked so its mount survives past the
  // one-hour STS session the `/run` payload was minted with. Best-effort: a failed
  // push is retried on the next call, well inside the session's remaining life, and
  // must never fail the exec the caller is actually waiting on.
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
      const mount = await resolveS3Mount(this.#s3Context(request.namespace));
      // No credentials means no mount role, so there is nothing to rotate — start
      // the clock anyway instead of re-resolving the mount on every single exec.
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
      // A 404 is an older image with no credential endpoint: it mounted with static
      // keys and there is nothing to refresh, so stop asking on every call.
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

  // onCreate (once, marker-guarded) / onResume (every acquire) hooks in the reserved
  // VM, mirroring the daytona/workdir persistent lifecycle.
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
    const result = await this.#shell(
      microvmId,
      endpoint,
      script,
      this.#config.timeout ?? 120,
      budgetMs,
    );
    if (result.exitCode !== null && result.exitCode !== 0) {
      throw new Error(
        result.stderr || result.stdout || "MicroVM lifecycle hook failed",
      );
    }
  }

  // Reconnect to the reserved VM for a background-job control call.
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

    return { microvmId: microvmId, endpoint: endpoint, jobsDir: this.#jobsDir(key) };
  }

  async #terminate(microvmId: string): Promise<void> {
    // Tokens are cached per (VM, port), so drop every port's entry for this VM.
    for (const key of authTokens.keys()) {
      if (key.startsWith(`${microvmId}:`)) authTokens.delete(key);
    }
    await this.#client
      .send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }))
      .catch(() => {});
  }

  // Drop an ephemeral VM's dashboard row; its reservation key is the microvmId.
  async #unmirror(microvmId: string): Promise<void> {
    const accountId = this.#config.controlPlane?.accountId;
    if (accountId) await removeSandboxInstance(accountId, microvmId);
  }
}

// AWS-managed ingress connectors live under a service-owned ARN namespace,
// parameterized only by region and name (HTTP_INGRESS / SHELL_INGRESS / NO_INGRESS).
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

function sandboxResult(
  request: SandboxRunRequest,
  response: SandboxResponse,
  startedAt: number,
): SandboxRunResult {
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
    truncated:
      response.truncated === true || stdout.truncated || stderr.truncated,
    provider: PROVIDER,
    ...(typeof response.cpu_usec === "number" && response.cpu_usec > 0
      ? { cpuUsec: response.cpu_usec }
      : {}),
  };
}

// A run that dies before its teardown leaks one entry per VM, so drop the expired ones
// whenever a cache reaches its cap — and the oldest entry too when they were all still
// live, since the cap has to hold either way.
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

function microvmLocalNamespace(namespace: string): string {
  return namespace.split("/")[0] ?? namespace;
}

function markMountCredentialsFresh(key: string): void {
  const now = Date.now();
  evictToCap(mountCredentialRefreshes, now);
  mountCredentialRefreshes.set(key, {
    expiresAt: now + MOUNT_CREDENTIAL_REFRESH_MS,
  });
}

function isTerminalMicrovmState(state: MicrovmState | undefined): boolean {
  return state === "TERMINATED" || state === "TERMINATING";
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
