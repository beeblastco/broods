import type {
  RuntimeName,
  SandboxConfig,
} from "@broods/convex/model/sandboxRules";

export type {
  NetworkMode as SandboxNetworkMode,
  PermissionMode as SandboxPermissionMode,
  RuntimeName as SandboxRuntimeName,
  SandboxConfig,
  SandboxProvider,
} from "@broods/convex/model/sandboxRules";

export interface SandboxConfigRecord {
  accountId: string;
  sandboxId: string;
  projectId?: string;
  stageId?: string;
  name: string;
  description?: string;
  config: SandboxConfig;
  createdAt: string;
  updatedAt: string;
}

// POSTed as JSON to `<endpoint>/exec` (lambda image, `custom` servers); the SDK publishes it.
// snake_case on purpose: the image shipped it first.
export interface SandboxExecRequest {
  runtime: RuntimeName;
  code: string;
  /** Selects the working directory; absent for a stateless run. */
  namespace?: string;
  workspace_root?: string;
  timeout_ms: number;
  args?: string[];
  env: Record<string, string>;
}

/** HTTP 200 even when the code failed. */
export interface SandboxExecResponse {
  ok: boolean;
  runtime?: string;
  /** Null when the process was killed by the timeout. */
  exit_code?: number | null;
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
  truncated?: boolean;
  cpu_usec?: number;
  /** MicroVM only: vCPU-s and GB-s above the machine's baseline since boot. */
  burst?: { vcpu_seconds: number; gb_seconds: number };
}

// Required, so a field added to the response fails the Worker's own `check`.
export type SandboxExecAnswer = Required<
  Omit<SandboxExecResponse, "burst" | "cpu_usec" | "runtime">
>;
