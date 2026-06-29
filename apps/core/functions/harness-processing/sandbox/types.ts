/**
 * Sandbox execution contracts.
 *
 * The sandbox is a single uniform Linux compute backend (real bash + python3 +
 * node on PATH). All providers expose ONE `run` method that executes a piece of
 * code in an optionally named sandbox. The harness tools
 * (bash/read/write/edit/glob/grep) all compile down to a bash `code` string —
 * per-runtime routing no longer exists.
 */

import type { Readable } from "node:stream";
import type { WorkspaceStorageConfig } from "../../_shared/storage/workspace-config.ts";
import type { SandboxControlPlane, SandboxSize } from "../../_shared/sandbox-sizes.ts";

export type SandboxProvider = "sandbox" | "lambda" | "e2b" | "daytona" | "vercel";
export type SandboxRuntime = "bash" | "python" | "node";
export type SandboxNetworkMode = "allow-all" | "deny-all" | "restricted";

export interface SandboxNetworkConfig {
  mode: SandboxNetworkMode;
  allowDomains?: string[];
  allowCidrs?: string[];
  // Carved out of every allowCidrs block. Lets a policy say "all public internet"
  // by allowing 0.0.0.0/0 minus private ranges.
  denyCidrs?: string[];
}

// Runtime subset of the persisted sandbox config (see storage/sandbox-config.ts)
// that an executor needs. `provider` is required: normalizeSandboxConfig always
// resolves one, so an executor config never carries an undefined provider.
export interface SandboxExecutorConfig {
  provider: SandboxProvider;
  // Predefined compute size; drives workdir create-time resources (see
  // _shared/sandbox-sizes). Advisory on providers that size natively.
  size?: SandboxSize;
  // Prebuilt image/snapshot to launch from (workdir image id/name, MicroVM image
  // ARN). Consumed by the self-hosted backends; unset boots the provider default.
  snapshot?: string;
  runtimes?: SandboxRuntime[];
  network?: SandboxNetworkConfig;
  timeout?: number;
  memoryLimit?: number;
  outputLimitBytes?: number;
  // Reserve a long-lived sandbox instead of create-and-destroy per call.
  // Persistent runs must pass a stable request.reservationKey, or request.namespace
  // for workspace-backed callers. Meaningful for sandbox/lambda/daytona/e2b.
  persistent?: boolean;
  // Idle/expiry policy for a persistent sandbox (Fargate-style scale-to-0).
  lifecycle?: SandboxLifecycle;
  // Persistent sandbox command hooks. onCreate is guarded by a marker for
  // providers without native lifecycle support; onResume runs on acquisition.
  onCreate?: string[];
  onResume?: string[];
  // Account-configured env vars injected into every run. Values may be
  // `undefined` (an unset key); `stringRecord()` filters those at injection.
  envVars?: Record<string, string | undefined>;
  // Provider-specific knobs (function names, templates, kubeconfig, ...).
  options?: Record<string, unknown>;
  // The workspace's storage identity (bucket / region / endpoint / prefix / auth),
  // attached per-workspace by the runtime resolver. Drives the S3 mount target and
  // credentials. Absent for stateless (no-workspace) runs. Storage is a property of
  // the workspace, not the sandbox compute — see _shared/storage/workspace-config.
  storage?: WorkspaceStorageConfig;
  // Account + sandbox identity attached by the runtime resolver so a freshly
  // reserved persistent instance mirrors itself into the Convex registry. Absent
  // for synthetic/stateless configs (the mirror then no-ops). See _shared/sandbox-sizes.
  controlPlane?: SandboxControlPlane;
}

export interface SandboxLifecycle {
  // Scale the sandbox down after this many seconds with no activity and no
  // running background job. Maps to the workdir auto_stop, daytona
  // autoStopInterval, and e2b onTimeout pause.
  idleTimeoutSeconds?: number;
  // Hard expiry: delete/stop the sandbox this many seconds after creation
  // regardless of activity. Undefined => no hard expiry.
  maxLifetimeSeconds?: number;
}

export interface SandboxRunRequest {
  // Defaults to "bash". The harness only ever sends "bash"; python/node exist for
  // the lambda API's typed-runtime fidelity.
  runtime?: SandboxRuntime;
  code: string;
  // Workspace filesystem namespace. For workspace-backed runs this selects the
  // working directory and S3 mount prefix.
  namespace?: string;
  // Stable identity for a reserved sandbox. Use this when persistence identity is
  // not a workspace filesystem namespace, e.g. account-uploaded custom tools.
  reservationKey?: string;
  workspaceRoot?: string;
  timeoutSeconds: number;
  outputLimitBytes: number;
  args?: string[];
  // Per-call env vars merged over the account-configured envVars. Reserved runtime
  // vars always win and the host process.env is never inherited.
  envVars?: Record<string, string>;
  // Background-only: the caller supplies the jobId (so the tracking row exists
  // before the job can finish) and an optional completion callback the detached
  // job POSTs when it exits.
  jobId?: string;
  callback?: SandboxJobCallback;
}

