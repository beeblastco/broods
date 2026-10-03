/**
 * Sandbox config: account-scoped, reusable sandbox definitions referenced by
 * agents via `config.sandboxes`. A sandbox is a collection of Claude-Code-style
 * tools (bash/read/write/edit/glob/grep) backed by a provider. Stored encrypted
 * at rest because `envVars`/`options` may hold secrets. Validation and the
 * public projection live in packages/convex/model/sandboxRules.ts. The exec
 * wire contract a sandbox server speaks is here too, since the SDK publishes it.
 */

import type {
  RuntimeName,
  SandboxConfig,
} from "@broods/convex/model/sandboxRules";

export type {
  NetworkMode as SandboxNetworkMode,
  PermissionMode as SandboxPermissionMode,
  RuntimeName as SandboxRuntimeName,
  SandboxConfig,
  SandboxLifecycleConfig,
  SandboxNetworkConfig,
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

/**
 * One exec, POSTed as JSON to `<endpoint>/exec`. The `lambda` MicroVM image
 * speaks it and the `custom` provider lets an account point core at its own
 * server that does. snake_case on purpose: the image shipped it first.
 */
export interface SandboxExecRequest {
  /** Which interpreter runs `code`. Core sends `bash`. */
  runtime: RuntimeName;
  code: string;
  /** Workspace namespace; selects the working directory. Absent for a stateless run. */
  namespace?: string;
  /** Root the namespace sits under; the server picks its default when absent. */
  workspace_root?: string;
  /** The server kills the process and answers `timed_out: true` once this passes. */
  timeout_ms: number;
  /** Positional arguments for `code`. */
  args?: string[];
  /** The process environment, set over an empty one or the server's start-up defaults (HOME, TMPDIR, PATH). */
  env: Record<string, string>;
}

/** The JSON answer to one exec; HTTP 200 even when the code failed. */
export interface SandboxExecResponse {
  /** False when the process failed, timed out, or the request was invalid. */
  ok: boolean;
  runtime?: string;
  /** Null when the process was killed by the timeout. */
  exit_code?: number | null;
  timed_out: boolean;
  /** Wall-clock time of the exec. */
  duration_ms: number;
  stdout: string;
  stderr: string;
  /** True when the server already cut stdout or stderr. */
  truncated?: boolean;
  /** CPU time of the exec in microseconds, for usage metering. */
  cpu_usec?: number;
  /** The machine's vCPU-s and GB-s above its baseline since boot. MicroVM only. */
  burst?: { vcpu_seconds: number; gb_seconds: number };
}
