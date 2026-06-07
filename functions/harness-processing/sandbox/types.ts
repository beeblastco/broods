/**
 * Sandbox execution contracts.
 *
 * The sandbox is a single uniform Linux compute backend (real bash + python3 +
 * node on PATH). All providers expose ONE `run` method that executes a piece of
 * code in an optionally named sandbox. The harness tools
 * (bash/read/write/edit/glob/grep) all compile down to a bash `code` string —
 * per-runtime routing no longer exists.
 */

export type SandboxProvider = "lambda" | "e2b" | "daytona" | "kubernetes";
export type SandboxRuntime = "bash" | "python" | "node";

// Runtime subset of the persisted sandbox config (see storage/sandbox-config.ts)
// that an executor needs. `internet` selects the lambda internet-on/off function.
export interface SandboxExecutorConfig {
  provider?: SandboxProvider;
  runtimes?: SandboxRuntime[];
  internet?: boolean;
  timeout?: number;
  memoryLimit?: number;
  outputLimitBytes?: number;
  // Reserve a long-lived sandbox instead of create-and-destroy per call.
  // Persistent runs must pass a stable request.reservationKey, or request.namespace
  // for workspace-backed callers. Only meaningful for kubernetes/daytona/e2b.
  persistent?: boolean;
  // Persistent sandboxes normally reserve a durable home PVC so package-manager
  // caches survive scale-to-0. Set true to skip the PVC and use the image's own
  // ephemeral home: the sandbox is still reserved/reused, but provisioning skips
  // the slow cloud-volume create+attach (the dominant cold-start cost). Used by
  // account-uploaded tools, whose results return via HTTP callback and never
  // depend on durable disk.
  ephemeralHome?: boolean;
  // Idle/expiry policy for a persistent sandbox (Fargate-style scale-to-0).
  lifecycle?: SandboxLifecycle;
  // Account-configured env vars injected into every run.
  envVars?: Record<string, string>;
  // Provider-specific knobs (function names, templates, kubeconfig, ...).
  options?: Record<string, unknown>;
}

export interface SandboxLifecycle {
  // Scale the sandbox down after this many seconds with no activity and no
  // running background job. Maps to the k8s reaper cooldown, daytona
  // autoStopInterval, and e2b onTimeout pause.
  idleTimeoutSeconds?: number;
  // Hard expiry: delete/stop the sandbox this many seconds after creation
  // regardless of activity (k8s shutdownTime). Undefined => no hard expiry.
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
}

// A detached, long-running job started inside a persistent sandbox. The work
// outlives the harness request: it runs in the sandbox (k8s pod / daytona
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

export interface SandboxExecutor {
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
  // Persistent-only background capabilities. Implemented by kubernetes/daytona/
  // e2b when config.persistent is true; absent otherwise (callers feature-detect).
  runBackground?(request: SandboxRunRequest): Promise<SandboxJobHandle>;
  jobStatus?(request: SandboxJobRequest): Promise<SandboxJobStatus>;
  jobLogs?(request: SandboxJobRequest): Promise<SandboxJobLogs>;
  stopJob?(request: SandboxJobRequest): Promise<SandboxJobStatus>;
  // Tear down the reserved sandbox for a reservation and its durable storage
  // (k8s Sandbox + PVC, daytona/e2b sandbox) plus its instance record.
  // Best-effort + idempotent: a missing sandbox is a no-op. Called on
  // account/workspace deletion to prevent leaked compute/disk.
  release?(request: { namespace?: string; reservationKey?: string }): Promise<void>;
}
