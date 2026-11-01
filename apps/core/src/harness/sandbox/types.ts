import type { Readable } from "node:stream";
import type { SandboxImage } from "@broods/convex/model/sandboxRules";
import type {
  SandboxNetworkMode,
  SandboxProvider,
  SandboxRuntimeName as SandboxRuntime,
} from "../../shared/domain/sandbox-config.ts";
import type { WorkspaceStorageConfig } from "../../shared/domain/workspace-config.ts";
import type {
  SandboxControlPlane,
  SandboxRunMetadata,
  SandboxSize,
} from "../../shared/sandbox-sizes.ts";

export type {
  SandboxNetworkMode,
  SandboxProvider,
  SandboxRuntimeName as SandboxRuntime,
} from "../../shared/domain/sandbox-config.ts";

export interface SandboxNetworkConfig {
  mode: SandboxNetworkMode;
  allowDomains?: string[];
  allowCidrs?: string[];
  denyCidrs?: string[];
}

export interface SandboxExecutorConfig {
  provider: SandboxProvider;
  // Takes an ephemeral run `provider` refuses for capacity; never valid beside `persistent`.
  fallbackProvider?: SandboxProvider;
  size?: SandboxSize;
  image?: SandboxImage;
  snapshot?: string;
  runtimes?: SandboxRuntime[];
  network?: SandboxNetworkConfig;
  timeout?: number;
  outputLimitBytes?: number;
  persistent?: boolean;
  lifecycle?: SandboxLifecycle;
  onCreate?: string[];
  onResume?: string[];
  envVars?: Record<string, string | undefined>;
  options?: Record<string, unknown>;
  storage?: WorkspaceStorageConfig;
  controlPlane?: SandboxControlPlane;
}

export interface SandboxLifecycle {
  idleTimeoutSeconds?: number;
  maxLifetimeSeconds?: number;
}

export interface SandboxRunRequest {
  runtime?: SandboxRuntime;
  code: string;
  namespace?: string;
  reservationKey?: string;
  workspaceRoot?: string;
  timeoutSeconds: number;
  outputLimitBytes: number;
  args?: string[];
  // Never inherits the host env; `mergeSandboxEnv` drops RESERVED_SANDBOX_ENV_KEYS.
  envVars?: Record<string, string>;
  // Blocking execs only: a background job outlives the run and its token.
  principal?: SandboxRunPrincipal;
  metadata?: SandboxRunMetadata;
  // Caller-chosen, so the tracking row exists before the background job can finish.
  jobId?: string;
  callback?: SandboxJobCallback;
}

export interface SandboxRunPrincipal {
  accountId: string;
  agentId: string;
  runToken: string;
  baseUrl?: string;
}

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
  cpuUsec?: number;
}

// The hosted-MCP Lambda; metering it as "lambda" would bill it to the agent's sandbox.
export type ToolComputeProvider = "mcp-sandbox";

export interface SandboxCpuSample {
  type: SandboxProvider | ToolComputeProvider;
  role: "agent" | "tool";
  toolName?: string;
  toolCallId?: string;
  cpuUsec: number;
}

export type SandboxJobState = "running" | "completed" | "failed" | "unknown";

export interface SandboxJobHandle {
  jobId: string;
  externalId: string;
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

export interface SandboxJobRequest {
  jobId: string;
  namespace?: string;
  reservationKey?: string;
  workspaceRoot?: string;
  outputLimitBytes?: number;
}

export interface SandboxReservationRef {
  namespace?: string;
  reservationKey?: string;
}

// Provider ids are never reused, so `externalId` fences every write to the reservation row.
export interface ReservedSandbox {
  provider: SandboxProvider;
  reservationKey: string;
  externalId: string;
  ttlSeconds?: number;
}

export interface SandboxReleaseTarget {
  externalId: string | null;
  instance: { ownCredentials: boolean; sandboxConfigId?: string } | null;
}

export interface SandboxReleaseRequest extends SandboxReservationRef {
  expectedExternalId?: string;
}

export type SandboxSnapshotBuildState = "building" | "active" | "build_failed";

export interface SandboxSnapshotResult {
  snapshotId: string;
  externalImageId?: string;
  status?: SandboxSnapshotBuildState;
}

export interface SandboxInstanceInfo {
  externalId: string;
  state: "running" | "suspended" | "terminating" | "error" | "unknown";
  errorMessage?: string;
}

export interface SandboxGuestPost {
  path: string;
  body: unknown;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

export type SandboxReservedTarget = Pick<
  SandboxRunRequest,
  "namespace" | "reservationKey" | "workspaceRoot"
>;

export interface SandboxReservedPost
  extends SandboxGuestPost, SandboxReservedTarget {}

export interface SandboxExecutor {
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
  prewarm?(request: {
    namespace?: string;
    reservationKey?: string;
  }): Promise<void>;
  execInReservedPod?(
    request: { namespace?: string; reservationKey?: string },
    command: string[],
    opts?: {
      stdin?: Readable;
      timeoutSeconds?: number;
      outputLimitBytes?: number;
      onStdout?: (chunk: string) => void;
    },
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut?: boolean;
    cpuUsec?: number;
  }>;
  runBackground?(request: SandboxRunRequest): Promise<SandboxJobHandle>;
  postReserved?(request: SandboxReservedPost): Promise<unknown>;
  jobStatus?(request: SandboxJobRequest): Promise<SandboxJobStatus>;
  jobLogs?(request: SandboxJobRequest): Promise<SandboxJobLogs>;
  stopJob?(request: SandboxJobRequest): Promise<SandboxJobStatus>;
  // Idempotent. With `expectedExternalId` the row drops only while it still names that
  // machine, so a key re-claimed meanwhile keeps its replacement.
  release?(request: SandboxReleaseRequest): Promise<void>;
  suspend?(request: SandboxReservationRef): Promise<void>;
  resume?(request: SandboxReservationRef): Promise<void>;
  snapshot?(request: SandboxReservationRef): Promise<SandboxSnapshotResult>;
  snapshotStatus?(externalImageId: string): Promise<SandboxSnapshotBuildState>;
  getInstanceInfo?(
    request: SandboxReservationRef,
  ): Promise<SandboxInstanceInfo | null>;
}