// Where a finished background job reports its result. The detached process POSTs
// this URL with the per-job token; the harness settles the tracking row and
// resumes the conversation. See tools/async-status + the /sandbox-jobs route.
export interface SandboxJobCallback {
  url: string;
  token: string;
}

export interface SandboxRunResult {
  ok: boolean;
  runtime: SandboxRuntime;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  truncated?: boolean;
  provider: SandboxProvider;
  /** CPU time consumed by this exec in microseconds. Sourced from the workdir exec
   *  report on sandbox and from the lambda-sandbox image's getrusage report on
   *  lambda. Absent (undefined) for providers that do not report it and on read
   *  failure. */
  cpuUsec?: number;
}

/** One sandbox exec's CPU, tagged by sandbox type and role for usage metering. */
export interface SandboxCpuSample {
  type: SandboxProvider;
  role: "agent" | "tool";
  /** The custom tool that ran, when role is "tool". */
  toolName?: string;
  cpuUsec: number;
}

// A detached, long-running job started inside a persistent sandbox. The work
// outlives the harness request: it runs in the sandbox (workdir sandbox / daytona
// session / e2b background command), not in the Lambda. Identified by `jobId`.
export type SandboxJobState = "running" | "completed" | "failed" | "unknown";

export interface SandboxJobHandle {
  jobId: string;
}

export interface SandboxJobStatus {
  jobId: string;
  state: SandboxJobState;
  exitCode?: number | null;
}

export interface SandboxJobLogs {
  jobId: string;
  logs: string;
  truncated?: boolean;
}

// Job operations address a job by id within a persistent reservation.
export interface SandboxJobRequest {
  jobId: string;
  namespace?: string;
  reservationKey?: string;
  workspaceRoot?: string;
  outputLimitBytes?: number;
}

/** Identifies a reserved sandbox by workspace namespace or explicit reservation key. */
export interface SandboxReservationRef {
  namespace?: string;
  reservationKey?: string;
}

/** Result of capturing a sandbox snapshot/image (workdir snapshot or MicroVM image). */
export interface SandboxSnapshotResult {
  snapshotId: string;
  // Provider-side image id/ARN, when distinct from snapshotId.
  externalImageId?: string;
}

/** Live instance info surfaced for control-plane sync (Convex sandboxInstances). */
export interface SandboxInstanceInfo {
  externalId: string;
  state: "running" | "suspended" | "terminating" | "error" | "unknown";
}

export interface SandboxExecutor {
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
  // Best-effort: create/resume the reserved sandbox and wait until its pod is
  // Ready, ahead of the first real call, to hide cold-start. No-op for
  // non-persistent configs. Callers feature-detect and fire-and-forget.
  prewarm?(request: { namespace?: string; reservationKey?: string }): Promise<void>;
  // Low-level exec in the reserved pod with optional stdin streaming. Unlike
  // `run` it does not cd into a workspace or wrap output — used to talk to the
  // resident in-pod tool worker. Persistent-only; absent for non-pod providers.
  execInReservedPod?(
    request: { namespace?: string; reservationKey?: string },
    command: string[],
    // onStdout receives each stdout chunk as it arrives (used to stream a custom
    // tool's NDJSON frames live). The returned stdout still holds the full output.
    opts?: { stdin?: Readable; timeoutSeconds?: number; outputLimitBytes?: number; onStdout?: (chunk: string) => void },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean; cpuUsec?: number }>;
  // Persistent-only background capabilities. Implemented by sandbox/daytona/
  // e2b when config.persistent is true; absent otherwise (callers feature-detect).
  runBackground?(request: SandboxRunRequest): Promise<SandboxJobHandle>;
  jobStatus?(request: SandboxJobRequest): Promise<SandboxJobStatus>;
  jobLogs?(request: SandboxJobRequest): Promise<SandboxJobLogs>;
  stopJob?(request: SandboxJobRequest): Promise<SandboxJobStatus>;
  // Tear down the reserved sandbox for a reservation and its durable storage
  // (workdir/daytona/e2b sandbox) plus its instance record.
  // Best-effort + idempotent: a missing sandbox is a no-op. Called on
  // account/workspace deletion to prevent leaked compute/disk.
  release?(request: { namespace?: string; reservationKey?: string }): Promise<void>;
  // --- Snapshot/standby lifecycle (workdir + lambda-microvm). All optional; callers
  // feature-detect. Drives control-plane sync + dashboard suspend/resume/snapshot. ---
  // Suspend a reserved sandbox, preserving disk+memory while freeing compute.
  suspend?(request: SandboxReservationRef): Promise<void>;
  // Resume a suspended sandbox.
  resume?(request: SandboxReservationRef): Promise<void>;
  // Capture the current sandbox state as a reusable snapshot/image.
  snapshot?(request: SandboxReservationRef): Promise<SandboxSnapshotResult>;
  // Best-effort live instance info (external id + state) for control-plane sync.
  getInstanceInfo?(request: SandboxReservationRef): Promise<SandboxInstanceInfo | null>;
}
